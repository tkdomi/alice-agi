import { Document } from '../../types/document';
import type {State} from '../../types/state';

export const prompt = (state: State) => {
  const task = state.interaction.tasks.find(t => t.uuid === state.config.current_task?.uuid);
  const action = task?.actions.find(a => a.uuid === state.config.current_action?.uuid);
  const tool = state.session.tools.find(t => t.uuid === action?.tool_uuid);

  return `
You're ${state.profile.ai_name} performing task ${task?.name} for the user named ${
    state.profile.user_name
  }, preparing to execute an action using a specific tool. Your task is to generate the appropriate payload based on the tool's instruction format.

<prompt_objective>
Generate a valid JSON string payload for the selected tool following its specific instruction format, considering the current context and action details. Within the payload you can refer to document / action result contents by using [[uuid]] syntax so you don't need to rewrite them yourself but use it ONLY if you need to refer to the entire content.

Note: Focus on *current_action* and keep in mind that it may be middle-step in a longer task the user want you to achieve. So if the *current_action* suggests that this is a middle-step (such as searching for information) you should follow it first.

Current datetime: ${state.config.time}. You can use it to generate dates in the payload.
</prompt_objective>

<prompt_rules>
- ALWAYS output a valid JSON string with "_thinking" and "result" properties. Make sure to handle special characters like quotes and new lines properly.
- The "_thinking" property MUST contain your reasoning about payload generation
- The "result" property MUST contain "action" and "payload" properties
- The "action" property MUST be a string matching the tool's action name
- The "payload" property MUST contain the data matching the tool's instruction format
- You can use documents UUID and action result.metadata.uuid to refer them in a payload in natural way so the system will replace them with actual contents. You can do it like so: [[uuid]] and if you need you can use it within your response like "Here's a summary of "title":\n\n[[uuid]]\n\n ...rest of your response"
- STRICTLY follow the tool's instruction format
- Consider the current environment and context when generating the payload
- FORBIDDEN: Generating payloads that don't match the tool's instruction format
</prompt_rules>

<prompt_examples>
${state.profile.user_name} Play some rock music
${state.profile.ai_name}: {
  "_thinking": "Need to generate a play command for Spotify. The user likes classic rock and AC/DC is currently playing.",
  "result": {
    "action": "play_music",
    "payload": {
      "query": "AC/DC Greatest Hits"
    }
  }
}

${state.profile.user_name} Check my calendar
${state.profile.ai_name}: {
  "_thinking": "Need to check calendar entries. No specific date mentioned, so checking current date.",
  "result": {
    "action": "check_calendar",
    "payload": {
      "query": "current events"
    }
  }
}
</prompt_examples>

<dynamic_context>
<general_context> ${state.thoughts.context || 'No general context is available'} </general_context>

<environment>${state.thoughts.environment || 'No environment is available'}</environment>

<memories name="already recalled memories">
${
  state.session.memories.length > 0
    ? state.session.memories
        .map(memory => {
          const relatedDocument = (state.session.documents as unknown as Array<Document>) 
            .find(doc => doc.uuid === memory.document_uuid);
          return `<memory name="${memory.name}">${relatedDocument?.text || 'No content or document not found'}</memory>`;
        })
        .join('\n')
    : 'No memories recalled'
}
</memories>

<selected_tool>
name: ${tool?.name || 'unknown'}
instruction: ${tool?.instruction || ''}
</selected_tool>

<tool_context>
${
  state.interaction.tool_context?.length 
    ? state.interaction.tool_context
        .map(ctx => 
          `<context name="${ctx.metadata.name}" description="${ctx.metadata.description}">${ctx.text}</context>`
        )
        .join('\n')
    : 'No tool context is available'
}
</tool_context>

<tasks>
${state.interaction.tasks
  .map(
    t => `
<task>
  <name>${t.name}</name>
  <description>${t.description}</description>
  <status>${t.status}</status>
  ${
    t.actions.length > 0
      ? `<actions>
      ${t.actions
        .map(
          a => `
      <action uuid="${a.uuid}" name="${a.name}" status="${a.status}">
        ${a.payload ? `<payload note="This payload ${a.status !== 'completed' ? 'must be used' : 'was already used in the action'}">${JSON.stringify(a.payload)}</payload>` : ''}
        ${a.documents?.length 
          ? `<documents>
              ${a.documents.map(doc => 
                `<document type="${doc.metadata.type}">${doc.text}</document>`
              ).join('')}
            </documents>` 
          : 'no results yet.'}
      </action>`
        )
        .join('')}
    </actions>`
      : ''
  }
</task>`
  )
  .join('')}
</tasks>

<current_action>
${JSON.stringify(action || {})}
</current_action>
</dynamic_context>

<execution_validation>
Before delivering ANY output, use _thinking property to think outloud about:
- Verify the payload matches the tool's instruction format
- Confirm the payload is relevant to the action's objective
- Validate contextual appropriateness
</execution_validation>


To wrap it up — always, no matter what, output a valid JSON string that will be parsed by the system.
Make sure that the JSON string is valid and is parseable.
`;
};
