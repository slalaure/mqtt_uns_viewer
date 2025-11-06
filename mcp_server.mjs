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
// [NEW] Read the main app host from environment (for Docker networking)
const MAIN_APP_HOST = process.env.MAIN_APP_HOST || 'localhost';
const MAIN_SERVER_PORT = process.env.PORT || 8080;
let BASE_PATH = process.env.BASE_PATH || '/';

// --- [FIXED] Normalize BASE_PATH ---
// Ensure leading slash
if (!BASE_PATH.startsWith('/')) {
  BASE_PATH = '/' + BASE_PATH;
}
// Handle root path or remove trailing slash
if (BASE_PATH === '/') {
    BASE_PATH = ''; // Set to empty string for root
} else if (BASE_PATH.endsWith('/')) {
    BASE_PATH = BASE_PATH.slice(0, -1); // Remove trailing slash for non-root
}
// --- [END FIXED] ---

// [MODIFIED] Construct the API URL dynamically using MAIN_APP_HOST
const API_BASE_URL = `http://${MAIN_APP_HOST}:${MAIN_SERVER_PORT}${BASE_PATH}/api`;

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

// --- [NEW] Helper function for schema inference ---
/**
 * Infers a simple schema from an array of message objects.
 * @param {Array<Object>} messages - Array of { topic, payload, timestamp }
 * @returns {Object} A simple schema, e.g., { "id": "string", "value": "number" }
 */
function _inferSchema(messages) {
    const schema = {};
    let count = 0;
    for (const msg of messages) {
        if (count > 20) break; // Limit to 20 messages for inference
        try {
            const payload = JSON.parse(msg.payload); // msg.payload is a string
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;
            
            for (const [key, value] of Object.entries(payload)) {
                if (!schema[key]) {
                    schema[key] = typeof value;
                }
            }
            count++;
        } catch (e) { /* ignore non-json or parsing errors */ }
    }
    return schema;
}

// --- [NEW] Internal helper to get config for other tools ---
const getMapperConfigInternal = async () => {
    const response = await axios.get(`${API_BASE_URL}/mapper/config`);
    return response.data;
};

// --- [NEW] Internal helper to save config for other tools ---
const saveMapperConfigInternal = async (config) => {
    const response = await axios.post(`${API_BASE_URL}/mapper/config`, config);
    return response.data;
};


/**
 * Creates and configures the MCP server instance.
 */
async function createMcpServer() {
  const server = new McpServer({
    name: "MQTT UNS Viewer Controller",
    version: "1.6.0", // Incremented version
    description: "A server to control and query the MQTT Unified Namespace web visualizer application. Includes model-aware search capabilities.",
  });

  // --- [NEW] Model-Querying Tools ---

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
        (model.keywords && model.keywords.some(k => k.toLowerCase().includes(lowerConcept)))
      );
      
      const output = { definitions: results };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  server.registerTool(
    "search_uns_concept",
    {
      title: "Search by UNS Concept (Semantic Search)",
      description: "Performs a precise, structured search for MQTT messages based on a known UNS concept and specific data filters. This is the primary tool for finding data.",
      inputSchema: { 
        concept: z.string().describe("The UNS concept to search for (e.g., 'Work Order', 'Maintenance Request', 'Machine Telemetry')."),
        filters: z.record(z.string()).optional().describe("An object of key-value pairs to filter the JSON payload (e.g., {\"status\": \"RELEASED\", \"priority\": \"HIGH\"}).")
      },
      outputSchema: { results: z.array(z.any()) }
    },
    async ({ concept, filters }) => {
      try {
        // 1. Find the model definition
        if (unsModel.length === 0) {
            return { content: [{ type: "text", text: "Error: The UNS Model Manifest (uns_model.json) is not loaded." }], isError: true };
        }
        const lowerConcept = concept.toLowerCase();
        const model = unsModel.find(m => m.concept.toLowerCase().includes(lowerConcept) || (m.keywords && m.keywords.some(k => k.toLowerCase().includes(lowerConcept))));
        
        if (!model) {
            return { content: [{ type: "text", text: `Error: Concept '${concept}' not found in UNS Model Manifest.` }], isError: true };
        }
        
        const topic_template = model.topic_template;

        // 2. Call the newly modified API
        const body = {
          topic_template,
          filters // Pass the filters object directly
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

  server.registerTool(
    "infer_schema",
    {
      title: "Infer Schema from Topic",
      description: "Analyzes recent messages for a given topic pattern (e.g., 'stark_industries/security/%') and returns the inferred JSON payload schema.",
      inputSchema: { 
        topic_pattern: z.string().describe("The topic pattern to analyze, using SQL LIKE syntax (e.g., 'stark_industries/security/%').")
      },
      outputSchema: { inferred_schema: z.record(z.string()) }
    },
    async ({ topic_pattern }) => {
        try {
            // Use the search/model endpoint to get recent messages for the pattern
            const response = await axios.post(`${API_BASE_URL}/context/search/model`, { topic_template: topic_pattern });
            const messages = response.data; // This is an array of { topic, payload, timestamp }
            
            if (!messages || messages.length === 0) {
                return { content: [{ type: "text", text: "No messages found for this pattern." }] };
            }

            // Use the helper function to infer the schema
            const schema = _inferSchema(messages);
            const output = { inferred_schema: schema };
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


  // --- [MODIFIED] Data-Retrieval Tools ---

  server.registerTool(
    "search_data_fulltext",
    {
      title: "Search (Full-Text)",
      description: "Performs a simple full-text search for a keyword across all topic names and payload contents. This is a 'dumb' search. For precise, model-aware searches, use `search_uns_concept`.",
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
    "get_latest_message",
    {
      title: "Get Latest Message",
      description: "Retrieves the most recent message for a single, *exact* MQTT topic.",
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
      description: "Retrieves recent historical messages for a specified *exact* MQTT topic.",
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

  // --- [NEW] Admin & Simulator Tools ---

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
    "prune_topic_history",
    {
      title: "Prune Topic History",
      description: "Deletes messages from the database that match a specific topic pattern (e.g., 'stark_industries/rd_lab_03/#'). Use with caution.",
      inputSchema: {
        topic_pattern: z.string().describe("The topic pattern to prune, using MQTT wildcards (+, #).")
      },
      outputSchema: { success: z.boolean(), count: z.number() }
    },
    async ({ topic_pattern }) => {
        try {
            const response = await axios.post(`${API_BASE_URL}/context/prune-topic`, { topicPattern: topic_pattern });
            const output = response.data;
            return {
              content: [{ type: "text", text: `Prune successful. Deleted ${output.count} entries.` }],
              structuredContent: output
            };
        } catch (error) {
            const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
            return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
        }
    }
  );

  server.registerTool(
    "get_mapper_config",
    {
      title: "Get Mapper Configuration",
      description: "Retrieves the entire (JSON) configuration for the Topic Mapper engine, including all versions and rules.",
      inputSchema: {},
      outputSchema: { config: z.any() }
    },
    async () => {
        try {
            // Use internal helper
            const output = await getMapperConfigInternal();
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
  
  // --- [REMOVED] 'save_mapper_config' tool. It was too complex and error-prone for the LLM. ---

  
  // --- [MODIFIED] Smart tool to add/update a mapper rule ---
  server.registerTool(
    "update_mapper_rule",
    {
      title: "Update Mapper Rule",
      description: "Adds or updates a mapping rule. This tool handles the JSON modification safely. It adds a new target to an existing source rule, or creates a new rule if the source doesn't exist.",
      inputSchema: { 
        sourceTopic: z.string().describe("The exact source topic to match (e.g., 'stark_industries/malibu_facility/mes/oee')."),
        targetTopic: z.string().describe("The destination topic to publish to (e.g., 'UNS/malibu/kpi/oee_percent')."),
        
        // --- [ THIS IS THE KEY CHANGE ] ---
        targetCode: z.string().describe(
          "The ASYNC JavaScript code for the transformation. " +
          "You have access to 'msg' (msg.topic, msg.payload) and 'db' (await db.all(sql), await db.get(sql)). " +
          "SQL must be read-only (SELECT). " +
          "IMPORTANT for date queries: The `timestamp` column is `TIMESTAMP WITH TIME ZONE`. " +
          "To query relative time, use SQL-native functions like `timestamp >= (now() - INTERVAL '20 second')`. " +
          "DO NOT pass JavaScript Date strings for comparison. " +
          "Example: 'const row = await db.get(`SELECT AVG(CAST(payload->>\\\'value\\\' AS DOUBLE)) as avg_val FROM mqtt_events WHERE topic = \\\'${msg.topic}\\\' AND timestamp >= (now() - INTERVAL '10 minute')`); msg.payload.avg = row.avg_val; return msg;'"
        )
        // --- [ END OF CHANGE ] ---
      },
      outputSchema: { status: z.string(), message: z.string() }
    },
    async ({ sourceTopic, targetTopic, targetCode }) => {
        try {
            // 1. Get the current config
            const config = await getMapperConfigInternal();
            
            // 2. Find the active version
            const activeVersion = config.versions.find(v => v.id === config.activeVersionId);
            if (!activeVersion) {
                return { content: [{ type: "text", text: "Error: Could not find active mapper version." }], isError: true };
            }

            // 3. Find the rule for the source topic, or create it
            let rule = activeVersion.rules.find(r => r.sourceTopic.trim() === sourceTopic.trim());
            if (!rule) {
                rule = {
                    sourceTopic: sourceTopic.trim(),
                    targets: []
                };
                activeVersion.rules.push(rule);
            }

            // 4. [FIX] Sanitize code from LLM to prevent syntax errors
            // This replaces the invisible non-breaking space (U+000A) with a regular space
            const sanitizedCode = targetCode
                .replace(/\u00A0/g, " ") 
                .trim();
            
            // 5. Create the new target
            const newTarget = {
                id: `tgt_${Date.now()}`,
                enabled: true,
                outputTopic: targetTopic.trim(),
                mode: "js",
                code: sanitizedCode // Use sanitized code
            };
            
            // 6. Add the new target to the rule
            rule.targets.push(newTarget);

            // 7. Save the *entire* modified config object
            const saveResult = await saveMapperConfigInternal(config);
            
            return {
              content: [{ type: "text", text: `Mapper rule updated successfully for source ${sourceTopic}.` }],
              structuredContent: saveResult
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
    // [MODIFIED] Test the new dynamic URL
    await axios.get(`${API_BASE_URL}/config`); // Quick connection test
    console.error(`✅ MCP Server connected to main API at: ${API_BASE_URL}/config`);
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