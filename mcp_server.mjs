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
// --- Imports for model loading ---
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- [MODIFIED] Configuration ---
// Read main server port and base path from environment variables
// These are inherited from the parent process (server.js)
const MAIN_SERVER_PORT = process.env.PORT || 8080;
let BASE_PATH = process.env.BASE_PATH || '/';

// Normalize BASE_PATH (ensure leading slash, remove trailing slash)
if (!BASE_PATH.startsWith('/')) {
  BASE_PATH = '/' + BASE_PATH;
}
if (BASE_PATH.endsWith('/') && BASE_PATH.length > 1) {
  BASE_PATH = BASE_PATH.slice(0, -1);
}

// Construct the API URL dynamically
const API_BASE_URL = `http://localhost:${MAIN_SERVER_PORT}${BASE_PATH}/api`;

const HTTP_PORT = process.env.MCP_PORT || 3000;
const TRANSPORT_MODE = process.env.MCP_TRANSPORT || "stdio"; // 'stdio' ou 'http'
// --- [END MODIFIED] ---


// --- Load UNS Model Manifest ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODEL_MANIFEST_PATH = path.join(__dirname, 'data/uns_model.json');
let unsModel = [];

try {
  const modelData = fs.readFileSync(MODEL_MANIFEST_PATH, 'utf8');
  unsModel = JSON.parse(modelData);
  console.error("✅ Successfully loaded UNS Model Manifest from data/uns_model.json");
} catch (err) {
  console.error("❌ WARNING: Could not load 'data/uns_model.json'. Model-querying tools will not work.", err.message);
}

/**
 * Creates and configures the MCP server instance.
 */
async function createMcpServer() {
  const server = new McpServer({
    name: "MQTT UNS Viewer Controller",
    version: "1.4.0", // Incremented version
    description: "A server to control and query the MQTT Unified Namespace web visualizer application. Includes model-aware search capabilities.",
  });

  // --- Model-Querying Tools ---

  server.registerTool(
    "get_model_definition",
    {
      title: "Get UNS Model Definition",
      description: "Searches the factory's Unified Namespace (UNS) Model Manifest for a specific concept or keyword (e.g., 'maintenance', 'workorder', 'temperature'). Returns the data schema, topic templates, and description for that concept.",
      inputSchema: {
        concept: z.string().describe("The concept or keyword to search for (e.g., 'maintenance', 'erp', 'vibration').")
      },
      outputSchema: { definitions: z.array(z.any()) }
    },
    async ({ concept }) => {
      if (unsModel.length === 0) {
        return { content: [{ type: "text", text: "Error: The UNS Model Manifest (uns_model.json) is not loaded." }], isError: true };
      }
      const lowerConcept = concept.toLowerCase();
      const results = unsModel.filter(model => 
        model.concept.toLowerCase().includes(lowerConcept) ||
        model.keywords.some(k => k.toLowerCase().includes(lowerConcept))
      );
      
      const output = { definitions: results };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  server.registerTool(
    "search_by_model",
    {
      title: "Search by Model (Structured Search)",
      description: "Performs a precise, structured search for MQTT messages. Use this AFTER `get_model_definition` to search for data matching a known model.",
      inputSchema: { 
        topic_template: z.string().describe("The topic template to search for. Use SQL LIKE syntax (e.g., '%/erp/workorder', 'stark_industries/%/torque')."),
        json_filter_key: z.string().optional().describe("The specific JSON key to filter inside the payload (e.g., 'status', 'priority')."),
        json_filter_value: z.string().optional().describe("The exact value the `json_filter_key` must match (e.g., 'RELEASED', 'HIGH').")
      },
      outputSchema: { results: z.array(z.any()) }
    },
    async ({ topic_template, json_filter_key, json_filter_value }) => {
      try {
        const body = {
          topic_template,
          json_filter_key,
          json_filter_value
        };
        const response = await axios.post(`${API_BASE_URL}/context/search/model`, body);
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


  // --- Existing Data-Retrieval Tools ---

  server.registerTool(
    "search_data",
    {
      title: "Search Topics and Payloads (Full-Text)",
      description: "Performs a simple full-text search for a keyword across all topic names and payload contents. This is a 'dumb' search. For precise, model-aware searches (e.g., find priority='HIGH'), use `get_model_definition` and `search_by_model` instead.",
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

  // --- Resources are now Tools ---
  
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



  return server;
}

/**
 * Main entry point.
 */
async function main() {
  // 1. Ensure the main web server (server.js) is running
  try {
    // [MODIFIED] Test the new dynamic URL
    await axios.get(`${API_BASE_URL}/config`); // Quick connection test
    console.log(`✅ MCP Server connected to main API at: ${API_BASE_URL}/config`);
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