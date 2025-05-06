import { spotifyService } from '../services/tools/spotify.service';
import { memoryService } from '../services/agent/memory.service';
import { resendService } from '../services/tools/resend.service';
import { fileService } from '../services/tools/file.service';
import { speakService } from '../services/tools/speak.service';
import { linearService } from '../services/tools/linear.service';
import { mapService } from '../services/tools/map.service';
import { cryptoService } from '../services/tools/crypto.service';
import { webService } from '../services/tools/web.service';
import { calendarService } from '../services/agent/calendar.service';

export interface ToolService {
  execute: (action: string, payload: Record<string, any>, span?: any) => Promise<any>;
}

const finalAnswerService: ToolService = {
  execute: async (action: string, payload: Record<string, any>, span?: any) => {
    // This tool doesn't "execute" in the traditional sense if the loop breaks before 'act'.
    // Its selection signals the end of the process.
    // The payload would ideally contain the final answer content.
    return payload.answer || payload.content || "Process complete. Final answer delivered.";
  }
};

export const toolsMap: Record<string, ToolService> = {
  spotify: spotifyService,
  memory: memoryService,
  resend: resendService,
  files: fileService,
  speak: speakService,
  linear: linearService,
  maps: mapService,
  crypto: cryptoService,
  google: webService,
  calendar: calendarService,
  final_answer: finalAnswerService
} as const;

export type ToolName = keyof typeof toolsMap; 