import {z} from 'zod';
import {type State} from '../../types/state';
import {EventEmitter} from 'events';

// State validation schemas
const ConfigSchema = z.object({
  step: z.number(),
  max_steps: z.number(),
  current_phase: z.string().nullable(),
  current_task: z.object({uuid: z.string(), name: z.string()}).nullable(),
  current_tool: z.object({uuid: z.string(), name: z.string()}).nullable(),
  current_action: z.object({uuid: z.string(), name: z.string()}).nullable(),
  user_uuid: z.string().nullable(),
  conversation_uuid: z.string().nullable(),
  model: z.string(),
  temperature: z.number(),
  max_tokens: z.number(),
  fast_track: z.boolean(),
  time: z.string()
});

const StateSchema = z.object({
  config: ConfigSchema,
  thoughts: z.object({
    environment: z.string(),
    context: z.string(),
    memory: z.array(z.any()),
    tools: z.array(z.any())
  }),
  profile: z.object({
    environment: z.record(z.any()),
    context: z.string(),
    ai_name: z.string(),
    user_name: z.string()
  }),
  interaction: z.object({
    tasks: z.array(z.any()),
    messages: z.array(z.any())
  }),
  session: z.object({
    memories: z.array(z.any()),
    tools: z.array(z.any()),
    categories: z.array(z.any()),
    documents: z.array(z.any())
  })
});

interface StateUpdate {
  path: string[];
  value: unknown;
  timestamp: string;
}

const createStateManager = () => {
  const events = new EventEmitter();
  const history: StateUpdate[] = [];

  // Make state readonly to prevent direct mutations
  let state: Readonly<State> = {
    config: {
      fast_track: false,
      step: 0,
      max_steps: 10,
      current_phase: null,
      current_task: null,
      current_tool: null,
      current_action: null,
      user_uuid: null,
      conversation_uuid: null,
      model: 'gpt-4.1',
      alt_model: 'gpt-4.1-mini',
      temperature: 0.7,
      max_tokens: 16384,
      time: new Date().toISOString()
    },
    thoughts: {
      environment: '',
      context: '',
      memory: [],
      tools: []
    },
    profile: {
      environment: {},
      context: '',
      ai_name: '',
      user_name: ''
    },
    interaction: {
      tasks: [],
      messages: [],
      tool_context: []
    },
    session: {
      memories: [],
      tools: [],
      categories: [],
      documents: []
    }
  } as const;

  const validateState = (newState: State) => {
    try {
      return StateSchema.parse(newState);
    } catch (error) {
      throw new Error(`Invalid state: ${error}`);
    }
  };

  const recordUpdate = (path: string[], value: unknown) => {
    const update: StateUpdate = {
      path,
      value,
      timestamp: new Date().toISOString()
    };
    history.push(update);
    events.emit('stateUpdate', update);
  };

  const setNestedValue = (obj: any, path: string[], value: unknown): any => {
    const [head, ...rest] = path;
    const clonedObj = structuredClone(obj);

    if (rest.length === 0) {
      return {...clonedObj, [head]: value};
    }

    return {
      ...clonedObj,
      [head]: setNestedValue(clonedObj[head], rest, value)
    };
  };

  const updateState = <T>(path: string[], value: T): State => {
    // Create new immutable state
    const newState = setNestedValue(state, path, value);

    // Validate before updating
    validateState(newState);

    // Record the update
    recordUpdate(path, value);

    // Update state reference with new immutable state
    state = Object.freeze(newState);

    return structuredClone(state);
  };

  const updateThoughts = (thoughts: Partial<State['thoughts']>) => {
    // Validate memory is array before update
    if (thoughts.memory !== undefined && !Array.isArray(thoughts.memory)) {
      throw new Error('thoughts.memory must be an array, received: ' + thoughts.memory);
    }

    return updateState(['thoughts'], {...structuredClone(state.thoughts), ...thoughts});
  };

  return {
    getState: () => structuredClone(state),

    getHistory: () => [...history],

    subscribe: (callback: (update: StateUpdate) => void) => {
      events.on('stateUpdate', callback);
      return () => events.off('stateUpdate', callback);
    },

    transaction: async (updates: Array<{path: string[]; value: unknown}>) => {
      const oldState = structuredClone(state);
      try {
        for (const update of updates) {
          updateState(update.path, update.value);
        }
        return state;
      } catch (error) {
        state = oldState; // Rollback
        throw error;
      }
    },

    updateConfig: (config: Partial<State['config']>) => updateState(['config'], {...structuredClone(state.config), ...config}),

    updateThoughts: updateThoughts,

    updateProfile: (profile: Partial<State['profile']>) => updateState(['profile'], {...structuredClone(state.profile), ...profile}),

    updateInteraction: (interaction: Partial<State['interaction']>) => updateState(['interaction'], {...structuredClone(state.interaction), ...interaction}),

    updateSession: (session: Partial<State['session']>) => updateState(['session'], {...structuredClone(state.session), ...session})
  };
};

export const stateManager = createStateManager();
