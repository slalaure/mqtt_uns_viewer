/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an &quot;AS IS&quot; BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * MCP Server
 * Controls the Korelate via Model Context Protocol.
 * [UPDATED] Relocated to interfaces/mcp/ and updated relative paths.
 * [UPDATED] Added global Axios interceptor with Exponential Backoff for 429 Rate Limits.
 * [UPDATED] Refactored to act as a pure proxy: all tools are forwarded to the Main API (/api/chat/tool/execute)
 * to guarantee 100% parity in business logic and RBAC.
 */

// --- Imports (ESM) ---
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod"; 
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- Configuration ---
const MAIN_APP_HOST = process.env.MAIN_APP_HOST || 'localhost';
const MAIN_SERVER_PORT = process.env.PORT || 8080;
let BASE_PATH = process.env.BASE_PATH || '/';

if (!BASE_PATH.startsWith('/')) BASE_PATH = '/' + BASE_PATH;
if (BASE_PATH === '/') BASE_PATH = '';
else if (BASE_PATH.endsWith('/')) BASE_PATH = BASE_PATH.slice(0, -1);

const API_BASE_URL = `http://${MAIN_APP_HOST}:${MAIN_SERVER_PORT}${BASE_PATH}/api`;
const HTTP_PORT = process.env.MCP_PORT || 3000;
const TRANSPORT_MODE = process.env.MCP_TRANSPORT || "stdio";
const MCP_API_KEY = process.env.MCP_API_KEY || null;

const HTTP_USER = process.env.HTTP_USER;
const HTTP_PASSWORD = process.env.HTTP_PASSWORD;

const axiosConfig = {
    timeout: 30000 // Extended timeout for long-running AI tools (DB queries, file writes)
};

if (HTTP_USER && HTTP_PASSWORD) {
    axiosConfig.auth = { username: HTTP_USER, password: HTTP_PASSWORD };
    console.error(`🔐 MCP Server will use Basic Auth to contact Main API (${HTTP_USER}:***)`);
}

// --- Axios Interceptor for 429 Rate Limits (Exponential Backoff) ---
axios.interceptors.response.use(
    (response) => response,
    async (error) => {
        const config = error.config;
        if (error.response && error.response.status === 429) {
            config.retryCount = config.retryCount || 0;
            if (config.retryCount < 5) {
                config.retryCount += 1;
                // Exponential backoff: 2^retry * 1000 + random jitter
                const delay = Math.pow(2, config.retryCount) * 1000 + Math.random() * 500;
                console.error(`[MCP] 429 Rate Limit hit on ${config.url}. Retrying in ${(delay/1000).toFixed(1)}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return axios(config);
            }
        }
        return Promise.reject(error);
    }
);

// --- Paths & Manifest Loading ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'ai_tools_manifest.json');

let toolsManifest = { tools: [] };

function loadManifests() {
    try {
        let targetManifestPath = MANIFEST_PATH;
        if (!fs.existsSync(targetManifestPath)) {
            targetManifestPath = path.join(PROJECT_ROOT, 'public', 'ai_tools_manifest.json');
        }
        
        if (fs.existsSync(targetManifestPath)) {
            toolsManifest = JSON.parse(fs.readFileSync(targetManifestPath, 'utf8'));
            console.error(`✅ Loaded AI Tools Manifest (${toolsManifest.tools.length} tools).`);
        } else {
            console.error("❌ FATAL: ai_tools_manifest.json not found.");
        }
    } catch (e) {
        console.error("❌ Error loading manifests:", e.message);
    }
}
loadManifests();

// --- Tool Flags (Default, will be refined by remote config) ---
let TOOL_FLAGS = {
    ENABLE_READ: process.env.LLM_TOOL_ENABLE_READ !== 'false',
    ENABLE_SEMANTIC: process.env.LLM_TOOL_ENABLE_SEMANTIC !== 'false',
    ENABLE_PUBLISH: process.env.LLM_TOOL_ENABLE_PUBLISH !== 'false',
    ENABLE_FILES: process.env.LLM_TOOL_ENABLE_FILES !== 'false',
    ENABLE_SIMULATOR: process.env.LLM_TOOL_ENABLE_SIMULATOR !== 'false',
    ENABLE_MAPPER: process.env.LLM_TOOL_ENABLE_MAPPER !== 'false',
    ENABLE_ADMIN: process.env.LLM_TOOL_ENABLE_ADMIN !== 'false'
};

// --- Helpers ---
function jsonSchemaToZod(schema) {
    const shape = {};
    if (schema.properties) {
        for (const [key, prop] of Object.entries(schema.properties)) {
            let zodType;
            if (prop.type === 'string') zodType = z.string();
            else if (prop.type === 'number') zodType = z.number();
            else if (prop.type === 'boolean') zodType = z.boolean();
            else if (prop.type === 'object') zodType = z.record(z.any()); 
            else if (prop.type === 'array') zodType = z.array(z.string());
            else zodType = z.any();

            if (prop.description) zodType = zodType.describe(prop.description);
            if (prop.enum) zodType = z.enum(prop.enum).describe(prop.description || "");
            
            const isRequired = schema.required && schema.required.includes(key);
            if (!isRequired) {
                zodType = zodType.optional();
            }
            shape[key] = zodType;
        }
    }
    return shape;
}

/**
 * Creates and configures the MCP server instance.
 */
async function createMcpServer(remoteConfig) {
    const server = new McpServer({
        name: "Korelate Controller",
        version: "1.6.0-beta1",
        description: "Control the Korelate via tools defined in ai_tools_manifest.json.",
    });

    // Refine TOOL_FLAGS based on remote visibility (Strict Feature Gating)
    if (remoteConfig) {
        if (remoteConfig.viewMapperEnabled === false) TOOL_FLAGS.ENABLE_MAPPER = false;
        if (remoteConfig.viewAlertsEnabled === false) TOOL_FLAGS.ENABLE_ADMIN = false; 
        if (remoteConfig.isSimulatorEnabled === false) TOOL_FLAGS.ENABLE_SIMULATOR = false;
        if (remoteConfig.viewPublishEnabled === false) TOOL_FLAGS.ENABLE_PUBLISH = false;
    }

    for (const toolDef of toolsManifest.tools) {
        const flag = TOOL_FLAGS[toolDef.category];
        if (flag === false) continue; 

        server.registerTool(
            toolDef.name,
            {
                title: toolDef.name, 
                description: toolDef.description,
                inputSchema: jsonSchemaToZod(toolDef.inputSchema)
            },
            async (args) => {
                try {
                    // Forward tool execution to the main application's engine
                    const res = await axios.post(`${API_BASE_URL}/chat/tool/execute`, {
                        toolName: toolDef.name,
                        args: args
                    }, axiosConfig);

                    const result = res.data;

                    // Properly format the response for MCP protocol
                    if (result.error) {
                        return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
                    }
                    if (result.content) {
                        return result; // Already properly formatted by aiTools.js
                    }
                    
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };

                } catch (e) {
                    const msg = e.response ? `API ${e.response.status}: ${JSON.stringify(e.response.data)}` : e.message;
                    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
                }
            }
        );
    }

    return server;
}

/**
 * Main entry point.
 */
async function main() {
    let remoteConfig = null;
    try {
        const res = await axios.get(`${API_BASE_URL}/config`, axiosConfig);
        remoteConfig = res.data;
        console.error(`✅ MCP Server connected to main API at: ${API_BASE_URL}/config`);
    } catch (error) {
        console.error("❌ FATAL: Could not contact main server. Exiting.");
        process.exit(1);
    }

    const server = await createMcpServer(remoteConfig);

    if (TRANSPORT_MODE === "http") {
        const app = express();
        app.use(express.json());

        const mcpAuthMiddleware = (req, res, next) => {
            if (!MCP_API_KEY) return next();
            const key = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
            if (key === MCP_API_KEY) return next();
            res.status(401).json({ error: "Unauthorized" });
        };

        let MCP_ROUTE = path.posix.join(BASE_PATH, 'mcp');
        if (!MCP_ROUTE.startsWith('/')) MCP_ROUTE = '/' + MCP_ROUTE;

        app.post(MCP_ROUTE, mcpAuthMiddleware, async (req, res) => {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            res.on("close", () => transport.close());
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        });

        app.listen(HTTP_PORT, () => {
            console.error(`🤖 MCP Server (HTTP) listening on port ${HTTP_PORT} at ${MCP_ROUTE}`);
        });
    } else {
        console.error("🤖 Starting MCP server in stdio mode...");
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}

if (TRANSPORT_MODE === 'stdio') {
    setInterval(() => {}, 1 << 30);
}

main();