import {SpotifyApi, AccessToken} from '@spotify/web-api-ts-sdk';
import {LangfuseSpanClient} from 'langfuse';
import {z} from 'zod';
import {stateManager} from '../agent/state.service';
import {TokenResponse, SimplifiedSearchResults} from '../../types/tools/spotify';
import {prompt as spotifyPlayPrompt} from '../../prompts/tools/spotify.play';
import {completion} from '../common/llm.service';
import {DocumentMetadata} from '../../types/document';
import {documentService} from '../agent/document.service';
import type {DocumentType} from '../agent/document.service';
import {updateSpotifyTokens, getSpotifyTokens} from '../common/user.service';

const envSchema = z.object({
  SPOTIFY_CLIENT_ID: z.string(),
  SPOTIFY_CLIENT_SECRET: z.string(),
  SPOTIFY_ACCESS_TOKEN: z.string().optional(),
  SPOTIFY_REFRESH_TOKEN: z.string().optional(),
  SPOTIFY_TOKEN_EXPIRY: z.string().optional()
});

interface ToolResponse {
  text: string;
  metadata: Partial<DocumentMetadata>;
  additional_data?: unknown;
}

const spotifyService = {
  createAccessToken: (access_token: string, refresh_token: string, expires_in: number): AccessToken => ({
    access_token,
    token_type: 'Bearer',
    expires_in,
    expires: Date.now() + expires_in * 1000,
    refresh_token
  }),

  refreshAccessToken: async (client_id: string, client_secret: string, refresh_token: string): Promise<TokenResponse> => {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh token: ${response.statusText}`);
    }

    return response.json();
  },

  exchangeCode: async (code: string, user_uuid: string): Promise<void> => {
    const env = envSchema.parse(process.env);
    const redirect_uri = `${process.env.APP_URL}/api/auth/spotify/callback`;
    
    const params = new URLSearchParams({
        code,
        redirect_uri,
        grant_type: 'authorization_code'
    });

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
            },
            body: params
        });

        if (!response.ok) {
            const error_data = await response.json().catch(() => ({ error: response.statusText }));
            throw new Error(`Failed to exchange code for tokens: ${error_data.error || response.statusText}`);
        }

        const data = await response.json();
        await updateSpotifyTokens(
            user_uuid, 
            data.access_token, 
            data.refresh_token,
            data.expires_in
        );
    } catch (error) {
        throw error;
    }
  },

  getAccessToken: async (user_uuid: string): Promise<AccessToken> => {
    const tokens = await getSpotifyTokens(user_uuid);
    
    if (!tokens?.refresh_token) {
      throw new Error('No refresh token available');
    }

    const is_token_expired = !tokens.access_token || 
      (tokens.expires_at && new Date() >= tokens.expires_at);

    if (!is_token_expired && tokens.access_token) {
      return spotifyService.createAccessToken(
        tokens.access_token,
        tokens.refresh_token,
        Math.floor((tokens.expires_at!.getTime() - Date.now()) / 1000)
      );
    }

    const env = envSchema.parse(process.env);
    const refreshed_tokens = await spotifyService.refreshAccessToken(
      env.SPOTIFY_CLIENT_ID,
      env.SPOTIFY_CLIENT_SECRET,
      tokens.refresh_token
    );

    await updateSpotifyTokens(
      user_uuid,
      refreshed_tokens.access_token,
      refreshed_tokens.refresh_token ?? tokens.refresh_token,
      refreshed_tokens.expires_in
    );

    return spotifyService.createAccessToken(
      refreshed_tokens.access_token,
      refreshed_tokens.refresh_token ?? tokens.refresh_token,
      refreshed_tokens.expires_in
    );
  },

  createClient: async (user_uuid: string): Promise<SpotifyApi> => {
    const env = envSchema.parse(process.env);
    const tokens = await getSpotifyTokens(user_uuid);
    
    if (!tokens?.access_token || !tokens?.refresh_token) {
      throw new Error('Spotify tokens not found for user');
    }

    const access_token = await spotifyService.getAccessToken(user_uuid);

    return SpotifyApi.withAccessToken(env.SPOTIFY_CLIENT_ID, access_token);
  },

  search: async (query: string, types: Array<'album' | 'artist' | 'playlist' | 'track'>, limit: number = 5, span?: LangfuseSpanClient): Promise<SimplifiedSearchResults> => {
    try {
      const state = stateManager.getState();
      if (!state.config.user_uuid) {
        throw new Error('User UUID is required for Spotify operations');
      }

      const spotify_client = await spotifyService.createClient(state.config.user_uuid);
      const res = await spotify_client.search(query, types, undefined, limit);
      
      const mapArtists = (artists: any[]) => artists.map(artist => artist.name).join(', ');

      return {
        tracks: (res.tracks?.items ?? [])
          .filter(track => track !== null)
          .map(track => ({
            name: track.name,
            uri: track.uri,
            artists: mapArtists(track.artists),
            album: track.album.name
          })),

        playlists: (res.playlists?.items ?? [])
          .filter(playlist => playlist !== null)
          .map(playlist => ({
            name: playlist.name,
            uri: playlist.uri,
            owner: playlist.owner.display_name
          })),

        albums: (res.albums?.items ?? [])
          .filter(album => album !== null)
          .map(album => ({
            name: album.name,
            uri: album.uri,
            artists: mapArtists(album.artists),
            total_tracks: album.total_tracks
          }))
      };
    } catch (error) {
      span?.event({
        name: 'spotify_search_error',
        input: {query, types},
        output: {error: error instanceof Error ? error.message : 'Unknown error'},
        level: 'ERROR'
      });
      throw error;
    }
  },

  getActiveDevice: async (): Promise<string> => {
    const state = stateManager.getState();
    if (!state.config.user_uuid) {
      throw new Error('User UUID is required for Spotify operations');
    }

    const spotify_client = await spotifyService.createClient(state.config.user_uuid);
    const devices = await spotify_client.player.getAvailableDevices();

    if (!devices.devices.length) {
      throw new Error('No Spotify devices found. Please open Spotify on any device.');
    }

    const active_device = devices.devices.find(device => device.is_active);
    const device_id = active_device?.id ?? devices.devices[0].id;

    if (!device_id) {
      throw new Error('No active Spotify device found. Please start playing on any device.');
    }

    return device_id;
  },

  playTrack: async (uri: string, span?: LangfuseSpanClient): Promise<void> => {
    try {
      const state = stateManager.getState();
      if (!state.config.user_uuid) {
        throw new Error('User UUID is required for Spotify operations');
      }

      const spotify_client = await spotifyService.createClient(state.config.user_uuid);
      const devices = await spotify_client.player.getAvailableDevices();
      const device_id = await spotifyService.getActiveDevice();

      await spotify_client.player.startResumePlayback(device_id, undefined, [uri]);

      span?.event({
        name: 'spotify_playback',
        input: {
          content_type: 'track',
          uri,
          device_id
        },
        output: {
          status: 'success',
          device_name: devices.devices.find(d => d.id === device_id)?.name
        }
      });
    } catch (error) {
      span?.event({
        name: 'spotify_playback_error',
        input: {
          content_type: 'track',
          uri
        },
        output: {
          error: error instanceof Error ? error.message : 'Unknown error',
          error_code: error instanceof Error ? error.name : 'UnknownError'
        },
        level: 'ERROR'
      });
      throw error;
    }
  },

  playPlaylist: async (uri: string): Promise<void> => {
    const state = stateManager.getState();
    if (!state.config.user_uuid) {
      throw new Error('User UUID is required for Spotify operations');
    }

    const spotify_client = await spotifyService.createClient(state.config.user_uuid);
    const device_id = await spotifyService.getActiveDevice();

    await spotify_client.player.startResumePlayback(device_id, uri);
  },

  playAlbum: async (uri: string): Promise<void> => {
    const state = stateManager.getState();
    if (!state.config.user_uuid) {
      throw new Error('User UUID is required for Spotify operations');
    }

    const spotify_client = await spotifyService.createClient(state.config.user_uuid);
    const device_id = await spotifyService.getActiveDevice();

    await spotify_client.player.startResumePlayback(device_id, uri);
  },

  select: async (results: SimplifiedSearchResults, query: string, span?: LangfuseSpanClient): Promise<string> => {
    try {
      const state = stateManager.getState();

      const selection_generation = span?.generation({
        name: 'spotify_track_selection',
        input: {
          query,
          available_results: {
            tracks: results.tracks.map(t => ({name: t.name, artists: t.artists})),
            playlists: results.playlists.map(p => ({name: p.name, owner: p.owner})),
            albums: results.albums.map(a => ({name: a.name, artists: a.artists}))
          }
        },
        model: state.config.model
      });

      const decision = await completion.object<{result: string}>({
        model: state.config.model ?? 'gpt-4o',
        messages: [
          {role: 'system', content: spotifyPlayPrompt({results: JSON.stringify(results)})},
          {role: 'user', content: query}
        ],
        temperature: 0,
        user: {
          uuid: state.config.user_uuid ?? '',
          name: state.profile.user_name
        }
      });

      const selected_item = results[`${decision.result.split(':')[1]}s`]?.find(item => item.uri === decision.result);

      await selection_generation?.end({
        output: {
          selected_uri: decision.result,
          content_type: decision.result.split(':')[1],
          selected_item
        }
      });

      span?.event({
        name: 'spotify_content_selected',
        input: {
          query,
          available_results: {
            tracks: results.tracks.length,
            playlists: results.playlists.length,
            albums: results.albums.length
          }
        },
        output: {
          selected_uri: decision.result,
          content_type: decision.result.split(':')[1],
          selected_item
        }
      });

      return decision.result;
    } catch (error) {
      span?.event({
        name: 'spotify_selection_error',
        input: {query},
        output: {error: error instanceof Error ? error.message : 'Unknown error'},
        level: 'ERROR'
      });
      throw error;
    }
  },

  playMusic: async (query: string, conversation_uuid: string, span?: LangfuseSpanClient): Promise<DocumentType> => {
    try {
      const search_results = await spotifyService.search(query, ['track', 'playlist', 'album'], 15, span);

      if (!search_results.tracks.length && !search_results.playlists.length && !search_results.albums.length) {
        span?.event({
          name: 'spotify_no_results',
          input: {query}
        });
        return documentService.createDocument({
          conversation_uuid,
          source_uuid: conversation_uuid,
          text: 'No tracks, playlists, or albums found for the given query.',
          metadata_override: {
            type: 'audio',
            source: 'spotify'
          }
        });
      }

      const spotify_uri = await spotifyService.select(search_results, query, span);

      if (spotify_uri === 'no match') {
        span?.event({
          name: 'spotify_no_match',
          input: {query}
        });
        return documentService.createDocument({
          conversation_uuid,
          source_uuid: conversation_uuid,
          text: 'No suitable track, playlist, or album found for the given query.',
          metadata_override: {
            type: 'audio',
            source: 'spotify'
          }
        });
      }

      const [_, content_type, content_id] = spotify_uri.split(':');
      const response = await spotifyService.handleContentPlay(content_type, spotify_uri, search_results, span);

      span?.event({
        name: 'spotify_play_success',
        input: {
          query,
          content_type,
          uri: spotify_uri
        },
        output: {
          content_name: response.metadata.name,
          content_description: response.metadata.description,
          response_text: response.text
        }
      });

      return documentService.createDocument({
        conversation_uuid,
        source_uuid: conversation_uuid,
        text: response.text,
        metadata_override: {
          type: 'audio',
          source: 'spotify',
          ...response.metadata
        }
      });
    } catch (error) {
      span?.event({
        name: 'spotify_play_error',
        input: {query},
        output: {error: error instanceof Error ? error.message : 'Unknown error'},
        level: 'ERROR'
      });
      return documentService.createDocument({
        conversation_uuid,
        source_uuid: conversation_uuid,
        text: `Failed to play music: ${error instanceof Error ? error.message : 'Unknown error'}`,
        metadata_override: {
          type: 'audio',
          source: 'spotify'
        }
      });
    }
  },

  handleContentPlay: async (content_type: string, uri: string, search_results: SimplifiedSearchResults, span?: LangfuseSpanClient): Promise<ToolResponse> => {
    switch (content_type) {
      case 'track': {
        await spotifyService.playTrack(uri, span);
        const selected_track = search_results.tracks.find(track => track.uri === uri);
        return {
          text: `Now playing: "${selected_track?.name}" by ${selected_track?.artists}`,
          metadata: {
            name: selected_track?.name,
            description: `Track by ${selected_track?.artists}`
          }
        };
      }

      case 'playlist': {
        await spotifyService.playPlaylist(uri);
        const selected_playlist = search_results.playlists.find(playlist => playlist.uri === uri);
        return {
          text: `Now playing playlist: "${selected_playlist?.name}" by ${selected_playlist?.owner}`,
          metadata: {
            name: selected_playlist?.name,
            description: `Playlist by ${selected_playlist?.owner}`
          }
        };
      }

      case 'album': {
        await spotifyService.playAlbum(uri);
        const selected_album = search_results.albums.find(album => album.uri === uri);
        return {
          text: `Now playing album: "${selected_album?.name}" by ${selected_album?.artists}`,
          metadata: {
            name: selected_album?.name,
            description: `Album by ${selected_album?.artists}`
          }
        };
      }

      default:
        return {
          text: `Unsupported content type: ${content_type}`,
          metadata: {}
        };
    }
  },

  searchMusic: async (query: string, conversation_uuid: string, span?: LangfuseSpanClient): Promise<DocumentType> => {
    try {
      const search_results = await spotifyService.search(query, ['track', 'playlist', 'album'], 15, span);
      
      let content = 'Spotify Search Results (if you need to play music, pick one of the results in the next action you need to take):\n\n';

      if (search_results.tracks.length) {
        content += '🎵 Tracks:\n';
        search_results.tracks.forEach((track, i) => {
          content += `${i + 1}. "${track.name}" by ${track.artists} from ${track.album}\n`;
        });
        content += '\n';
      }

      if (search_results.albums.length) {
        content += '💿 Albums:\n';
        search_results.albums.forEach((album, i) => {
          content += `${i + 1}. "${album.name}" by ${album.artists} (${album.total_tracks} tracks)\n`;
        });
        content += '\n';
      }

      if (search_results.playlists.length) {
        content += '📑 Playlists:\n';
        search_results.playlists.forEach((playlist, i) => {
          content += `${i + 1}. "${playlist.name}" by ${playlist.owner}\n`;
        });
      }

      return documentService.createDocument({
        conversation_uuid,
        source_uuid: conversation_uuid ?? 'unknown',
        text: search_results.tracks.length || search_results.playlists.length || search_results.albums.length
          ? content.trim()
          : 'No results found for the given query.',
        metadata_override: {
          type: 'audio',
          source: 'spotify',
          description: `Search results for: ${query}`
        }
      });
    } catch (error) {
      span?.event({
        name: 'spotify_search_error',
        input: {query, types: ['track', 'playlist', 'album']},
        output: {error: error instanceof Error ? error.message : 'Unknown error'},
        level: 'ERROR'
      });
      return documentService.createDocument({
        conversation_uuid,
        source_uuid: conversation_uuid,
        text: `Failed to search music: ${error instanceof Error ? error.message : 'Unknown error'}`,
        metadata_override: {
          type: 'audio',
          source: 'spotify'
        }
      });
    }
  },

  execute: async (action: string, payload: any, span?: LangfuseSpanClient) => {
    const state = stateManager.getState();

    span?.event({
      name: 'spotify_tool',
      input: { action, query: payload.query, conversation_uuid: state.config.conversation_uuid },
      output: { success: true, action_executed: action }
    });

    if (action === 'play_music') {
      return spotifyService.playMusic(payload.query, state.config.conversation_uuid ?? 'unknown', span);
    }
    if (action === 'search_music') {
      return spotifyService.searchMusic(payload.query, state.config.conversation_uuid ?? 'unknown', span);
    }

    throw new Error(`Unknown action: ${action}`);
  }
};

export {spotifyService};
