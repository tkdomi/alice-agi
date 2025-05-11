import {Context, Next} from 'hono';
import * as userService from '../services/common/user.service';
import {v4 as uuidv4} from 'uuid';
import {providers} from '../config/llm.config';

export const authMiddleware = () => {
  return async (c: Context, next: Next) => {
    if (
      c.req.path.match(/^\/api\/auth\/google(?:\/.*)?$/) ||
      c.req.path.match(/^\/(api\/auth|api\/files|api\/file)\/[0-9a-f-]+$/i) ||
      c.req.path.match(/^\/api\/auth\/spotify\/(?:callback|authorize)/)
    ) {
      return next();
    }

    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({error: 'Missing or invalid authorization header'}, {status: 401});
    }

    const token = authHeader.split(' ')[1];
    const user = await userService.findByToken(token);

    if (!user) {
      return c.json({error: 'Invalid API key'}, {status: 401});
    }

    const content_type = c.req.header('Content-Type') || '';
    const is_multipart = content_type.includes('multipart/form-data');
    const request_body = is_multipart ? {} : await c.req.json().catch(() => ({}));

    const supported_models = Object.values(providers)
      .flatMap(provider => Object.keys(provider));
    const default_model = 'gpt-4.1';
    const requested_model = is_multipart ? default_model : request_body.model;
    const validated_model = supported_models.includes(requested_model) ? requested_model : default_model;

    if (requested_model && requested_model !== validated_model) {
      c.set('warning', `Invalid model '${requested_model}' requested. Using '${default_model}' instead.`);
    }

    c.set('request', {
      ...request_body,
      user,
      model: validated_model,
      conversation_id: is_multipart ? uuidv4() : request_body.conversation_id || uuidv4()
    });

    await next();
  };
};
