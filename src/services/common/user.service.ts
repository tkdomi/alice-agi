import db from '../../database/db';
import {users} from '../../schema/user';
import {eq} from 'drizzle-orm';
import type {User} from '../../schema/user';

// Export individual functions instead of a class for better modularity and testing
export const findByToken = async (token: string): Promise<User | undefined> => {
  console.log('Finding user by token:', token); // Debug log
  
  if (!token) {
    console.log('No token provided'); // Debug log
    return undefined;
  }

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.token, token))
      .limit(1);

    return user;
  } catch (error) {
    console.error('Error finding user by token:', error); // Error log
    throw error;
  }
};

export const findByUUID = async (uuid: string): Promise<User | undefined> => {
  const [user] = await db.select().from(users).where(eq(users.uuid, uuid)).limit(1);

  return user;
};

export const updateSpotifyTokens = async (
  user_uuid: string, 
  access_token: string, 
  refresh_token: string,
  expires_in: number
) => {
  const expiry = new Date(Date.now() + expires_in * 1000);
  
  await db
    .update(users)
    .set({
      spotifyAccessToken: access_token,
      spotifyRefreshToken: refresh_token,
      spotifyTokenExpiry: expiry,
      updatedAt: new Date()
    })
    .where(eq(users.uuid, user_uuid));
};

export const getSpotifyTokens = async (user_uuid: string): Promise<{ 
  access_token?: string; 
  refresh_token?: string;
  expires_at?: Date;
} | undefined> => {
  const [user] = await db
    .select({
      access_token: users.spotifyAccessToken,
      refresh_token: users.spotifyRefreshToken,
      expires_at: users.spotifyTokenExpiry
    })
    .from(users)
    .where(eq(users.uuid, user_uuid))
    .limit(1);

  if (!user) return undefined;

  return {
    access_token: user.access_token ?? undefined,
    refresh_token: user.refresh_token ?? undefined,
    expires_at: user.expires_at
  };
};

export const updateGoogleTokens = async (
  user_uuid: string, 
  access_token: string, 
  refresh_token: string,
  expires_in: number
) => {
  const expiry = new Date(Date.now() + expires_in * 1000);
  
  await db
    .update(users)
    .set({
      googleAccessToken: access_token,
      googleRefreshToken: refresh_token,
      googleTokenExpiry: expiry,
      updatedAt: new Date()
    })
    .where(eq(users.uuid, user_uuid));
};

export const getGoogleTokens = async (user_uuid: string): Promise<{ 
  access_token?: string; 
  refresh_token?: string;
  expires_at?: Date;
} | undefined> => {
  const [user] = await db
    .select({
      access_token: users.googleAccessToken,
      refresh_token: users.googleRefreshToken,
      expires_at: users.googleTokenExpiry
    })
    .from(users)
    .where(eq(users.uuid, user_uuid))
    .limit(1);

  if (!user) return undefined;

  return {
    access_token: user.access_token ?? undefined,
    refresh_token: user.refresh_token ?? undefined,
    expires_at: user.expires_at
  };
};

// Add other user-related functions as needed
