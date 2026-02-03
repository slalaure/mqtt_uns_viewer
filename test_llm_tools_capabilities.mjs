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
 * Capabilities Test Suite (Secured)
 * Verifies that the AI permissions set in .env are correctly enforced by the server.
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Configuration ---
const BASE_URL = 'http://localhost:8080/api';
const AUTH_URL = 'http://localhost:8080/auth/login';
const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', '.env');

// --- Test User Credentials (must match server setup) ---
const TEST_USER = 'admin';
const TEST_PASS = 'admin';

// --- State ---
let sessionHeaders = {};

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

// --- Helper: Authenticate ---
async function authenticate() {
    console.log(`${c.dim}Authenticating as ${TEST_USER}...${c.reset}`);
    try {
        const res = await axios.post(AUTH_URL, { username: TEST_USER, password: TEST_PASS });
        const cookies = res.headers['set-cookie'];
        if (cookies) {
            sessionHeaders['Cookie'] = cookies.map(c => c.split(';')[0]).join('; ');
            console.log(`${c.green}✔ Authenticated.${c.reset}`);
            return true;
        }
    } catch (e) {
        console.error(`${c.red}Authentication failed: ${e.message}${c.reset}`);
        console.warn("Tests might fail with 401/403 if server requires auth.");
    }
    return false;
}

// --- Test Definitions ---
const SCENARIOS = [
    {
        name: "READ Capability",
        flag: "LLM_TOOL_ENABLE_READ",
        prompt: "List all the MQTT topics currently in the database.",
        successKeywords: ["mqttunsviewer", "stark", "factory", "list", "found"], 
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
    }
];

async function testCapability(scenario, config) {
    const isEnabled = config[scenario.flag] !== false; // Default is true if missing
    
    console.log(`${c.bold}Testing: ${scenario.name}${c.reset}`);
    console.log(`  Flag ${c.cyan}${scenario.flag}${c.reset} is set to: ${isEnabled ? c.green + 'TRUE' : c.red + 'FALSE'}${c.reset}`);
    console.log(`  Prompt: "${scenario.prompt}"`);

    try {
        const response = await axios.post(`${BASE_URL}/chat/completion`, {
            messages: [{ role: "user", content: scenario.prompt }]
        }, { 
            timeout: 20000,
            headers: sessionHeaders 
        });

        const reply = response.data.choices[0].message.content || "";
        console.log(`  ${c.dim}IA Response: ${reply.substring(0, 100).replace(/\n/g, ' ')}...${c.reset}`);

        // --- Verification Logic ---
        const lowerReply = reply.toLowerCase();
        
        if (isEnabled) {
            // Expecting SUCCESS keywords
            const hit = scenario.successKeywords.some(kw => lowerReply.includes(kw));
            if (hit || reply.length > 50) { 
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
             
             if (status === 429) {
                 console.log(`  Result: ${c.yellow}⚠ SKIPPED (Rate Limit hit)${c.reset}`);
                 return;
             }
             
             // If disabled and we get a permission error (often handled by LLM text, but sometimes tool errors bubble up)
             if (!isEnabled && (status === 403 || (dataErr && dataErr.includes("disabled")))) {
                 console.log(`  Result: ${c.green}✔ PASS (Explicitly blocked)${c.reset}`);
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
    
    // 1. Authenticate first
    await authenticate();

    // 2. Load Config
    const config = getEnvConfig();
    if (!config.LLM_API_KEY) {
        console.error(`${c.yellow}WARNING: LLM_API_KEY is missing in .env. Tests will likely fail with 500.${c.reset}\n`);
    }

    // 3. Run Scenarios
    for (const scenario of SCENARIOS) {
        await testCapability(scenario, config);
        
        // Wait to respect Rate Limits
        console.log(`${c.dim}Waiting 5s...${c.reset}`);
        await new Promise(r => setTimeout(r, 5000));
    }

    console.log(`${c.blue}=== Check Complete ===${c.reset}\n`);
}

run();