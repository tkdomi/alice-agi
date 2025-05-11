import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'; 
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'; 

// Refined StdioClientTransportOptions
interface StdioClientTransportOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  // Potentially other options like 'cwd' if the SDK supports them
}

import type { McpServerConfig } from '../../config/mcp-servers.config';
import { LangfuseSpanClient } from 'langfuse';

// Interface for the structure of a tool definition returned by MCP server's list_tools()
// Refer to MCP SDK documentation for the exact structure.
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, any>; // This is likely a JSON schema
  // Add other properties if provided by list_tools, e.g., outputSchema
}

class McpClientService {
  // Store McpClient instances which manage their own sessions
  private clients: Map<string, McpClient> = new Map();
  private connectingPromises: Map<string, Promise<McpClient>> = new Map();

  private async establishConnection(serverConfig: McpServerConfig, span?: LangfuseSpanClient): Promise<McpClient> {
    const connectSpan = span?.span({
      name: 'mcp_connect',
      input: serverConfig,
      metadata: { server_id: serverConfig.id, address: serverConfig.address || `${serverConfig.command} ${serverConfig.args?.join(' ')}` }
    });

    console.log(`[McpClientService] Establishing connection for ${serverConfig.id} using ${serverConfig.transport_type}`);

    try {
      let transport;
      if (serverConfig.transport_type === 'stdio') {
        if (!serverConfig.command) {
          throw new Error('Stdio transport type selected, but no command provided in serverConfig.');
        }
        // Using refined options type.
        // CRITICAL: Verify how 'env' and other options like 'cwd' are actually passed to StdioClientTransport via SDK docs/types.
        // If the SDK's StdioClientTransport constructor doesn't directly accept 'env', this might need adjustment
        // or 'env' might be handled differently (e.g., ambiently).
        const transportOptions: StdioClientTransportOptions = {
          command: serverConfig.command,
          args: serverConfig.args || [],
          ...(serverConfig.env && { env: serverConfig.env }),
        };
        console.log(`[McpClientService] StdioTransport options for ${serverConfig.id}:`, transportOptions);
        // Assuming StdioClientTransport constructor can take an object matching StdioClientTransportOptions.
        // If not, the 'as any' might be needed if the SDK's typing is restrictive or different.
        transport = new StdioClientTransport(transportOptions);
      } else if (serverConfig.transport_type === 'http') {
        if (!serverConfig.address) {
          throw new Error('HTTP transport type selected, but no address provided in serverConfig.');
        }
        // TODO: Implement HTTP transport using StreamableHTTPClientTransport or similar from SDK
        // transport = new StreamableHTTPClientTransport(new URL(serverConfig.address));
        console.warn(`[McpClientService] HTTP transport connection for ${serverConfig.id} is conceptual and needs SDK implementation.`);
        throw new Error('HTTP transport for MCP client not yet implemented in this service.');
      } else {
        connectSpan?.end({ metadata: { error: `Unsupported MCP transport type: ${serverConfig.transport_type}` } });
        throw new Error(`Unsupported MCP transport type: ${serverConfig.transport_type} for server ${serverConfig.id}`);
      }

      const client = new McpClient({
        name: `${serverConfig.name}-client`,
        version: '1.0.0' // Or your app's version
      });

      console.log(`[McpClientService] Connecting client for ${serverConfig.id}...`);
      await client.connect(transport);
      console.log(`[McpClientService] Client connected for ${serverConfig.id}. Initializing session features (like list_tools)...`);
      
      // The MCP SDK Client object itself handles the session and initialization.
      // Methods like listTools, callTool are directly on the client object.
      // The initialize() method might be called internally by client.connect() or not be needed explicitly by us.
      // If there's an explicit initialize method on the McpClient that's separate from connect, call it here.
      // await client.initialize(); // If required by the SDK after connect

      connectSpan?.end({ metadata: { success: true } });
      return client;
    } catch (error) {
      console.error(`[McpClientService] Failed to connect/initialize MCP client for ${serverConfig.id}:`, error);
      connectSpan?.end({ metadata: { error: String(error) } });
      this.connectingPromises.delete(serverConfig.id); 
      throw error;
    }
  }

  public async getClient(serverConfig: McpServerConfig, span?: LangfuseSpanClient): Promise<McpClient> {
    if (this.clients.has(serverConfig.id)) {
      return this.clients.get(serverConfig.id)!;
    }

    if (this.connectingPromises.has(serverConfig.id)) {
      return this.connectingPromises.get(serverConfig.id)!;
    }

    const connectPromise = this.establishConnection(serverConfig, span);
    this.connectingPromises.set(serverConfig.id, connectPromise);

    try {
      const client = await connectPromise;
      this.clients.set(serverConfig.id, client);
      return client;
    } finally {
      this.connectingPromises.delete(serverConfig.id);
    }
  }

  // McpClient now acts as the session, so methods take McpClient
  public async listTools(client: McpClient, serverId: string, span?: LangfuseSpanClient): Promise<McpToolDefinition[]> {
    const listToolsSpan = span?.span({ name: 'mcp_list_tools', metadata: { server_id: serverId } });
    try {
      console.log(`[McpClientService] Listing tools for ${serverId}...`);
      // The SDK example shows client.listPrompts(), client.listResources(). 
      // Assuming client.listTools() exists and follows a similar pattern.
      // The structure of the response { tools: [...] } was from the Python example; TS might differ.
      // Let's assume it returns an object with a 'tools' property or an array directly.
      // Assuming client.listTools() exists on McpClient and returns a compatible structure.
      const result: { tools: McpToolDefinition[] } | McpToolDefinition[] = await client.listTools(); 
      
      // Adapt based on actual result structure from SDK:
      let tools: McpToolDefinition[] = [];
      if (result && 'tools' in result && Array.isArray(result.tools)) { // Check if 'tools' property exists
        tools = result.tools as McpToolDefinition[];
      } else if (Array.isArray(result)) { // If listTools() directly returns an array
        tools = result as McpToolDefinition[];
      } else {
        console.warn(`[McpClientService] Unexpected listTools response structure for ${serverId}:`, result);
      }
      
      console.log(`[McpClientService] Found ${tools.length} tools for ${serverId}:`, tools.map(t => t.name));
      listToolsSpan?.end({ output: tools.map(t => t.name) });
      return tools;
    } catch (error) {
      console.error(`[McpClientService] Failed to list tools for MCP server ${serverId}:`, error);
      listToolsSpan?.end({ metadata: { error: String(error) } });
      throw error;
    }
  }

  public async callTool(
    client: McpClient,
    toolName: string,
    payload: Record<string, any>,
    serverId: string,
    span?: LangfuseSpanClient
  ): Promise<any> {
    const callToolSpan = span?.span({
      name: 'mcp_call_tool',
      input: { toolName, payload },
      metadata: { server_id: serverId, tool_name: toolName }
    });
    try {
      console.log(`[McpClientService] Calling tool '${toolName}' on ${serverId} with payload:`, payload);
      const result = await client.callTool({ name: toolName, arguments: payload }); // SDK example is client.callTool({ name: ..., arguments: ... })
      console.log(`[McpClientService] Result from tool '${toolName}' on ${serverId}:`, result);
      callToolSpan?.end({ output: result.content }); // Assuming result.content is standard from MCP docs
      return result.content; 
    } catch (error) {
      console.error(`[McpClientService] Failed to call tool ${toolName} on MCP server ${serverId}:`, error);
      callToolSpan?.end({ metadata: { error: String(error) } });
      throw error;
    }
  }

  public async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      try {
        console.log(`[McpClientService] Disconnecting client for ${serverId}...`);
        // Assuming a close method exists on the McpClient instance as per standard client patterns and MCP lifecycle.
        await client.close(); 
        console.log(`[McpClientService] Client disconnected for ${serverId}.`);
      } catch (error) {
        console.error(`[McpClientService] Error disconnecting from MCP server ${serverId}:`, error);
      }
      this.clients.delete(serverId);
    }
    this.connectingPromises.delete(serverId);
  }

  public async disconnectAll(): Promise<void> {
    const allServerIds = Array.from(this.clients.keys());
    for (const serverId of allServerIds) {
      await this.disconnect(serverId);
    }
  }
}

export const mcpClientService = new McpClientService(); 