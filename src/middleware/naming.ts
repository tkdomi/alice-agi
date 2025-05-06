import {Context, Next} from 'hono';

// This middleware is used specifically for heyalice.app
export const namingMiddleware = async (c: Context, next: Next) => {
  try {
    const body = await c.req.json();
    const {messages} = body;

    const namingConversation =
      typeof messages?.at(-1)?.content === 'string'
        ? messages.at(-1).content.trim().startsWith('Name the following')
        : false;


    if (namingConversation) {
      return c.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'AGI is here!'
            }
          }
        ]
      });
    }

    c.set('parsedBody', body);
    await next();
  } catch (error) {
    return c.json({error: 'Invalid request body'}, 400);
  }
};
