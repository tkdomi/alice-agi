import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { cronService } from '../services/common/cron.service';
import type { AppEnv } from '../types/hono';

// Input validation schemas
const CreateJobSchema = z.object({
  name: z.string().min(1, "Name cannot be empty"),
  description: z.string(),
  type: z.enum(['cron', 'scheduled', 'recurring']),
  schedule: z.string().optional(),
  due_date: z.string().datetime().optional(),
  metadata: z.record(z.any()).optional()
});

const cron = new Hono<AppEnv>()
  .post('/', zValidator('json', CreateJobSchema), async (c) => {
    try {
      const job_data = c.req.valid('json');
      const task_uuid = uuidv4();
      
      // Convert due_date to schedule format if provided
      const schedule = job_data.due_date || job_data.schedule;
      
      if (!schedule) {
        return c.json({ 
          success: false, 
          error: 'Either schedule or due_date must be provided' 
        }, 400);
      }

      const job = await cronService.createJob({
        name: job_data.name,
        type: job_data.type,
        schedule,
        task_uuid,
        metadata: {
          description: job_data.description,
          ...job_data.metadata
        }
      });

      return c.json({ success: true, data: job });
    } catch (error) {
      console.error('Error creating job:', error);
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  })
  .get('/:job_uuid', async (c) => {
    try {
      const job_uuid = c.req.param('job_uuid');
      const job = await cronService.getJob(job_uuid);
      
      if (!job) {
        return c.json({ success: false, error: 'Job not found' }, 404);
      }

      return c.json({ success: true, data: job });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  })
  .delete('/:job_uuid', async (c) => {
    try {
      const job_uuid = c.req.param('job_uuid');
      await cronService.cancelJob(job_uuid);
      return c.json({ success: true });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

export default cron; 