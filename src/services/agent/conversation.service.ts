import db from '../../database/db';
import {conversations, type NewConversation} from '../../schema/conversation';
import {v4 as uuidv4} from 'uuid';
import {eq, desc, gte, and, sql} from 'drizzle-orm';
import {messages} from '../../schema/message';

interface CreateConversationParams {
  uuid: string;
  user_id: string;
  name?: string;
}

interface GetConversationsParams {
  user_id: string;
  limit?: number;
}

export const conversationService = {
  create: async ({uuid, user_id, name}: CreateConversationParams): Promise<NewConversation> => {
    try {
      const [conversation] = await db
        .insert(conversations)
        .values({
          uuid,
          user_id,
          name: name || 'unknown',
          status: 'active'
        })
        .returning();

      if (!conversation) {
        throw new Error('Failed to create conversation');
      }

      return conversation;
    } catch (error) {
      throw new Error(`Error creating conversation: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  findByUuid: async (uuid: string) => {
    try {
      const [conversation] = await db.select().from(conversations).where(eq(conversations.uuid, uuid)).limit(1);

      return conversation;
    } catch (error) {
      throw new Error(`Error finding conversation: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  getOrCreate: async (conversation_id: string | undefined, user_id: string): Promise<string> => {
    try {
      if (conversation_id) {
        const existing_conversation = await conversationService.findByUuid(conversation_id);
        if (existing_conversation) {
          return existing_conversation.uuid;
        }
      }

      const new_conversation = await conversationService.create({
        uuid: conversation_id || uuidv4(),
        user_id,
        name: 'New Conversation'
      });
      return new_conversation.uuid;
    } catch (error) {
      throw new Error(`Error in getOrCreate: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  getRecentConversations: async ({user_id, limit = 10}: GetConversationsParams) => {
    console.log('...', user_id);
    try {
      const conversations_list = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.user_id, user_id),
            gte(conversations.created_at, sql`datetime('now', '-15 minutes')`)
          )
        )
        .orderBy(desc(conversations.created_at))
        .limit(limit);

      return conversations_list;
    } catch (error) {
      throw new Error(`Error getting recent conversations: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  getConversationMessages: async (conversation_uuid: string) => {
    try {
      const conversation_messages = await db
        .select()
        .from(messages)
        .where(eq(messages.conversation_uuid, conversation_uuid))
        .orderBy(messages.created_at);

      return conversation_messages;
    } catch (error) {
      throw new Error(`Error getting conversation messages: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
};
