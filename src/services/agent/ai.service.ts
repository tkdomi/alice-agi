import {completion} from '../common/llm.service';
import {stateManager} from './state.service';
import {prompt as environmentPrompt} from '../../prompts/agent/environment';
import {prompt as generalContextPrompt} from '../../prompts/agent/context';
import {prompt as toolsPrompt} from '../../prompts/agent/tools';
import {prompt as memoryPrompt} from '../../prompts/agent/memory';
import {prompt as taskPrompt} from '../../prompts/agent/task';
import {prompt as actionPrompt} from '../../prompts/agent/action';
import {prompt as usePrompt} from '../../prompts/agent/use';
import {CoreMessage} from 'ai';
import {shouldContinueThinking, updateActionState} from './agi.service';
import {taskService} from './task.service';
import {actionService} from './action.service';

import type {Action, AgentThoughts, Task, ToolUsePayload, ToolUseResponse} from '../../types/agent';
import {LangfuseSpanClient, LangfuseTraceClient} from 'langfuse';
import {prompt as fastTrackPrompt} from '../../prompts/agent/fast';
import { linearService } from '../tools/linear.service';
import { calendarService } from './calendar.service';
import { activeToolsMap } from './tool.registration.service';
import { memoryService } from './memory.service';

export const aiService = {

  fastTrack: async (span: LangfuseTraceClient): Promise<boolean> => {
    const messages = stateManager.getState().interaction.messages;
    const last_three_user_messages = messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .slice(-3) as CoreMessage[];

    const fastTrackMessages: CoreMessage[] = [
      {role: 'system', content: fastTrackPrompt(stateManager.getState())},
      ...last_three_user_messages
    ];

    const fastTrackGeneration = span.generation({
      name: 'fast_track',
      input: fastTrackMessages,
      model: stateManager.getState().config.model
    });

    const fastTrack = await completion.object<{result: boolean}>({
      messages: fastTrackMessages,
      model: stateManager.getState().config.model,
      temperature: 0,
      user: { name: stateManager.getState().profile.user_name ?? 'Unknown User', uuid: stateManager.getState().config.conversation_uuid ?? 'unknown-conversation-uuid' }
    });

    fastTrackGeneration.end({output: fastTrack});

    stateManager.updateConfig({fast_track: !fastTrack?.result || false });

    return fastTrack?.result || false;
  },

  think: async (trace: LangfuseTraceClient) => {
    if (!trace) {
      throw new Error('Trace must be provided to think()');
    }

    const observingSpan = trace.span({
      name: 'observing',
      metadata: {
        phase: 'observation_and_drafting',
        ...stateManager.getState().config,
        timestamp: new Date().toISOString()
      }
    });

    await aiService.observe(observingSpan);
    await aiService.draft(observingSpan);

    observingSpan.end();

    while (shouldContinueThinking()) {
      const thinkingSpan = trace.span({
        name: `thinking #${stateManager.getState().config.step}`,
        metadata: {
          phase: 'reasoning_loop',
          ...stateManager.getState().config,
          timestamp: new Date().toISOString()
        }
      });

      await aiService.plan(thinkingSpan);
      await aiService.next(thinkingSpan);

      const state = stateManager.getState();
      if (state.config.current_tool?.name === 'final_answer') break;

      const payload = await aiService.use(thinkingSpan);
      if (payload) {
        await aiService.act(payload, thinkingSpan);
      }

      stateManager.updateConfig({
        step: stateManager.getState().config.step + 1
      });

      thinkingSpan.end();
    }
  },

  observe: async (span: LangfuseSpanClient) => {
    const state = stateManager.getState();
    const user_message = state.interaction.messages.at(-1)?.content ?? 'Hello';

    const environmentMessages: CoreMessage[] = [
      {role: 'system', content: environmentPrompt(state)},
      {role: 'user', content: user_message}
    ];

    const generalContextMessages: CoreMessage[] = [
      {role: 'system', content: generalContextPrompt(state)},
      {role: 'user', content: user_message}
    ];

    const envGeneration = span.generation({
      name: 'environment',
      input: environmentMessages,
      model: state.config.alt_model
    });

    const contextGeneration = span.generation({
      name: 'context',
      input: generalContextMessages,
      model: state.config.alt_model
    });

    const [environmentObservation, generalContextObservation] = await Promise.all([
      completion.object<AgentThoughts['environment']>({
        messages: environmentMessages,
        model: state.config.alt_model ?? state.config.model,
        temperature: 0,
        user: { name: state.profile.user_name ?? 'Unknown User', uuid: state.config.conversation_uuid ?? 'unknown-conversation-uuid' }
      }),
      completion.object<AgentThoughts['context']>({
        messages: generalContextMessages,
        model: state.config.alt_model ?? state.config.model,
        temperature: 0,
        user: { name: state.profile.user_name ?? 'Unknown User', uuid: state.config.conversation_uuid ?? 'unknown-conversation-uuid' }
      })
    ]);

    stateManager.updateThoughts({
      environment: environmentObservation?.result ?? '',
      context: generalContextObservation?.result ?? ''
    });

    await Promise.all([envGeneration.end({output: environmentObservation}), contextGeneration.end({output: generalContextObservation})]);

    return stateManager.getState();
  },

  draft: async (span: LangfuseSpanClient) => {
    const state = stateManager.getState();
    const user_message = state.interaction.messages.at(-1)?.content ?? 'Hello';

    const toolsMessages: CoreMessage[] = [
      {role: 'system', content: toolsPrompt(state)},
      {role: 'user', content: user_message}
    ];

    const memoryMessages: CoreMessage[] = [
      {role: 'system', content: memoryPrompt(state)},
      {role: 'user', content: user_message}
    ];

    const toolsGeneration = span.generation({
      name: 'tools',
      input: toolsMessages,
      model: state.config.alt_model ?? state.config.model
    });

    const memoryGeneration = span.generation({
      name: 'memory',
      input: memoryMessages,
      model: state.config.alt_model ?? state.config.model
    });

    const [toolsObservation, memoryObservation] = await Promise.all([
      completion.object<AgentThoughts['tools']>({
        messages: toolsMessages,
        model: state.config.alt_model ?? state.config.model,
        temperature: 0,
        user: { name: state.profile.user_name ?? 'Unknown User', uuid: state.config.conversation_uuid ?? 'unknown-conversation-uuid' }
      }),
      completion.object<AgentThoughts['memory']>({
        messages: memoryMessages,
        model: state.config.alt_model ?? state.config.model,
        temperature: 0,
        user: { name: state.profile.user_name ?? 'Unknown User', uuid: state.config.conversation_uuid ?? 'unknown-conversation-uuid' }
      })
    ]);

    stateManager.updateThoughts({
      tools: toolsObservation?.result ?? [],
      memory: memoryObservation?.result ?? []
    });

    await Promise.all([toolsGeneration.end({output: toolsObservation}), memoryGeneration.end({output: memoryObservation})]);

    return stateManager.getState();
  },

  plan: async (span: LangfuseSpanClient) => {
    const state = stateManager.getState();

    const user_message = state.interaction.messages.at(-1)?.content ?? 'Hello';

    const taskMessages: CoreMessage[] = [
      {role: 'system', content: taskPrompt(state)},
      {role: 'user', content: user_message}
    ];

    const task_generation = span.generation({
      name: 'task_planning',
      input: taskMessages,
      model: state.config.model,
    });

    const taskPlanning = await completion.object<AgentThoughts['task']>({
      messages: taskMessages,
      model: state.config.model,
      temperature: 0,
      user: { name: state.profile.user_name ?? 'Unknown User', uuid: state.config.conversation_uuid ?? 'unknown-conversation-uuid' }
    });

    const persisted_tasks = await taskService.createTasks(state.config.conversation_uuid!, taskPlanning?.result ?? []);

    stateManager.updateInteraction({
      tasks: persisted_tasks
    });

    await task_generation.end({output: taskPlanning});

    return stateManager.getState();
  },

  next: async (span: LangfuseSpanClient) => {
    const state = stateManager.getState();
    const user_message = state.interaction.messages.at(-1)?.content ?? 'Hello';

    const actionMessages: CoreMessage[] = [
      {role: 'system', content: actionPrompt(state)},
      {role: 'user', content: user_message}
    ];

    const action_generation = span.generation({
      name: 'action_selection',
      input: actionMessages,
      model: state.config.model
    });

    interface CompletionUser {
      uuid: string;
      name: string;
    }

    const currentUser: CompletionUser = {
      name: state.profile.user_name ?? 'Unknown User',
      uuid: state.config.conversation_uuid ?? crypto.randomUUID()
    };

    const actionPlanning = await completion.object<{
      _thinking: string;
      result: {
        name: string;
        tool_name: string;
        task_uuid: string;
      };
    }>({
      messages: actionMessages,
      model: state.config.model,
      temperature: 0,
      user: currentUser
    });

    if (!actionPlanning?.result) {
      await action_generation.end({output: null});
      return;
    }

    const selected_tool = state.session.tools.find(tool => tool.name === actionPlanning.result.tool_name);

    if (!selected_tool) {
      await action_generation.end({output: null});
      return;
    }

    if (!selected_tool.uuid) {
      await action_generation.end({output: null});
      return;
    }

    const action: Action = {
      uuid: crypto.randomUUID(),
      task_uuid: actionPlanning.result.task_uuid,
      tool_uuid: selected_tool.uuid,
      name: actionPlanning.result.name,
      payload: null,
      sequence: state.config.step,
      status: 'pending' as const
    };

    const persisted_action = await actionService.createAction(action);

    const current_task = state.interaction.tasks.find(task => task.uuid === action.task_uuid);
    if (current_task) {
      const updated_tasks = state.interaction.tasks.map(task =>
        task.uuid === current_task.uuid
          ? {
              ...task,
              actions: [...(task.actions || []), mapActionRecordToAction(persisted_action)]
            }
          : task
      );

      stateManager.updateInteraction({tasks: updated_tasks});
    }

    await stateManager.updateConfig({
      current_action: {uuid: action.uuid, name: action.name},
      current_tool: {uuid: selected_tool.uuid, name: selected_tool.name},
      current_task: current_task
        ? {
            uuid: current_task.uuid,
            name: current_task.name
          }
        : undefined
    });

    const updatedState = stateManager.getState();

    await action_generation.end({output: actionPlanning});

    return action;
  },

  use: async (span: LangfuseSpanClient) => {
    let state = stateManager.getState();
    const user_message = state.interaction.messages.at(-1)?.content ?? 'Hello';

    if (state.config.current_tool?.name === 'linear') {
      const linearContext = await linearService.getRecentTasksContext();
      stateManager.updateInteraction({
        tool_context: [...(stateManager.getState().interaction.tool_context || []), linearContext]
      });
    } else if (state.config.current_tool?.name === 'calendar') {
      const calendarContext = await calendarService.getRecentEventsContext();
      stateManager.updateInteraction({
        tool_context: [...(stateManager.getState().interaction.tool_context || []), calendarContext]
      });
    } else if (state.config.current_tool?.name === 'memory') {
      const memoryContext = await memoryService.getRecentMemoriesContext();
      stateManager.updateInteraction({
        tool_context: [...(stateManager.getState().interaction.tool_context || []), memoryContext]
      });
    }

    state = stateManager.getState();

    const useMessages: CoreMessage[] = [
      {role: 'system', content: usePrompt(state)},
      {role: 'user', content: user_message}
    ];

    const use_generation = span.generation({
      name: 'tool_use',
      input: useMessages,
      model: state.config.model
    });

    const toolUse = await completion.object<ToolUseResponse>({
      messages: useMessages,
      model: state.config.model,
      temperature: 0,
      user: { name: state.profile.user_name ?? 'Unknown User', uuid: state.config.conversation_uuid ?? 'unknown-conversation-uuid' }
    });

    if (!toolUse?.result) {
      await use_generation.end({output: null});
      return null;
    }

    if (state.config.current_action?.uuid) {
      const updated_action = await actionService.updateAction(state.config.current_action.uuid, {
        payload: toolUse.result.payload,
        status: 'pending'
      });

      const current_task = state.interaction.tasks.find(t => t.uuid === state.config.current_task?.uuid);
      if (current_task) {
        const updated_tasks: Task[] = state.interaction.tasks.map((task: Task) =>
          task.uuid === current_task.uuid
            ? {
                ...task,
                actions: task.actions.map(action => (action.uuid === updated_action.uuid ? mapActionRecordToAction(updated_action) : action))
              }
            : task
        );

        stateManager.updateInteraction({tasks: updated_tasks});
      }
    }

    await use_generation.end({output: toolUse});

    return toolUse.result;
  },

  act: async ({action, payload}: ToolUsePayload, span: LangfuseSpanClient) => {
    const state = stateManager.getState();
    const current_tool_config = state.config.current_tool;

    if (!current_tool_config?.name) {
      const errorMsg = 'Current tool name not found in state config.';
      span.update({ metadata: { error: errorMsg } });
      throw new Error(errorMsg);
    }

    const toolService = activeToolsMap[current_tool_config.name];
    if (!toolService) {
      const errorMsg = `Tool service for '${current_tool_config.name}' not found in activeToolsMap.`;
      span.update({ metadata: { error: errorMsg } });
      throw new Error(errorMsg);
    }

    try {
      const result = await toolService.execute(action, {...payload, conversation_uuid: state.config.conversation_uuid}, span);

      if (state.config.current_action?.uuid) {
        await updateActionState({
          action_uuid: state.config.current_action.uuid,
          result
        });
      }

      await span.event({
        name: `${current_tool_config?.name.split('/').pop()?.toLowerCase()}_execution_complete`,
        input: {action, payload},
        output: result,
        metadata: {
          tool: current_tool_config?.name,
          action,
          payload,
          result
        }
      });

      return result;
    } catch (error) {
      throw error;
    }
  }
};

const mapActionRecordToAction = (record: {
  name: string;
  type: string;
  status: string | null;
  id: number;
  uuid: string;
  created_at: string | null;
  updated_at: string | null;
  result: unknown;
  task_uuid: string;
  tool_uuid: string;
  payload: unknown;
  sequence: number | null;
}): Action => ({
  uuid: record.uuid,
  task_uuid: record.task_uuid,
  tool_uuid: record.tool_uuid,
  name: record.name,
  payload: record.payload,
  sequence: record.sequence,
  status: record.status ?? null,
  result: typeof record.result === 'string' ? record.result : null
});
