import { mcpServerRegistry, McpServerConfig } from '../../config/mcp-servers.config';
import { mcpClientService, McpToolDefinition } from '../mcp/mcp.client';
import { stateManager } from '../agent/state.service';
import { toolsMap as nativeToolsMapConfig, ToolService } from '../../config/tools.config'; // Renamed to avoid conflict
import { toolService as dbToolService } from '../agent/tool.service'; // Import the DB tool service
import type { Tool } from '../../types/agent'; // Agent's internal Tool type
import { LangfuseSpanClient, LangfuseTraceClient } from 'langfuse';
import { v4 as uuidv4 } from 'uuid';

// This will combine native tools and dynamically loaded MCP tools
export const activeToolsMap: Record<string, ToolService> = { /* Will be populated dynamically */ };

class ToolRegistrationService {
  private isInitialized = false;

  // Helper to convert MCP inputSchema (JSON Schema) to a string instruction for the LLM
  private formatMcpInstruction(toolName: string, schema: Record<string, any>): string {
    let instruction = `To use the '${toolName}' tool, provide the following parameters in the payload as a JSON object:\n`;
    
    let actualProperties = schema.properties;
    let actualRequired = schema.required;

    // Check for the specific problematic structure where the actual schema is nested under an "inputSchema" key.
    if (
      schema.properties &&
      Object.keys(schema.properties).length === 1 &&
      schema.properties.inputSchema &&
      typeof schema.properties.inputSchema === 'object' &&
      schema.properties.inputSchema.properties // Check if the nested inputSchema has its own properties
    ) {
      const nestedSchema = schema.properties.inputSchema;
      actualProperties = nestedSchema.properties;
      actualRequired = nestedSchema.required || []; // Use required from nested schema if it exists, default to empty array
    }

    if (actualProperties && Object.keys(actualProperties).length > 0) {
      for (const [paramName, paramDetailsObj] of Object.entries(actualProperties)) {
        // Ensure paramDetailsObj is treated as an object, as it should be a JSON schema definition for a property
        const paramDetails = paramDetailsObj as Record<string, any>;
        instruction += `- \"${paramName}\": (type: ${paramDetails.type || 'any'}${paramDetails.description ? ", description: " + paramDetails.description : ''})${actualRequired?.includes(paramName) ? ' [required]' : ''}\n`;
      }
    } else {
      // This branch handles cases where schema.properties is null/undefined, or actualProperties is empty after the check.
      instruction += "This tool may not have explicitly defined parameters in its schema or uses a generic payload structure. Refer to its description or the tool may not require specific input fields.";
    }
    return instruction;
  }

  public async initializeTools(trace?: LangfuseTraceClient): Promise<void> {
    if (this.isInitialized) return;

    const initSpan = trace?.span({ name: 'tool_registration_initialization' });
    console.log('[ToolRegistrationService] Initializing tools...');

    const loadedTools: Tool[] = []; // Start with an empty array, will be populated from DB and MCP

    // 1. Register Native Tools from Database
    const nativeToolsSpan = initSpan?.span({ name: 'native_tool_registration' });
    try {
      const dbNativeTools = await dbToolService.getAvailableTools();
      console.log(`[ToolRegistrationService] Found ${dbNativeTools.length} native tools from database.`);
      for (const nativeTool of dbNativeTools) {
        loadedTools.push(nativeTool); // nativeTool already matches Agent's Tool type
        
        // Wire up the executor from the static config
        if (nativeToolsMapConfig[nativeTool.name]) {
          activeToolsMap[nativeTool.name] = nativeToolsMapConfig[nativeTool.name];
          console.log(`[ToolRegistrationService] Native tool '${nativeTool.name}' registered with its service.`);
        } else {
          console.warn(`[ToolRegistrationService] Service for native tool '${nativeTool.name}' not found in nativeToolsMapConfig.`);
        }
      }
      nativeToolsSpan?.end({ metadata: { success: true, count: dbNativeTools.length } });
    } catch (error) {
      console.error("[ToolRegistrationService] Failed to load native tools from database:", error);
      nativeToolsSpan?.end({ metadata: { error: String(error) } });
    }

    // 2. Discover and Register MCP Tools
    const mcpToolsSpan = initSpan?.span({ name: 'mcp_tool_discovery_registration' });
    console.log('[ToolRegistrationService] Starting MCP tool discovery...'); // Log start of MCP discovery

    for (const serverConfig of mcpServerRegistry) {
      const serverLogPrefix = `[ToolRegistrationService] MCP Server '${serverConfig.name}' (ID: ${serverConfig.id}):`;
      console.log(`${serverLogPrefix} Attempting to connect and list tools at ${serverConfig.address || serverConfig.command}...`);
      
      // if (serverConfig.enabled === false) continue; // Optional: if we add an enabled flag
      const serverSpan = mcpToolsSpan?.span({ name: `mcp_server_${serverConfig.id}`, input: serverConfig });
      try {
        const client = await mcpClientService.getClient(serverConfig, serverSpan as LangfuseSpanClient | undefined); // Changed getSession to getClient
        const mcpTools = await mcpClientService.listTools(client, serverConfig.id, serverSpan as LangfuseSpanClient | undefined); // Pass client instead of session
        console.log(`${serverLogPrefix} Found ${mcpTools.length} tool(s).`);

        for (const mcpTool of mcpTools) {
          const toolKey = `${serverConfig.id}/${mcpTool.name}`;
          console.log(`${serverLogPrefix} Registering tool '${mcpTool.name}' as '${toolKey}'.`);
          
          loadedTools.push({
            uuid: uuidv4(),
            name: toolKey, // e.g., "calculator_mcp_v1/add"
            description: mcpTool.description || `MCP tool ${mcpTool.name} from ${serverConfig.name}`,
            instruction: this.formatMcpInstruction(mcpTool.name, mcpTool.inputSchema),
            // category: 'mcp', // Optional
            // mcp_details: { // Store extra info if needed
            //   server_id: serverConfig.id,
            //   mcp_tool_name: mcpTool.name,
            //   input_schema: mcpTool.inputSchema
            // }
          });

          // Add to our combined toolsMap for execution
          activeToolsMap[toolKey] = {
            execute: async (action: string, payload: Record<string, any>, execSpan?: LangfuseSpanClient) => {
              // Here, 'action' from ToolUsePayload should be the pure MCP tool name, e.g., "add"
              // The toolKey (current_tool.name) is "calculator_mcp_v1/add"
              // The ai.service.act needs to pass the correct action.
              const mcpClientInstance = await mcpClientService.getClient(serverConfig, execSpan);

              // The payload received from ai.service.act includes conversation_uuid and potentially other agent-specific keys.
              // We must strip these out for MCP tools, sending only what's defined by the tool's schema.
              // The 'action' parameter here is the specific function of the MCP tool (e.g. firecrawl_scrape)
              // The 'payload' contains arguments for that function, PLUS agent-internal keys.

              // Assuming the LLM generates the correct payload structure for the MCP tool itself (excluding conversation_uuid etc.),
              // and ai.service.act adds conversation_uuid on top.
              const { conversation_uuid, ...mcpToolPayload } = payload;

              return mcpClientService.callTool(mcpClientInstance, action, mcpToolPayload, serverConfig.id, execSpan);
            }
          };
          console.log(`${serverLogPrefix} Tool '${toolKey}' added to activeToolsMap and loadedTools.`);
        }
        serverSpan?.end({ metadata: { success: true, tool_count: mcpTools.length } });
      } catch (error) {
        console.error(`${serverLogPrefix} Failed to register tools:`, error);
        serverSpan?.end({ metadata: { error: String(error) } });
        // Continue with other servers
      }
    }
    mcpToolsSpan?.end();

    stateManager.updateSession({ tools: loadedTools });
    this.isInitialized = true;
    initSpan?.end();
    console.log('[ToolRegistrationService] All tools initialized. Total registered:', loadedTools.length, 'Tools:', loadedTools.map(t => t.name));
  }
}

export const toolRegistrationService = new ToolRegistrationService(); 