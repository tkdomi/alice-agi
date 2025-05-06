import { Hono } from 'hono';
import { AppEnv } from '../types/hono';
import spotify from './spotify';
import web from './web';
import memory from './memory';
import linear from './linear';
import text from './text';
import cron from './cron';

const tools = new Hono<AppEnv>();

tools.route('/spotify', spotify);
tools.route('/web', web);
tools.route('/memory', memory);
tools.route('/linear', linear);
tools.route('/text', text);
tools.route('/cron', cron);

export default tools;
