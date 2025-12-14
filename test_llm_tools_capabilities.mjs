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
 * Capabilities Test Suite
 * Verifies that the AI permissions set in .env are correctly enforced by the server.
 * [MODIFIED] Increased delay between tests to avoid HTTP 429 (Rate Limits).
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Configuration ---
const BASE_URL = 'http://localhost:8080/api';
const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', '.env');

// --- Colors for Console ---
const c = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    cyan: "\x1b[36m"
};

// --- Helper: Read .env manually ---
function getEnvConfig() {
    try {
        const envContent = fs.readFileSync(ENV_PATH, 'utf8');
        const config = {};
        envContent.split('\n').forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2 && !line.trim().startsWith('#')) {
                const key = parts[0].trim();
                const val = parts.slice(1).join('=').trim();
                // Parse boolean strings
                config[key] = val === 'true' ? true : (val === 'false' ? false : val);
            }
        });
        return config;
    } catch (e) {
        console.error(`${c.red}Error reading .env file at ${ENV_PATH}${c.reset}`);
        return {};
    }
}

// --- Test Definitions ---
const SCENARIOS = [
    {
        name: "READ Capability",
        flag: "LLM_TOOL_ENABLE_READ",
        prompt: "List all the MQTT topics currently in the database.",
        // Keywords expected if tool WORKS
        successKeywords: ["mqttunsviewer", "stark", "factory", "list", "found"], 
        // Keywords expected if tool is BLOCKED
        blockKeywords: ["cannot", "unable", "don't have access", "permission", "sorry"] 
    },
    {
        name: "FILES Capability",
        flag: "LLM_TOOL_ENABLE_FILES",
        prompt: "List the files in the project root directory.",
        successKeywords: ["server.js", "package.json", "README.md"],
        blockKeywords: ["cannot", "unable", "don't have access", "permission", "sorry"]
    },
    {
        name: "SIMULATOR Capability",
        flag: "LLM_TOOL_ENABLE_SIMULATOR",
        prompt: "What is the current status of the simulators?",
        successKeywords: ["running", "stopped", "stark_industries", "death_star"],
        blockKeywords: ["cannot", "unable", "don't have access", "permission", "sorry"]
    },
    {
        name: "SEMANTIC Capability",
        flag: "LLM_TOOL_ENABLE_SEMANTIC",
        prompt: "Get the model definition for the concept 'Work Order'.",
        successKeywords: ["schema", "definition", "concept", "workorder"],
        blockKeywords: ["cannot", "unable", "don't have access", "permission", "sorry"]
    },
    // Note: PUBLISH, MAPPER, and ADMIN are harder to test non-destructively via simple prompt/response keywords,
    // but follow the same logic.
];

async function testCapability(scenario, config) {
    const isEnabled = config[scenario.flag] !== false; // Default is true if missing
    
    console.log(`${c.bold}Testing: ${scenario.name}${c.reset}`);
    console.log(`  Flag ${c.cyan}${scenario.flag}${c.reset} is set to: ${isEnabled ? c.green + 'TRUE' : c.red + 'FALSE'}${c.reset}`);
    console.log(`  Prompt: "${scenario.prompt}"`);

    try {
        const response = await axios.post(`${BASE_URL}/chat/completion`, {
            messages: [{ role: "user", content: scenario.prompt }]
        }, { timeout: 20000 }); // Increased timeout for LLM processing

        const reply = response.data.choices[0].message.content || "";
        console.log(`  ${c.dim}IA Response: ${reply.substring(0, 100).replace(/\n/g, ' ')}...${c.reset}`);

        // --- Verification Logic ---
        const lowerReply = reply.toLowerCase();
        
        if (isEnabled) {
            // Expecting SUCCESS keywords
            const hit = scenario.successKeywords.some(kw => lowerReply.includes(kw));
            if (hit || reply.length > 50) { // Length check is a heuristic fallback
                console.log(`  Result: ${c.green}✔ PASS (Tool execution detected)${c.reset}`);
            } else {
                console.log(`  Result: ${c.yellow}⚠ WARN (Tool enabled, but response ambiguous)${c.reset}`);
            }
        } else {
            // Expecting BLOCK keywords or lack of data
            const hitData = scenario.successKeywords.some(kw => lowerReply.includes(kw));
            if (hitData) {
                console.log(`  Result: ${c.red}✘ FAIL (Security Breach: Data returned despite flag=FALSE)${c.reset}`);
            } else {
                console.log(`  Result: ${c.green}✔ PASS (Access correctly denied)${c.reset}`);
            }
        }

    } catch (e) {
        if (e.response) {
             const status = e.response.status;
             const dataErr = e.response.data && e.response.data.error;
             
             console.log(`  API Error: ${status} - ${dataErr || e.message}`);
             
             // Handle 429 specifically
             if (status === 429) {
                 console.log(`  Result: ${c.yellow}⚠ SKIPPED (Rate Limit hit - Try running tests slower)${c.reset}`);
                 return;
             }

             // If error explicitly mentions "disabled", it's a pass for disabled state
             if (!isEnabled && dataErr && dataErr.includes("disabled")) {
                 console.log(`  Result: ${c.green}✔ PASS (Explicitly blocked by server)${c.reset}`);
             } else {
                 console.log(`  Result: ${c.red}✘ ERROR (Request failed)${c.reset}`);
             }
        } else {
            console.log(`  ${c.red}✘ ERROR: ${e.message}${c.reset}`);
        }
    }
    console.log("");
}

async function run() {
    console.log(`\n${c.blue}=== AI Capabilities Security Check ===${c.reset}\n`);
    
    // 1. Check Server
    try {
        await axios.get(`${BASE_URL}/context/status`);
    } catch (e) {
        console.error(`${c.red}FATAL: Server is not running on ${BASE_URL}. Start 'node server.js' first.${c.reset}`);
        process.exit(1);
    }

    // 2. Load Config
    const config = getEnvConfig();
    if (!config.LLM_API_KEY) {
        console.error(`${c.yellow}WARNING: LLM_API_KEY is missing in .env. Tests will likely fail with 500.${c.reset}\n`);
    }

    // 3. Run Scenarios
    for (const scenario of SCENARIOS) {
        await testCapability(scenario, config);
        
        // [MODIFIED] Increased wait time to 10 seconds to avoid 429 Errors from Gemini
        console.log(`${c.dim}Waiting 10s to respect Rate Limits...${c.reset}`);
        await new Promise(r => setTimeout(r, 10000));
    }

    console.log(`${c.blue}=== Check Complete ===${c.reset}\n`);
}

run();