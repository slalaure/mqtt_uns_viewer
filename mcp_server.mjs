/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// --- Imports (ESM) ---
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import axios from "axios";

// --- Configuration ---
const API_BASE_URL = "http://localhost:8080/api";
const HTTP_PORT = process.env.MCP_PORT || 3000;
const TRANSPORT_MODE = process.env.MCP_TRANSPORT || "stdio"; // 'stdio' or 'http'

/**
 * Creates and configures the MCP server instance.
 */
async function createMcpServer() {
  const server = new McpServer({
    name: "MQTT UNS Viewer Controller",
    version: "1.3.0",
    description: "A server to control and query the MQTT Unified Namespace web visualizer application.",
  });

  // --- Tools (Actions & Queries) ---
  // EVERYTHING is defined as a "Tool" to be visible to LM Studio.

  server.registerTool(
    "start_simulator",
    {
      title: "Start Simulator",
      description: "Starts the MQTT data simulator.",
      inputSchema: {},
      outputSchema: { status: z.any() }
    },
    async () => {
      try {
        const response = await axios.post(`${API_BASE_URL}/simulator/start`);
        const output = { status: response.data };
        return { 
          content: [{ type: "text", text: "Simulator started: " + JSON.stringify(output) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );

  server.registerTool(
    "stop_simulator",
     {
      title: "Stop Simulator",
      description: "Stops the MQTT data simulator.",
      inputSchema: {},
      outputSchema: { status: z.any() }
    },
    async () => {
      try {
        const response = await axios.post(`${API_BASE_URL}/simulator/stop`);
        const output = { status: response.data };
        return { 
          content: [{ type: "text", text: "Simulator stopped: " + JSON.stringify(output) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_latest_message",
    {
      title: "Get Latest Message",
      description: "Retrieves the most recent message for a single, specified MQTT topic.",
      inputSchema: { 
        topic: z.string().describe("The full MQTT topic name (e.g., 'stark_industries/malibu_facility/erp/workorder')")
      },
      outputSchema: { message: z.any() }
    },
    async ({ topic }) => {
      try {
        const encodedTopic = encodeURIComponent(topic);
        const response = await axios.get(`${API_BASE_URL}/context/topic/${encodedTopic}`);
        const output = { message: response.data };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_topic_history",
    {
      title: "Get Topic History",
      description: "Retrieves recent historical messages for a specified MQTT topic.",
      inputSchema: { 
        topic: z.string().describe("The full MQTT topic name to get history for."),
        limit: z.number().optional().describe("The maximum number of messages to return. Defaults to 20.")
      },
      outputSchema: { history: z.array(z.any()) }
    },
    async ({ topic, limit }) => {
      try {
        const encodedTopic = encodeURIComponent(topic);
        const url = limit 
          ? `${API_BASE_URL}/context/history/${encodedTopic}?limit=${limit}`
          : `${API_BASE_URL}/context/history/${encodedTopic}`;
        const response = await axios.get(url);
        const output = { history: response.data };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
      }
    }
  );

  // --- [MODIFIED] Resources are now Tools ---
  
  server.registerTool(
    "get_application_status",
    {
      title: "Get Application Status",
      description: "Provides a high-level overview of the application's status (MQTT connection, DB stats).",
      inputSchema: {}, // No input
      outputSchema: { status: z.any() }
    },
    async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/context/status`);
        const output = { status: response.data };
         return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_simulator_status",
    {
      title: "Get Simulator Status",
      description: "Gets the current status of the MQTT data simulator (running or stopped).",
      inputSchema: {}, // No input
      outputSchema: { status: z.any() }
    },
    async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/simulator/status`);
        const output = { status: response.data };
         return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );
  
  server.registerTool(
    "get_topics_list",
    {
      title: "Get All Topics (Flat List)",
      description: "Returns a flat list of all unique MQTT topics currently known to the application.",
      inputSchema: {}, // No input
      outputSchema: { topics: z.array(z.string()) }
    },
    async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/context/topics`);
        const output = { topics: response.data };
         return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_topics_tree",
    {
      title: "Get All Topics (Tree)",
      description: "Returns a hierarchical JSON tree of all unique MQTT topics known to the application.",
      inputSchema: {}, // No input
      outputSchema: { tree: z.any() }
    },
    async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/context/tree`);
        const output = { tree: response.data };
         return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );

  // --- full text search ---
  server.registerTool(
    "search_data",
    {
      title: "Search Topics and Payloads",
      description: "Searches for a keyword across all topic names and payload contents. Returns the latest message from matching topics.",
      inputSchema: { 
        keyword: z.string().describe("The keyword to search for (e.g., 'maintenance', 'temperature', 'error').")
      },
      outputSchema: { results: z.array(z.any()) }
    },
    async ({ keyword }) => {
      try {
        const encodedKeyword = encodeURIComponent(keyword);
        const response = await axios.get(`${API_BASE_URL}/context/search?q=${encodedKeyword}`);
        const output = { results: response.data };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
      }
    }
  );

  return server;
}

/**
 * Main entry point.
 */
async function main() {
  // 1. Ensure the main web server (server.js) is running
  try {
    await axios.get(`${API_BASE_URL}/config`); // Quick connection test
  } catch (error) {
    console.error("-------------------------------------------------------------------");
    console.error("❌ FATAL ERROR: Could not contact the main server API.");
    console.error(`Attempted to connect to: ${API_BASE_URL}/config`);
    console.error("Please ensure the main server (node server.js) is started and running before launching the MCP server.");
    console.error("-------------------------------------------------------------------");
    process.exit(1);
  }

  // 2. Create the MCP server
  const server = await createMcpServer();

  // 3. Choose and attach the transport
  if (TRANSPORT_MODE === "http") {
    // --- HTTP Streamable Mode ---
    const app = express();
    app.use(express.json());

    app.post("/mcp", async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.listen(HTTP_PORT, () => {
      console.log(`🤖 MCP Server (HTTP) started and listening on http://localhost:${HTTP_PORT}/mcp`);
    });

  } else {
    // --- Stdio Mode (default) ---
    console.error("🤖 Starting MCP server in stdio mode..."); // Log to stderr
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ MCP Server connected and listening via stdio."); // Log to stderr
  }
}

// Keep the process alive (useful for stdio)
if (TRANSPORT_MODE === 'stdio') {
  setInterval(() => {}, 1 << 30);
}

main();