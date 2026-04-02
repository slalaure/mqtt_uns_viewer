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
 * MCP Server
 * Controls the Korelate via Model Context Protocol.
 * [UPDATED] Relocated to interfaces/mcp/ and updated relative paths.
 * [UPDATED] Added global Axios interceptor with Exponential Backoff for 429 Rate Limits.
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
import * as chrono from "chrono-node";

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

const axiosConfig = {};
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
const MODEL_MANIFEST_PATH = path.join(DATA_DIR, 'uns_model.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

let toolsManifest = { tools: [] };
let unsModel = [];

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
        if (fs.existsSync(MODEL_MANIFEST_PATH)) {
            unsModel = JSON.parse(fs.readFileSync(MODEL_MANIFEST_PATH, 'utf8'));
        }
    } catch (e) {
        console.error("❌ Error loading manifests:", e.message);
    }
}
loadManifests();

// --- Tool Flags ---
const TOOL_FLAGS = {
    ENABLE_READ: process.env.LLM_TOOL_ENABLE_READ !== 'false',
    ENABLE_SEMANTIC: process.env.LLM_TOOL_ENABLE_SEMANTIC !== 'false',
    ENABLE_PUBLISH: process.env.LLM_TOOL_ENABLE_PUBLISH !== 'false',
    ENABLE_FILES: process.env.LLM_TOOL_ENABLE_FILES !== 'false',
    ENABLE_SIMULATOR: process.env.LLM_TOOL_ENABLE_SIMULATOR !== 'false',
    ENABLE_MAPPER: process.env.LLM_TOOL_ENABLE_MAPPER !== 'false',
    ENABLE_ADMIN: process.env.LLM_TOOL_ENABLE_ADMIN !== 'false'
};

// --- Helpers ---
function _inferSchema(messages) {
    const schema = {};
    let count = 0;
    for (const msg of messages) {
        if (count > 20) break;
        try {
            const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;
            for (const [key, value] of Object.entries(payload)) {
                if (!schema[key]) schema[key] = typeof value;
            }
            count++;
        } catch (e) {}
    }
    return schema;
}

const parseTimeWindow = (timeExpression) => {
    if (!timeExpression || typeof timeExpression !== 'string') return null;
    const results = chrono.parse(timeExpression);
    if (results.length === 0) return null;
    const firstResult = results[0];
    let start = firstResult.start.date();
    let end = firstResult.end ? firstResult.end.date() : new Date();
    return { start: start.toISOString(), end: end.toISOString() };
};

const getMapperConfigInternal = async () => (await axios.get(`${API_BASE_URL}/mapper/config`, axiosConfig)).data;
const saveMapperConfigInternal = async (config) => (await axios.post(`${API_BASE_URL}/mapper/config`, config, axiosConfig)).data;

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

// --- Implementation Map ---
const implementations = {
    // READ
    get_application_status: async () => {
        const res = await axios.get(`${API_BASE_URL}/context/status`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify({ status: res.data }, null, 2) }] };
    },
    list_topics: async () => {
        const res = await axios.get(`${API_BASE_URL}/context/topics`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify({ topics: res.data }, null, 2) }] };
    },
    get_topics_list: async () => {
        const res = await axios.get(`${API_BASE_URL}/context/topics`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify({ topics: res.data }, null, 2) }] };
    },
    search_data: async ({ query, time_expression, limit, broker_id }) => {
        const encodedKeyword = encodeURIComponent(query);
        let url = `${API_BASE_URL}/context/search?q=${encodedKeyword}`;
        if (broker_id) url += `&brokerId=${encodeURIComponent(broker_id)}`;
        const timeWindow = parseTimeWindow(time_expression);
        if (timeWindow) {
            url += `&startDate=${encodeURIComponent(timeWindow.start)}&endDate=${encodeURIComponent(timeWindow.end)}`;
        }
        const res = await axios.get(url, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify({ results: res.data }, null, 2) }] };
    },
    get_topic_history: async ({ topic, time_expression, limit, broker_id }) => {
        const encodedTopic = encodeURIComponent(topic);
        const params = new URLSearchParams();
        if (broker_id) params.append('brokerId', broker_id);
        if (limit) params.append('limit', limit);
        const timeWindow = parseTimeWindow(time_expression);
        if (timeWindow) {
            params.append('startDate', timeWindow.start);
            params.append('endDate', timeWindow.end);
        }
        const qs = params.toString() ? `?${params.toString()}` : '';
        const res = await axios.get(`${API_BASE_URL}/context/history/${encodedTopic}${qs}`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify({ history: res.data }, null, 2) }] };
    },
    aggregate_time_series: async ({ topic, variables, time_expression, aggregation, broker_id }) => {
        const timeWindow = parseTimeWindow(time_expression);
        if (!timeWindow) return { content: [{ type: "text", text: "Error: Could not parse time_expression." }], isError: true };

        const formattedTopics = [{
            topic: topic,
            brokerId: broker_id || 'default_broker',
            variables: variables.map((v, i) => ({ id: `var_${i}`, path: v }))
        }];

        const body = {
            topics: formattedTopics,
            startDate: timeWindow.start,
            endDate: timeWindow.end,
            aggregation: aggregation || 'MEAN',
            maxPoints: 500
        };

        const res = await axios.post(`${API_BASE_URL}/context/aggregate`, body, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
    get_latest_message: async ({ topic, broker_id }) => {
        const encodedTopic = encodeURIComponent(topic);
        let url = `${API_BASE_URL}/context/topic/${encodedTopic}`;
        if (broker_id) url += `?brokerId=${encodeURIComponent(broker_id)}`;
        const res = await axios.get(url, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify({ message: res.data }, null, 2) }] };
    },
    // SEMANTIC
    search_uns_concept: async ({ concept, filters, broker_id }) => {
        loadManifests(); 
        const lowerConcept = concept.toLowerCase();
        const model = unsModel.find(m => m.concept.toLowerCase().includes(lowerConcept) || (m.keywords && m.keywords.some(k => k.toLowerCase().includes(lowerConcept))));
        if (!model) return { content: [{ type: "text", text: `Error: Concept '${concept}' not found in UNS Model.` }], isError: true };
        const body = { topic_template: model.topic_template, filters, broker_id };
        const res = await axios.post(`${API_BASE_URL}/context/search/model`, body, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify({ results: res.data }, null, 2) }] };
    },
    infer_schema: async ({ topic_pattern }) => {
        const res = await axios.post(`${API_BASE_URL}/context/search/model`, { topic_template: topic_pattern }, axiosConfig);
        const schema = _inferSchema(res.data || []);
        return { content: [{ type: "text", text: JSON.stringify({ inferred_schema: schema }, null, 2) }] };
    },
    get_model_definition: async ({ concept }) => {
        loadManifests();
        const lowerConcept = concept.toLowerCase();
        const results = unsModel.filter(model => 
            model.concept.toLowerCase().includes(lowerConcept) ||
            (model.keywords && model.keywords.some(k => k.toLowerCase().includes(lowerConcept)))
        );
        return { content: [{ type: "text", text: JSON.stringify({ definitions: results }, null, 2) }] };
    },
    update_uns_model: async ({ model_json }) => {
        try {
            const newModel = JSON.parse(model_json);
            if (!Array.isArray(newModel)) throw new Error("Model must be a JSON Array.");
            fs.writeFileSync(MODEL_MANIFEST_PATH, JSON.stringify(newModel, null, 2), 'utf8');
            return { content: [{ type: "text", text: "UNS Model updated successfully." }] };
        } catch (e) {
            return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
        }
    },
    // PUBLISH
    publish_message: async ({ topic, payload, format, broker_id, qos, retain }) => {
        const body = { topic, payload, format, qos, retain, brokerId: broker_id };
        const res = await axios.post(`${API_BASE_URL}/publish/message`, body, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
    // FILES CAPABILITIES
    list_project_files: async () => {
        const rootFiles = fs.readdirSync(PROJECT_ROOT).filter(f => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.json') || f.endsWith('.md'));
        const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.match(/\.(svg|html|htm|js|json|gltf|glb|bin)$/i));
        return { content: [{ type: "text", text: JSON.stringify({ root_files: rootFiles, data_files: dataFiles }, null, 2) }] };
    },
    get_file_content: async ({ filename }) => {
        const resolvedPath = path.resolve(PROJECT_ROOT, filename);
        if (!resolvedPath.startsWith(PROJECT_ROOT)) return { content: [{ type: "text", text: "Path traversal blocked." }], isError: true };
        
        if (resolvedPath.match(/\.(glb|bin|png|jpg|jpeg|ico)$/i)) {
             return { content: [{ type: "text", text: "Cannot read binary file contents via MCP." }], isError: true };
        }
        
        const content = fs.readFileSync(resolvedPath, 'utf8');
        return { content: [{ type: "text", text: content }] };
    },
    save_file_to_data_directory: async ({ filename, content }) => {
        const resolvedPath = path.resolve(DATA_DIR, filename);
        if (!resolvedPath.startsWith(DATA_DIR)) return { content: [{ type: "text", text: "Path traversal blocked." }], isError: true };
        fs.writeFileSync(resolvedPath, content, 'utf8');
        return { content: [{ type: "text", text: `File saved to data/${filename}` }] };
    },
    create_hmi_view: async ({ view_name, hmi_content, js_content }) => {
        let ext = path.extname(view_name).toLowerCase();
        let baseName = path.basename(view_name, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        if (ext !== '.svg' && ext !== '.html' && ext !== '.htm') {
            ext = '.html';
        }
        
        const hmiFilename = `${baseName}${ext}`;
        const jsFilename = `${baseName}${ext}.js`;
        
        fs.writeFileSync(path.join(DATA_DIR, hmiFilename), hmi_content, 'utf8');
        fs.writeFileSync(path.join(DATA_DIR, jsFilename), js_content, 'utf8');
        return { content: [{ type: "text", text: `Created HMI view '${hmiFilename}'.` }] };
    },
    get_available_hmi_views: async () => {
        const res = await axios.get(`${API_BASE_URL}/hmi/list`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify({ hmi_files: res.data }, null, 2) }] };
    },
    // MAPPER
    get_mapper_config: async () => {
        const config = await getMapperConfigInternal();
        return { content: [{ type: "text", text: JSON.stringify({ config }, null, 2) }] };
    },
    update_mapper_rule: async ({ sourceTopic, targetTopic, targetCode }) => {
        const config = await getMapperConfigInternal();
        const activeVersion = config.versions.find(v => v.id === config.activeVersionId);
        if (!activeVersion) return { content: [{ type: "text", text: "No active mapper version." }], isError: true };
        let rule = activeVersion.rules.find(r => r.sourceTopic.trim() === sourceTopic.trim());
        if (!rule) {
            rule = { sourceTopic: sourceTopic.trim(), targets: [] };
            activeVersion.rules.push(rule);
        }
        const sanitizedCode = targetCode.replace(/\u00A0/g, " ").trim();
        rule.targets.push({
            id: `tgt_${Date.now()}`,
            enabled: true,
            outputTopic: targetTopic.trim(),
            mode: "js",
            code: sanitizedCode
        });
        const res = await saveMapperConfigInternal(config);
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
    // ADMIN / SIMULATOR
    prune_topic_history: async ({ topic_pattern, broker_id }) => {
        const body = { topicPattern: topic_pattern, broker_id };
        const res = await axios.post(`${API_BASE_URL}/context/prune-topic`, body, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
    get_simulator_status: async () => {
        const res = await axios.get(`${API_BASE_URL}/simulator/status`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
    start_simulator: async ({ name }) => {
        const res = await axios.post(`${API_BASE_URL}/simulator/start/${name}`, {}, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
    stop_simulator: async ({ name }) => {
        const res = await axios.post(`${API_BASE_URL}/simulator/stop/${name}`, {}, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
    restart_application_server: async () => {
        const res = await axios.post(`${API_BASE_URL}/env/restart`, {}, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
    // ALERTS
    list_alert_rules: async () => {
        const res = await axios.get(`${API_BASE_URL}/alerts/rules`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
    list_active_alerts: async () => {
        const res = await axios.get(`${API_BASE_URL}/alerts/active`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
    create_alert_rule: async (args) => {
        const res = await axios.post(`${API_BASE_URL}/alerts/rules`, args, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
    update_alert_rule: async ({ id, ...updates }) => {
        const res = await axios.put(`${API_BASE_URL}/alerts/rules/${id}`, updates, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
    delete_alert_rule: async ({ id }) => {
        const res = await axios.delete(`${API_BASE_URL}/alerts/rules/${id}`, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    },
    update_alert_status: async ({ alert_id, status }) => {
        const res = await axios.post(`${API_BASE_URL}/alerts/${alert_id}/status`, { status }, axiosConfig);
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
};

/**
 * Creates and configures the MCP server instance.
 */
async function createMcpServer() {
    const server = new McpServer({
        name: "Korelate Controller",
        version: "1.6.0-beta1",
        description: "Control the Korelate via tools defined in ai_tools_manifest.json.",
    });

    for (const toolDef of toolsManifest.tools) {
        const flag = TOOL_FLAGS[toolDef.category];
        if (flag === false) continue; 

        const handler = implementations[toolDef.name];
        if (!handler) {
            console.warn(`⚠️ Warning: Tool '${toolDef.name}' defined in manifest but missing in mcpServer.mjs`);
            continue;
        }

        server.registerTool(
            toolDef.name,
            {
                title: toolDef.name, 
                description: toolDef.description,
                inputSchema: jsonSchemaToZod(toolDef.inputSchema)
            },
            async (args) => {
                try {
                    return await handler(args);
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
    try {
        await axios.get(`${API_BASE_URL}/config`, axiosConfig);
        console.error(`✅ MCP Server connected to main API at: ${API_BASE_URL}/config`);
    } catch (error) {
        console.error("❌ FATAL: Could not contact main server. Exiting.");
        process.exit(1);
    }

    const server = await createMcpServer();

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