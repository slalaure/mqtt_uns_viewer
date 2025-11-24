/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
  
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

// ---  Configuration ---
//  Read the main app host from environment (for Docker networking)
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
    BASE_PATH = ''; 
} else if (BASE_PATH.endsWith('/')) {
    BASE_PATH = BASE_PATH.slice(0, -1); 
}
// --- [END FIXED] ---

//  Construct the API URL dynamically using MAIN_APP_HOST
const API_BASE_URL = `http://${MAIN_APP_HOST}:${MAIN_SERVER_PORT}${BASE_PATH}/api`;
const HTTP_PORT = process.env.MCP_PORT || 3000;
const TRANSPORT_MODE = process.env.MCP_TRANSPORT || "stdio"; // 'stdio' ou 'http'
//  Read API Key from environment
const MCP_API_KEY = process.env.MCP_API_KEY || null;
// --- [END MODIFIED] ---


// --- Load UNS Model Manifest ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODEL_MANIFEST_PATH = path.join(__dirname, 'data/uns_model.json');
const DATA_DIR = path.dirname(MODEL_MANIFEST_PATH); 
let unsModel = [];

try {
  const modelData = fs.readFileSync(MODEL_MANIFEST_PATH, 'utf8');
  unsModel = JSON.parse(modelData);
  console.error("✅ Successfully loaded UNS Model Manifest from data/uns_model.json");
} catch (err) {
  console.error("❌ WARNING: Could not load 'data/uns_model.json'. Model-querying tools will not work.", err.message);
}

// ---  Helper function for schema inference ---
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

// ---  Internal helper to get config for other tools ---
const getMapperConfigInternal = async () => {
    const response = await axios.get(`${API_BASE_URL}/mapper/config`);
    return response.data;
};

// ---  Internal helper to save config for other tools ---
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
    version: "1.8.0", 
    description: "A server to control and query the MQTT Unified Namespace web visualizer application. Includes model-aware search, simulation controls, and tools to read/write new scenarios and SVG views.",
  });

  // ---  Project & File System Tools (For creating scenarios/views) ---

  server.registerTool(
    "list_project_files",
    {
      title: "List Project Files",
      description: "Lists key files in the project's root and `data` directories. Used to find simulator code (`simulator-*.js`), SVG files (`*.svg`), or **custom SVG binding scripts (`*.svg.js`)** to read.",
      inputSchema: {},
      outputSchema: { root_files: z.array(z.string()), data_files: z.array(z.string()) }
    },
    async () => {
      try {
        const rootFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.json') || f.endsWith('.md'));
        const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.svg') || f.endsWith('.json') || f.endsWith('.js'));
        return { 
          content: [{ type: "text", text: `Found ${rootFiles.length} root files and ${dataFiles.length} data files.` }],
          structuredContent: { root_files: rootFiles, data_files: dataFiles } 
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_file_content",
    {
      title: "Get File Content",
      description: "Reads the content of a *single* file from the project's root or `data` directory. Useful for reading existing SVG views (e.g., 'data/paris-metro.svg') or simulator code (e.g., 'simulator-stark.js') to learn patterns.",
      inputSchema: { 
        filename: z.string().describe("The relative path to the file (e.g., 'simulator-stark.js' or 'data/paris_metro.svg').")
      },
      outputSchema: { filename: z.string(), content: z.string() }
    },
    async ({ filename }) => {
      try {
        // Security: Prevent path traversal
        const resolvedPath = path.resolve(__dirname, filename);
        
        // Allow reading from root directory OR data directory
        if (!resolvedPath.startsWith(__dirname)) {
           return { content: [{ type: "text", text: "Error: Path traversal detected. Only files within the project root can be read." }], isError: true };
        }
        
        const content = fs.readFileSync(resolvedPath, 'utf8');
        return { 
          content: [{ type: "text", text: `Content of ${filename} (first 200 chars): ${content.substring(0, 200)}...` }],
          structuredContent: { filename: filename, content: content } 
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "save_file_to_data_directory",
    {
      title: "Save File to 'data' Directory",
      description: "Saves text content to a new file *only* in the `data/` directory. Use this to create new SVG views or new simulation scenarios. **For a new SVG view, you must save both the `.svg` file and its corresponding `.svg.js` custom logic file (e.g., 'data/my_view.svg' and 'data/my_view.svg.js').** New `.svg` files appear in the dropdown immediately. New simulator `.js` files require a server restart to be loaded (use the `restart_application_server` tool).",
      inputSchema: {
        filename: z.string().describe("The name of the file to create inside the 'data/' directory (e.g., 'my_llm_simulator.js' or 'my_animated_view.svg')."),
        content: z.string().describe("The full text content (JavaScript or SVG) to save.")
      },
      outputSchema: { success: z.boolean(), path: z.string() }
    },
    async ({ filename, content }) => {
      try {
        // Security: Ensure we only write to the dataDir
        const resolvedPath = path.resolve(DATA_DIR, filename);
        
        if (!resolvedPath.startsWith(DATA_DIR)) {
          return { content: [{ type: "text", text: "Error: Path traversal detected. Files can only be saved to the 'data' directory." }], isError: true };
        }
        
        fs.writeFileSync(resolvedPath, content, 'utf8');
        const savedPath = `data/${filename}`;
        return { 
          content: [{ type: "text", text: `File saved successfully to ${savedPath}` }],
          structuredContent: { success: true, path: savedPath } 
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
  );


  // ---  Model-Querying Tools ---

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

  //  Added optional broker_id
  server.registerTool(
    "search_uns_concept",
    {
      title: "Search by UNS Concept (Semantic Search)",
      description: "Performs a precise, structured search for MQTT messages based on a known UNS concept and specific data filters.",
      inputSchema: { 
        concept: z.string().describe("The UNS concept to search for (e.g., 'Work Order', 'Maintenance Request')."),
        filters: z.record(z.string()).optional().describe("An object of key-value pairs to filter the JSON payload (e.g., {\"status\": \"RELEASED\"})."),
        broker_id: z.string().optional().describe("Optional. The ID of the broker to search (e.g., 'broker_1').")
      },
      outputSchema: { results: z.array(z.any()) }
    },
    async ({ concept, filters, broker_id }) => {
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

        //  Call the API with new body structure
        const body = {
          topic_template,
          filters,
          broker_id //  Pass broker_id
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


  // ---  Data-Retrieval Tools ---

  //  Added optional brokerId
  server.registerTool(
    "search_data_fulltext",
    {
      title: "Search (Full-Text)",
      description: "Performs a simple full-text search for a keyword across all topic names and payload contents.",
      inputSchema: { 
        keyword: z.string().describe("The keyword to search for (e.g., 'maintenance', 'error')."),
        broker_id: z.string().optional().describe("Optional. The ID of the broker to search (e.g., 'broker_1').")
      },
      outputSchema: { results: z.array(z.any()) }
    },
    async ({ keyword, broker_id }) => {
      try {
        const encodedKeyword = encodeURIComponent(keyword);
        let url = `${API_BASE_URL}/context/search?q=${encodedKeyword}`;
        if (broker_id) {
            url += `&brokerId=${encodeURIComponent(broker_id)}`; //  Add brokerId to query
        }
        
        const response = await axios.get(url);
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

  //  Added optional brokerId
  server.registerTool(
    "get_latest_message",
    {
      title: "Get Latest Message",
      description: "Retrieves the most recent message for a single, *exact* MQTT topic.",
      inputSchema: { 
        topic: z.string().describe("The full MQTT topic name (e.g., 'stark_industries/malibu_facility/erp/workorder')"),
        broker_id: z.string().optional().describe("Optional. The ID of the broker to search (e.g., 'broker_1').")
      },
      outputSchema: { message: z.any() }
    },
    async ({ topic, broker_id }) => {
      try {
        const encodedTopic = encodeURIComponent(topic);
        let url = `${API_BASE_URL}/context/topic/${encodedTopic}`;
        if (broker_id) {
            url += `?brokerId=${encodeURIComponent(broker_id)}`; //  Add brokerId to query
        }

        const response = await axios.get(url);
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

  //  Added optional brokerId
  server.registerTool(
    "get_topic_history",
    {
      title: "Get Topic History",
      description: "Retrieves recent historical messages for a specified *exact* MQTT topic.",
      inputSchema: { 
        topic: z.string().describe("The full MQTT topic name to get history for."),
        broker_id: z.string().optional().describe("Optional. The ID of the broker to search (e.g., 'broker_1')."),
        limit: z.number().optional().describe("The maximum number of messages to return. Defaults to 20.")
      },
      outputSchema: { history: z.array(z.any()) }
    },
    async ({ topic, broker_id, limit }) => {
      try {
        const encodedTopic = encodeURIComponent(topic);
        const params = new URLSearchParams();
        if (broker_id) {
            params.append('brokerId', broker_id); 
        }
        if (limit) {
            params.append('limit', limit);
        }
        
        const queryString = params.toString() ? `?${params.toString()}` : '';
        const url = `${API_BASE_URL}/context/history/${encodedTopic}${queryString}`;
        
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
  
  //  Output schema updated
  server.registerTool(
    "get_topics_list",
    {
      title: "Get All Topics (Flat List)",
      description: "Returns a flat list of all unique MQTT topics currently known, including their broker ID.",
      inputSchema: {}, // No input
      outputSchema: { topics: z.array(z.object({ broker_id: z.string(), topic: z.string() })) }
    },
    async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/context/topics`);
        const output = { topics: response.data }; //  Data is now [{ broker_id, topic }, ...]
         return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );

  // ---  Admin, Simulator & Publish Tools ---

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
      description: "Gets the current status of all available simulators (e.g., 'stark_industries', 'death_star').",
      inputSchema: {}, // No input
      outputSchema: { statuses: z.record(z.string()) }
    },
    async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/simulator/status`);
        const output = response.data; // { "statuses": { "stark_industries": "running", ... } }
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
      description: "Starts a specific MQTT data simulator by name. Simulators publish to the *primary* broker.",
      inputSchema: {
        scenario_name: z.string().describe("The name of the scenario to start (e.g., 'stark_industries', 'death_star', 'paris_metro').")
      },
      outputSchema: { status: z.any() }
    },
    async ({ scenario_name }) => {
      try {
        const response = await axios.post(`${API_BASE_URL}/simulator/start/${scenario_name}`);
        const output = { status: response.data };
        return { 
          content: [{ type: "text", text: `Simulator [${scenario_name}] started: ` + JSON.stringify(output) }],
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
      description: "Stops a specific MQTT data simulator by name.",
      inputSchema: {
        scenario_name: z.string().describe("The name of the scenario to stop (e.g., 'stark_industries', 'death_star', 'paris_metro').")
      },
      outputSchema: { status: z.any() }
    },
    async ({ scenario_name }) => {
      try {
        const response = await axios.post(`${API_BASE_URL}/simulator/stop/${scenario_name}`);
        const output = { status: response.data };
        return { 
          content: [{ type: "text", text: `Simulator [${scenario_name}] stopped: ` + JSON.stringify(output) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );

  //  Added from previous step
  server.registerTool(
    "restart_application_server",
    {
      title: "Restart Application Server",
      description: "Triggers a graceful restart of the main MQTT UNS Viewer web server. This is necessary to load new `simulator-*.js` files or apply changes to `.env` configuration.",
      inputSchema: {}, // No input
      outputSchema: { message: z.string() }
    },
    async () => {
      try {
        // This endpoint is on the config API, which might be disabled
        // We'll call it and handle the error if it's 403
        const response = await axios.post(`${API_BASE_URL}/env/restart`);
        const output = response.data;
        return { 
          content: [{ type: "text", text: `Server restart initiated: ${output.message}` }],
          structuredContent: output
        };
      } catch (error) {
         if (error.response && error.response.status === 403) {
             return { content: [{ type: "text", text: "Error: Restart failed. The Configuration API (VIEW_CONFIG_ENABLED) must be enabled in the .env file to use this tool." }], isError: true };
         }
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
      }
    }
  );

  //  Added optional broker_id
  server.registerTool(
    "publish_message",
    {
      title: "Publish MQTT Message",
      description: "Publishes a message to an MQTT broker. If broker_id is not specified, publishes to the *primary* broker.",
      inputSchema: { 
        topic: z.string().describe("The full MQTT topic name to publish to."),
        payload: z.string().describe("The payload as a string. If format is 'json' or 'sparkplugb', this must be a valid JSON string."),
        format: z.enum(['string', 'json', 'sparkplugb']).describe("The format of the payload."),
        broker_id: z.string().optional().describe("Optional. The ID of the broker to publish to (e.g., 'broker_1')."),
        qos: z.number().min(0).max(2).optional().default(0).describe("The QoS level (0, 1, or 2)."),
        retain: z.boolean().optional().default(false).describe("Whether to set the retain flag.")
      },
      outputSchema: { success: z.boolean(), message: z.string() }
    },
    async ({ topic, payload, format, broker_id, qos, retain }) => {
      try {
        //  Add broker_id to body
        const body = { topic, payload, format, qos, retain, brokerId: broker_id }; 
        const response = await axios.post(`${API_BASE_URL}/publish/message`, body);
        const output = response.data;
        return {
          content: [{ type: "text", text: `Publish successful: ${output.message}` }],
          structuredContent: output
        };
      } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
      }
    }
  );

  //  Tool to list available SVG files
  server.registerTool(
    "get_available_svg_views",
    {
      title: "Get Available SVG Views",
      description: "Lists all .svg files available in the /data directory that can be displayed in the 'SVG View' tab.",
      inputSchema: {},
      outputSchema: { svg_files: z.array(z.string()) }
    },
    async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/svg/list`);
        const output = { svg_files: response.data };
         return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Error: " + error.message }], isError: true };
      }
    }
  );

  //  Added optional broker_id
  server.registerTool(
    "prune_topic_history",
    {
      title: "Prune Topic History",
      description: "Deletes messages from the database that match a specific topic pattern. Can be filtered by broker_id.",
      inputSchema: {
        topic_pattern: z.string().describe("The topic pattern to prune, using MQTT wildcards (+, #)."),
        broker_id: z.string().optional().describe("Optional. The ID of the broker to prune from (e.g., 'broker_1').")
      },
      outputSchema: { success: z.boolean(), count: z.number() }
    },
    async ({ topic_pattern, broker_id }) => {
        try {
            //  Add broker_id to body
            const body = { topicPattern: topic_pattern, broker_id: broker_id };
            const response = await axios.post(`${API_BASE_URL}/context/prune-topic`, body);
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
  
  //  Updated description to include brokerId
  server.registerTool(
    "update_mapper_rule",
    {
      title: "Update Mapper Rule",
      description: "Adds or updates a mapping rule. Rules are topic-based and apply to messages from *all* brokers. Inside the code, `msg.brokerId` can be used to handle logic differently for each broker.",
      inputSchema: { 
        sourceTopic: z.string().describe("The exact source topic to match (e.g., 'stark_industries/malibu_facility/mes/oee')."),
        targetTopic: z.string().describe("The destination topic to publish to (e.g., 'UNS/malibu/kpi/oee_percent')."),
        targetCode: z.string().describe(
          "The ASYNC JavaScript code for the transformation. " +
          "You have access to 'msg' (msg.topic, msg.payload, msg.brokerId) and 'db' (await db.all(sql), await db.get(sql)). " +
          "SQL must be read-only (SELECT). " +
          "Example: 'const row = await db.get(`SELECT * FROM mqtt_events WHERE broker_id = \\\'${msg.brokerId}\\\' LIMIT 1`); msg.payload.latest_val = row.payload; return msg;'"
        )
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
    await axios.get(`${API_BASE_URL}/config`); 
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

    //  Log API Key status
    if (MCP_API_KEY) {
      console.error("✅ MCP Server API Key protection is ENABLED.");
    } else {
      console.error("❌ WARNING: MCP_API_KEY is not set. The MCP server HTTP transport is UNPROTECTED.");
    }

    //  API Key Authentication Middleware
    const mcpAuthMiddleware = (req, res, next) => {
        if (!MCP_API_KEY) {
            return next(); // No key set, allow request
        }

        const authHeader = req.headers['authorization'];
        const keyHeader = req.headers['x-api-key'];
        let providedKey = null;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            providedKey = authHeader.substring(7);
        } else if (keyHeader) {
            providedKey = keyHeader;
        }

        if (providedKey && providedKey === MCP_API_KEY) {
            return next(); // Key is valid
        }

        console.error(`[MCP Auth] FAILED auth attempt. IP: ${req.ip}`);
        res.status(401).json({ error: "Unauthorized" });
    };

    app.post("/mcp", mcpAuthMiddleware, async (req, res) => { 
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
    console.error("🤖 Starting MCP server in stdio mode..."); 
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ MCP Server connected and listening via stdio."); 
  }
}

// Keep the process alive (useful for stdio)
if (TRANSPORT_MODE === 'stdio') {
  setInterval(() => {}, 1 << 30);
}

main();