import agi from './routes/agi';
import files from './routes/files';
import {Hono} from 'hono';
import {logger} from 'hono/logger';
import {prettyJSON} from 'hono/pretty-json';
import {cors} from 'hono/cors';
import {bodyLimit} from './middleware/upload';
import {errorHandler} from './middleware/error';
import {authMiddleware} from './middleware/auth';
import {namingMiddleware} from './middleware/naming';
import {mapperMiddleware} from './middleware/mapper';
import tools from './routes/tools';
import auth from './routes/auth';
import { vectorService } from './services/common/vector.service';
import { cronService } from './services/common/cron.service';
import conversation from './routes/conversation';
import { rateLimit } from './middleware/rate-limit';
import { toolRegistrationService } from './services/agent/tool.registration.service';

const app = new Hono();
console.log('app');

// Global middleware
app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', cors({
  origin: ['https://ai.overment.com', 'https://agi.overment.com', 'https://overment.com', 'http://localhost:8080'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
  credentials: true,
  exposeHeaders: ['Content-Length', 'X-Requested-With']
}));
app.use('*', errorHandler());
app.use(
  '*',
  bodyLimit({
    maxSize: 50 * 1024 * 1024, // 50MB
    onError: c => c.text('File too large', 413)
  })
);
app.use('*', rateLimit({
  max: 50,      // 100 requests
  window: 60,    // per 60 seconds
  message: 'Rate limit exceeded. Please try again later.'
}));

app.use('/api/*', authMiddleware());
app.use('/api/agi/chat', namingMiddleware);
app.use('/api/agi/chat', mapperMiddleware);

// Routes
app.route('/api/auth', auth);
app.route('/api/agi', agi);
app.route('/api/conversation', conversation);
app.route('/api/files', files);
app.route('/api/tools', tools);

app.get('/', c => c.text('AGI is here.'));

const port = Number(process.env.PORT) || 8080;

const cleanup = async () => {
  await cronService.cleanup();
  // Add other cleanup tasks here if needed
  process.exit(0);
};

// Handle graceful shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

async function startServer() {
  // Initialize services
  await vectorService.initializeCollection();
  await cronService.initialize(1000).catch(console.error);
  
  await toolRegistrationService.initializeTools().catch(error => {
    console.error("[Startup] Failed to initialize MCP tools:", error);
  });

  Bun.serve({
    fetch: app.fetch,
    port,
    idleTimeout: 255
  });

  console.log(`Server is running on http://localhost:${port}`);
}

startServer();

