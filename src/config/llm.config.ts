interface ModelSpecs {
  id: string;
  contextWindow: number;
  maxOutput: number;
  knowledgeCutoff: string;
}

export const providers: Record<string, Record<string, ModelSpecs>> = {
  openai: {
    'gpt-4o': {
      id: 'gpt-4o',
      contextWindow: 128_000,
      maxOutput: 16_384,
      knowledgeCutoff: '2023-10'
    },
    'gpt-4o-mini': {
      id: 'gpt-4o-mini',
      contextWindow: 128_000,
      maxOutput: 16_384,
      knowledgeCutoff: '2023-10'
    },
    'gpt-4.1': {
      id: 'gpt-4.1',
      contextWindow: 1047576,
      maxOutput: 32768,
      knowledgeCutoff: '2024-04'
    },
    'gpt-4.1-mini': {
      id: 'gpt-4.1-mini',
      contextWindow: 1047576,
      maxOutput: 32768,
      knowledgeCutoff: '2024-04'
    },
    'o1-preview': {
      id: 'o1-preview',
      contextWindow: 128_000,
      maxOutput: 32_768,
      knowledgeCutoff: '2023-10'
    },
    'o1-mini': {
      id: 'o1-mini',
      contextWindow: 128_000,
      maxOutput: 65_536,
      knowledgeCutoff: '2023-10'
    }
  },
  anthropic: {
    'claude-3-5-sonnet-latest': {
      id: 'claude-3-5-sonnet-latest',
      contextWindow: 200_000,
      maxOutput: 8_192,
      knowledgeCutoff: '2024-04'
    }
  }
};
