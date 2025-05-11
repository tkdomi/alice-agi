import db from '../../database/db';
import {actions} from '../../schema/action';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {documentService} from './document.service';
import {actionDocuments} from '../../schema/actionDocuments';
import {Action} from '../../types/agent';

const actionSchema = z.object({
  uuid: z.string(),
  task_uuid: z.string(),
  tool_uuid: z.string(),
  name: z.string(),
  sequence: z.number(),
  status: z.enum(['pending', 'completed', 'failed']),
  payload: z.record(z.unknown()).nullable()
});

export const actionService = {
  createAction: async (action: Action) => {
    const validated_action = actionSchema.parse(action);

    const [created_action] = await db
      .insert(actions)
      .values({
        uuid: validated_action.uuid,
        task_uuid: validated_action.task_uuid,
        tool_uuid: validated_action.tool_uuid,
        name: validated_action.name,
        type: 'sync',
        sequence: validated_action.sequence,
        status: validated_action.status,
        payload: validated_action.payload ? JSON.stringify(validated_action.payload) : null
      })
      .returning();

    return created_action;
  },

  updateAction: async (uuid: string, updates: Partial<Action>) => {
    const [updated_action] = await db
      .update(actions)
      .set({
        ...updates,
        payload: updates.payload ? JSON.stringify(updates.payload) : undefined,
        updated_at: new Date().toISOString()
      })
      .where(eq(actions.uuid, uuid))
      .returning();

    return updated_action;
  },

  updateActionWithResult: async (uuid: string, result: unknown): Promise<Action> => {
    const updated_data = await db.transaction(async tx => {
      // Standardize how text is extracted from various result shapes
      let extracted_text_content: string | null = null;

      if (typeof result === 'string') {
        extracted_text_content = result;
      } else if (typeof result === 'object' && result !== null) {
        // Check for MCP tool structure: { content: [{ type: 'text', text: '...' }] }
        if (Array.isArray((result as any).content) && (result as any).content.length > 0) {
          const firstContent = (result as any).content[0];
          if (typeof firstContent === 'object' && firstContent !== null && firstContent.type === 'text' && typeof firstContent.text === 'string') {
            extracted_text_content = firstContent.text;
          } else {
            // If content[0] is not a text object, stringify the whole result as a fallback
            extracted_text_content = JSON.stringify(result);
          }
        } else {
          // Fallback for other object structures (original logic)
          extracted_text_content = Object.entries({
            uuid: (result as any).uuid,
            name: (result as any).name,
            // Try to get 'text' or 'content' if they exist directly on result, otherwise stringify
            content: (result as any).text || (result as any).content,
            description: (result as any).description,
            metadata_description: (result as any).metadata?.description,
            metadata_source: (result as any).metadata?.source,
            original_source: (result as any).source
          })
          .filter(([_, value]) => value !== undefined && value !== null)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n');
          if (!extracted_text_content) { // If object mapping resulted in empty, stringify the whole object
             extracted_text_content = JSON.stringify(result);
          }
        }
      } else {
        extracted_text_content = JSON.stringify(result); // Fallback for other types (null, number, boolean)
      }

      const [action] = await tx
        .update(actions)
        .set({
          status: 'completed',
          result: extracted_text_content,
          updated_at: new Date().toISOString()
        })
        .where(eq(actions.uuid, uuid))
        .returning();

      if (!action) throw new Error('Action not found');

      let document_text = extracted_text_content;

      console.log(`[ACTION_SERVICE] Extracted document_text for action ${uuid}: First 100 chars:`, document_text?.substring(0, 100));
      console.log(`[ACTION_SERVICE] Type of document_text: ${typeof document_text}, Length: ${document_text?.length}`);

      console.log(`[ACTION_SERVICE] updateActionWithResult for ${uuid}.`);
      console.log(`[ACTION_SERVICE]   Raw result type: ${typeof result}`);
      console.log(`[ACTION_SERVICE]   Extracted document_text type: ${typeof document_text}`);
      console.log(`[ACTION_SERVICE]   document_text length: ${document_text?.length}`);
      console.log(`[ACTION_SERVICE]   document_text preview: '${document_text?.substring(0, 200)}...'`);

      if (document_text) {
        console.log(`[ACTION_SERVICE] Document text for ${uuid} is truthy. Proceeding to create document.`);
        const created_doc = await documentService.createDocument({
          conversation_uuid: action.task_uuid,
          text: document_text,
          source_uuid: action.task_uuid,
          action_uuid: action.uuid,
          metadata_override: {
            type: 'text',
            content_type: 'full',
            source: 'action_result'
          },
          should_index: true
        });

        await tx.insert(actionDocuments).values({
          action_uuid: action.uuid,
          document_uuid: created_doc.uuid
        });

        const [action_with_documents] = await tx.query.actions.findMany({
          where: eq(actions.uuid, uuid),
          with: {
            actionDocuments: {
              with: {
                document: true
              }
            }
          }
        });

        if (!action_with_documents) throw new Error('Failed to retrieve action with document');

        return {
          ...action_with_documents,
          documents: action_with_documents.actionDocuments.map(ad => ad.document)
        } as Action;
      } else {
        console.warn(`[ACTION_SERVICE] Document text for ${uuid} is falsy. Skipping document creation. Value of document_text:`, JSON.stringify(document_text));
        return {
          ...action,
          documents: []
        } as Action;
      }
    });

    return updated_data;
  }
};
