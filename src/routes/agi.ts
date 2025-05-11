import {Hono} from 'hono';
import {AppEnv} from '../types/hono';
import {completion} from '../services/common/llm.service';
import {streamResponse} from '../utils/response';
import {isChatCompletion, isStreamResponse} from '../types/guards';
import {setAssistantResponse, setInteractionState} from '../services/agent/agi.service';
import {observer} from '../services/agent/observer.service';
import {prompt as answerPrompt} from '../prompts/agent/answer';

import {CoreMessage} from 'ai';
import {stateManager} from '../services/agent/state.service';
import {aiService} from '../services/agent/ai.service';
import {taskService} from '../services/agent/task.service';
import {actionService} from '../services/agent/action.service';

export default new Hono<AppEnv>().post('/chat', async c => {
  const request = c.get('request');

  const conversation_id = await setInteractionState(request);

  // Ensure trace is initialized before use
  const trace = await observer.initializeTrace(request.conversation_id || 'general');
  if (!trace) {
    throw new Error('Failed to initialize trace');
  }

  await aiService.fastTrack(trace);
  let state = stateManager.getState();

  if (!state.config.fast_track) {
    await aiService.think(trace);
  }

  state = stateManager.getState();

  const messages: CoreMessage[] = [{role: 'system', content: answerPrompt(state)}, ...request.messages];

  const final_generation = observer.startGeneration({name: 'final_answer', input: messages});
  const result = request.stream
    ? await completion.stream({...request, messages})
    : await completion.text({...request, messages}, true);

  if (!request.stream && isChatCompletion(result)) {
    observer.endGeneration(final_generation.id, result);

    const final_task = state.interaction.tasks.find(task => task.type === 'final');
    const response_content = result.choices[0]?.message?.content || '';

    if (final_task) {
      await Promise.all([
        taskService.updateTaskStatus(final_task.uuid, 'completed'),
        taskService.updateTaskResult(final_task.uuid, response_content),
        state.config.current_action?.uuid && actionService.updateActionWithResult(state.config.current_action.uuid, 'This turn was completed. ')
      ]);
    }

    await setAssistantResponse({conversation_id, response: result});
  }

  return request.stream && isStreamResponse(result)
    ? streamResponse(c, result, {
        traceId: trace.id,
        generationId: final_generation.id,
        messages: request.messages,
        conversation_id
      })
    : c.json(result);
})
