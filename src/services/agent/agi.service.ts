import {ChatRequest} from '../../dto/chat.dto';
import {stateManager} from '../../services/agent/state.service';
import {conversationService} from '../../services/agent/conversation.service';
import {messageService} from '../../services/agent/message.service';
import {v4 as uuidv4} from 'uuid';
import {CoreMessage, Message} from 'ai';
import {SetAssistantResponseParams} from '../../types/agi';
import {toolService} from './tool.service';
import {categoryService} from './category.service';
import {memoryService} from './memory.service';
import {actionService} from './action.service';
import {Document} from '../../types/document';
import {taskService} from './task.service';

export const shouldContinueThinking = (): boolean => {
  const state = stateManager.getState();
  const {step, max_steps, current_tool} = state.config;
  const is_final_answer = current_tool?.name === 'final_answer';

  return step < max_steps && !is_final_answer;
};

export const setInteractionState = async (request: ChatRequest) => {
  // Create conversation if not provided
  const conversation_id = await conversationService.getOrCreate(request.conversation_id || uuidv4(), request.user.uuid);

  // Load categories, memories, and tasks.
  // Tools are now globally initialized by toolRegistrationService and should not be overwritten here.
  const [categories, memories, tasks] = await Promise.all([
    categoryService.findAll(),
    memoryService.findByConversationId(conversation_id),
    taskService.findByConversationId(conversation_id),
  ]);

  // Update interaction state with messages and tasks
  stateManager.updateInteraction({
    messages: request.messages as Message[],
    tasks: tasks || []
  });

  // Save the last user message
  const lastMessage = request.messages[request.messages.length - 1];
  if (lastMessage.role === 'user') {
    await messageService.create({
      conversation_uuid: conversation_id,
      message: lastMessage as CoreMessage,
      source: request.user.name
    });
  }

  // Update session state with loaded data
  // CRITICAL: Retrieve the current tools from state (initialized at startup)
  // rather than overwriting with a limited DB-fetched list.
  const existingTools = stateManager.getState().session.tools;

  stateManager.updateSession({
    tools: existingTools, // Use the globally initialized tools
    categories: categories.map(({name, subcategory, description}) => ({
      category: name,
      subcategory: subcategory || '',
      description: description || ''
    })),
    memories: memories.map(mem => ({
      ...mem,
      created_at: mem.created_at || new Date().toISOString(),
      updated_at: mem.updated_at || new Date().toISOString(),
    }))
  });

  stateManager.updateConfig({
    step: 1,
    current_phase: 'initialization',
    current_task: null,
    current_action: null,
    current_tool: null,
    user_uuid: request.user.uuid,
    conversation_uuid: conversation_id,
    model: request.model,
    temperature: request.temperature || 0.7,
    max_tokens: request.max_tokens || 16384,
    time: new Date()
      .toLocaleString('en-GB', {
        timeZone: 'Europe/Warsaw',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
      .replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+)/, '$3-$2-$1 $4:$5')
  });

  stateManager.updateProfile({
    ai_name: 'Alice',
    user_name: request.user.name,
    context: request.user.context,
    environment: JSON.parse(request.user.environment || '{}')
  });

  return conversation_id;
};

export const setAssistantResponse = async ({conversation_id, response, source = 'assistant'}: SetAssistantResponseParams): Promise<void> => {
  if (!conversation_id) {
    throw new Error('Conversation ID is required');
  }

  const content = typeof response === 'string' ? response : response.choices[0]?.message?.content;

  if (!content) {
    throw new Error('Invalid assistant response');
  }

  const message: CoreMessage = {
    role: 'assistant',
    content
  };

  // Add message to database
  await messageService.create({
    conversation_uuid: conversation_id,
    message,
    source
  });

  // Update interaction state with new assistant message
  const current_state = stateManager.getState();
  stateManager.updateInteraction({
    messages: [...current_state.interaction.messages, message as Message]
  });

  stateManager.updateConfig({
    current_phase: 'completed',
    current_task: null,
    current_action: null
  });
};

interface UpdateActionStateParams {
  action_uuid: string;
  result: unknown;
  documents?: Document[];
}

export const updateActionState = async ({action_uuid, result}: {action_uuid: string; result: unknown}) => {
  // 1. Update the action with result and get formatted result back
  const updated_action = await actionService.updateActionWithResult(action_uuid, result);
  
  // 2. Get the current state
  const state = stateManager.getState();
  
  // 3. Find the current task and update its action in state
  const updated_tasks = state.interaction.tasks.map(task => {
    const updated_actions = task.actions.map(action => 
      action.uuid === action_uuid
        ? { 
            ...action, 
            status: 'completed', 
            result: updated_action.result
          }
        : action
    );
    
    if (updated_actions.find(action => action.uuid === action_uuid)) {
      console.log('updated_actions', updated_actions.find(action => action.uuid === action_uuid)?.name + ' with the result: ' + updated_action.result);
    }
    
    return { ...task, actions: updated_actions };
  });

  // Update state with new actions
  stateManager.updateInteraction({ tasks: updated_tasks });
  
  // 4. Find current task for completion check
  const current_task = updated_tasks.find(task => 
    task.actions.some(action => action.uuid === action_uuid)
  );
  
  if (!current_task) return;

  // 5. Check if all actions in each task are completed
  const tasks_with_completion = updated_tasks.map(task => {
    const has_actions = task.actions.length > 0;
    const all_actions_completed = has_actions && task.actions.every(
      action => action.status === 'completed'
    );

    // Update task status if all actions are completed
    return all_actions_completed ? {...task, status: 'completed'} : task;
  });

  // Update state to reflect task completion
  stateManager.updateInteraction({tasks: tasks_with_completion});

  // 6. Update the task status in the database if necessary
  await Promise.all(
    tasks_with_completion
      .filter(task => task.status === 'completed')
      .map(task => taskService.updateTaskStatus(task.uuid, 'completed'))
  );

  return updated_action;
};
