import {embed, generateText, generateObject, streamText} from 'ai';
import {openai} from '@ai-sdk/openai';
import OpenAI, { toFile } from 'openai';
import {type CompletionConfig} from '../../types/llm';
import type {CoreMessage} from 'ai';
import type {ChatCompletion} from 'openai/resources/chat/completions';
import {tempFile} from './upload.service';
import {providers} from '../../config/llm.config';
import {anthropic} from '@ai-sdk/anthropic';

const createBaseConfig = ({model = 'gpt-4.1', messages, temperature = 0.7, max_tokens = 16384, user}: CompletionConfig) => {
  const provider = Object.entries(providers).find(([_, models]) => 
    Object.keys(models).includes(model)
  )?.[0] ?? 'openai';

  const modelSpec = providers[provider][model];
  if (!modelSpec) {
    throw new Error(`Model ${model} not found in configuration`);
  }

  const aiModel = provider === 'anthropic' 
    ? anthropic(modelSpec.id)
    : openai(modelSpec.id);

  return {
    model: aiModel,
    messages: messages as CoreMessage[],
    temperature,
    max_tokens: Math.min(max_tokens, modelSpec.maxOutput),
    user: user.uuid
  };
};

export const completion = {
  text: async ({max_tokens = 16384, ...config}: CompletionConfig, openAIFormat = false): Promise<string | ChatCompletion> => {
    try {
      const result = await generateText({
        ...createBaseConfig(config),
        maxTokens: max_tokens
      });

      return openAIFormat ? generateResponseBody(result.text, config.model || 'gpt-4o', result.usage) : result.text;
    } catch (error) {
      throw new Error(`Text completion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  stream: async ({max_tokens = 16384, ...config}: CompletionConfig) => {
    try {
      const provider = Object.entries(providers).find(([_, models]) => 
        Object.keys(models).includes(config.model || 'gpt-4o')
      )?.[0] ?? 'openai';

      const {textStream} = streamText({
        ...createBaseConfig(config),
        maxTokens: Math.min(max_tokens, providers[provider][config.model || 'gpt-4o'].maxOutput)
      });
      return textStream;
    } catch (error) {
      throw new Error(`Stream completion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  object: async <T = unknown>(config: CompletionConfig): Promise<T> => {
    try {
      const provider = Object.entries(providers).find(([_, models]) => 
        Object.keys(models).includes(config.model || 'gpt-4o')
      )?.[0] ?? 'openai';

      if (provider === 'anthropic') {
        const result = await completion.text({
          ...config,
          max_tokens: providers[provider][config.model || 'gpt-4o'].maxOutput
        });
        return JSON.parse(result as string) as T;
      }

      const {object} = await generateObject({
        ...createBaseConfig(config),
        output: 'no-schema'
      });
      return object as T;
    } catch (error) {
      throw new Error(`Object completion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
};

export const embedding = async (text: string) => {
  const {embedding} = await embed({
    model: openai.embedding('text-embedding-3-large'),
    value: text
  });

  return embedding;
};

export function generateChunk(delta: string, model: string) {
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: 'fp_' + Math.random().toString(36).substring(2, 15),
    choices: [{index: 0, delta: {role: 'assistant', content: delta}, logprobs: null, finish_reason: null}]
  };
}

export function generateResponseBody(response: string, model: string, usage?: any): ChatCompletion {
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: 'fp_' + Math.random().toString(36).substring(2, 15),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: response,
        },
        finish_reason: 'stop'
      }
    ],
    usage: usage
      ? {
          prompt_tokens: usage.promptTokens ?? 0,
          completion_tokens: usage.completionTokens ?? 0,
          total_tokens: usage.totalTokens ?? 0
        }
      : {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
  };
}

interface TranscriptionConfig {
  language: string;
  prompt?: string;
  model?: string;
}

interface TranscriptionResult {
  text: string;
  file_name: string;
  file_path?: string;
}

const openai_client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export const transcription = {
  fromBuffer: async (
    audio_buffer: Buffer,
    config: TranscriptionConfig = { language: 'en' }
  ): Promise<string> => {
    const temp = await tempFile.fromBuffer(audio_buffer, 'ogg');
    
    try {
      const file = await toFile(audio_buffer, 'audio.ogg');
      
      const result = await openai_client.audio.transcriptions.create({
        file,
        model: config.model || 'whisper-1',
        language: config.language,
        prompt: config.prompt,
      });
      
      return result.text;
    } finally {
      await temp.cleanup();
    }
  },

  fromFiles: async (
    file_paths: string[],
    config: TranscriptionConfig & { output_name?: string } = { language: 'en' }
  ): Promise<TranscriptionResult[]> => {
    try {
      const results = await Promise.all(
        file_paths.map(async (file_path): Promise<TranscriptionResult> => {
          const file = Bun.file(file_path);
          const buffer = await file.arrayBuffer();
          
          const text = await transcription.fromBuffer(Buffer.from(buffer), config);
          
          return {
            text,
            file_name: file.name,
            file_path
          };
        })
      );

      return results;
    } catch (error) {
      throw new Error(`Batch transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
};
