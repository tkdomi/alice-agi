export interface McpServerConfig {
  id: string; // Unique identifier for this server config, e.g., "CalculatorService"
  name: string; // User-friendly name, e.g., "Online Calculator MCP"
  address?: string; // e.g., "http://localhost:3001/mcp" for http. Optional for stdio.
  transport_type: 'http' | 'stdio'; // Type of transport
  command?: string; // Command to execute for stdio transport (e.g., "python", "node", "/path/to/executable")
  args?: string[]; // Arguments for the command for stdio transport
  env?: Record<string, string>; // Optional environment variables for stdio transport
  enabled: boolean; // Optional: to easily toggle servers
  description?: string; // Optional: A brief description of the server
}

export const mcpServerRegistry: McpServerConfig[] = [
  {
    id: "4b6d88f3-d23d-4ece-8dc7-5c8a94ac0d38",
    name: "Firecrawl",
    transport_type: 'stdio',
    command: "/Users/overment/.nvm/versions/node/v22.11.0/bin/npx",
    args: ["-y", "firecrawl-mcp"],
    env: {
      "FIRECRAWL_API_KEY": "fc-...",
      "PATH": `/Users/overment/.nvm/versions/node/v22.11.0/bin:${process.env.PATH || ''}`
    },
    enabled: true,
    description: "Firecrawl server to search / scrape the web"
  }
  
  // {
  //   id: "local_script_mcp_v1",
  //   name: "Local Script MCP Server",
  //   address: "./scripts/my_mcp_server.py", // Path to the script, for reference or if used by command indirectly
  //   transport_type: 'stdio',
  //   command: "python3",
  //   args: ["./scripts/my_mcp_server.py", "--port", "0"], // Script path repeated in args for execution
  //   env: { "MY_VARIABLE": "my_value" },
  //   // enabled: true,
  //   // description: "An MCP server running as a local script via stdio."
  // },
  // Example for http:
  // {
  //   id: "http_calculator_v1",
  //   name: "HTTP Calculator MCP",
  //   address: "http://localhost:30002/mcp",
  //   transport_type: 'http',
  //   // enabled: true,
  //   // description: "A calculator MCP server accessible via HTTP."
  // }
]; 