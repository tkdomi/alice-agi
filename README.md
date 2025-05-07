# Alice AGI

<img src="https://cloud.overment.com/2024-12-02/alice_agi-dc8ca6a3-1.png" style="border-radius: 10px; border: 1px solid #888" width="150">

Alice AGI is an application that uses LLM (GPT-4o) to perform actions based on user queries, while using available tools and long-term memory.

> **⚠️ Important Notice**
>
> This is a personal project shared ONLY to demonstrate ideas and concepts. It is not intended to be an open-source assistant for active development or contributions. While discussions and idea exchanges are welcome in the Issues section, please note that this repository is for personal use. Feel free to explore and draw inspiration or create a fork, but **active development will remain personal.**
>
> 

## Installation

1. Clone the repository
2. Install dependencies using `bun install`
3. Create `.env` file based on `.env.example` and set your own values, especially `OPENAI_API_KEY` (Anthropic's Claude isn't fully supported yet)
4. Run the application using `bun run dev` — but before that, you need to run database migrations and seeds. Also, you need to set up the tools you want to use.

### Database, migrations & seeds

Alice AGI uses `SQLite` as a database with `DrizzleORM`. To create the database and run migrations, you can use the following commands:

```bash
bun generate
bun migrate
bun seed
```

You can check the database schema in `src/database/seed.ts` file to see what data is seeded.

Then you can start the application using `bun run dev`. 

## Required services

These are the services that are required to be set up before running the application:

- [OpenAI](https://platform.openai.com/api-keys): Set `OPENAI_API_KEY` in `.env` file.
- [Anthropic](https://console.anthropic.com/keys): Set `ANTHROPIC_API_KEY` in `.env` file.
- [Langfuse](https://cloud.langfuse.com): Set `LANGFUSE_API_KEY` in `.env` file.
- [Algolia](https://www.algolia.com/): Set `ALGOLIA_APP_ID`, `ALGOLIA_API_KEY` and `ALGOLIA_INDEX_NAME` in `.env` file.
- [Qdrant](https://qdrant.tech/): Set `QDRANT_INDEX`, `QDRANT_URL` and `QDRANT_API_KEY` in `.env` file.

> Note: You may not be able to run this app with new OpenAI/Anthropic accounts due to rate limits.

### Tools Configuration

By default, several tools are already set up in the seed.ts and tools.config.ts files. You can use them as examples and blueprints for creating your own tools or customizing existing ones to suit your needs.

### MCP Support (Tools)

You can remove all "native" tools defined in `/src/database/seed.ts` and instead rely on MCP Servers, which you can add in `src/config/mcp-servers.config.ts`. If you prefer, you may include both, as the list of tools is merged and the entire flow remains the same.

Here's an example of how you might configure an MCP server in `src/config/mcp-servers.config.ts`. Note that specific paths or environment variables (like `PATH` for `npx` if not globally available) might need adjustment for your own setup:

```typescript
// Example from src/config/mcp-servers.config.ts
{
  id: "a1b2c3d4-e5f6-7890-1234-567890abcdef", // This ID is typically a unique UUID
  name: "Filesystem MCP",
  transport_type: 'stdio',
  command: "npx", // or "bunx", "pnpx", etc.
  args: [
    "-y", // flag to auto-confirm installation if the package isn't present
    "@modelcontextprotocol/server-filesystem",
    "/path/to/your/target/directory" // e.g., "/Users/username/Documents" or "C:\Users\username\Files"
  ],
  // env: {
  //   // Example: If npx or the mcp server script requires specific PATH setup
  //   // "PATH": `/custom/path/to/node/bin:${process.env.PATH || ''}`
  // },
  enabled: true,
  description: "Filesystem MCP server for accessing local files in a specified directory."
}
```

#### Task Management

As you can see in the seed file, there is a need to set up `stages UUIDs` and `projects UUIDs`.
After setting env variables, you can get them by accessing `/api/tools/linear/states` and `/api/tools/linear/projects` endpoints and pasting them manually into the seed file or directly into the database.

```env
# Linear (linear.app/settings/api)
LINEAR_API_KEY=
LINEAR_TEAM_ID=          
LINEAR_DEFAULT_ASSIGNEE_ID=
```

#### Calendar
```env
# Google Calendar - Create OAuth2 app (console.cloud.google.com/apis/credentials)
# Enable Calendar API and configure OAuth consent screen
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=    
GOOGLE_REDIRECT_URI=     # Auth: /api/auth/google
```

#### Music
```env
# Spotify - Create OAuth2 app (developer.spotify.com/dashboard)
# Add redirect URI and configure app settings
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=   # Auth: /api/spotify/authorize
```

#### Communication
```env
# ElevenLabs (elevenlabs.io/settings/keys)
ELEVENLABS_API_KEY=

# Resend (resend.com/api-keys)
RESEND_API_KEY=
```

#### Web & Maps
```env
# Firecrawl (firecrawl.dev)
FIRECRAWL_API_KEY=

# Google Maps (console.cloud.google.com/apis/credentials)
GOOGLE_MAPS_API_KEY=
```

#### File Storage
```env
# Local file system - no configuration needed
# Files are stored in ./storage directory
```

#### Crypto
```env
# CoinGecko API - no key needed for basic usage
# Uses public API endpoints
```

Additional tools can be added by creating a new tool in the `src/services/tools` folder and adding it to the `src/config/tools.config.ts` file. To complete the setup, describe how to use the tool following the pattern of existing tools within the seed file at `src/database/seed.ts`.

## Concept

The idea of Alice AGI aims for simplicity - creating a system that executes tasks based on natural language commands. While not omnipotent, it leverages existing apps, services, and devices the user regularly interacts with. The system performs actions by combining available capabilities with its long-term memory of user preferences and patterns.

Currently, it supports these tools and actions:

  <img src="https://cloud.overment.com/2024-12-02/agi-tools-d65dee6e-7.png" width="600" style="border-radius: 6px; border: 1px solid #888; margin: 20px 0">

- Memory: supports storing and retrieving information
- Web ([Firecrawl](https://www.firecrawl.dev/)): supports searching the web & loading content from URLs
- Email ([Resend](https://resend.com/)): supports sending emails but only to verified addresses
- Linear ([Linear](https://linear.app/)): supports managing issues
- Calendar ([Google Calendar](https://calendar.google.com/)): supports managing calendar events within a single account
- Map ([Google Maps](https://www.google.com/maps)): supports finding places and directions
- Spotify ([Spotify](https://www.spotify.com/)): supports playing music and controlling playback
- File: supports reading, writing and uploading files
- Speech ([ElevenLabs](https://elevenlabs.io/)): supports text-to-speech
- Search ([Algolia](https://www.algolia.com/) and [Qdrant](https://qdrant.tech/)): supports searching through indexed content
- Crypto: supports checking prices of cryptocurrencies

During the chat, the Large Language Model (LLM) determines which tools to use and how.

## Main logic

The main logic has two modes: fast-track and thinking. If the query is classified as a fast-track query, the system will rely solely on LLM's knowledge and skills to answer. Otherwise, it will go through the thinking phase that involves planning tasks and actions.

  <img src="https://cloud.overment.com/2024-12-03/logic-005813bd-9.png" width="600" style="border-radius: 6px; border: 1px solid #888; margin: 20px 0">


## Interaction

Alice AGI is available at `http://localhost:8080`. The main endpoint is `/api/agi/chat`, which is compatible with OpenAI's chat completions API. Personally I use:

- [Alice App](https://heyalice.app/) for macOS / Windows
- Siri Shortcuts for iOS (iPhone and Apple Watch)

<img src="https://cloud.overment.com/2024-12-03/custom-74a4c1ab-d.png" width="600" style="border-radius: 6px; margin: 20px 0">

<img src="https://cloud.overment.com/2024-12-03/example-f3a8a69d-9.png" width="600" style="border-radius: 6px; margin: 20px 0">

<img src="https://cloud.overment.com/2024-12-03/shortcuts-82690e02-8.png" width="600" style="border-radius: 6px; margin: 20px 0">

## License

This repo is mainly for my personal use, but feel free to explore the code, get inspired by the concepts, and adapt them for your projects. Just don't copy the entire project with its original name—I want to avoid any confusion.