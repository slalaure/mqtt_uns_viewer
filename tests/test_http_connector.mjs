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
 * HTTP Connector Real-world Integration Test
 * Verifies:
 * 1. Data Ingestion (Pseudo-Publish)
 * 2. Webhook Registration (Pseudo-Subscribe)
 * 3. Webhook Execution (Callback)
 * 4. Anti-flood protection
 * 5. Permission patterns (publish/subscribe)
 */
import axios from 'axios';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Configuration ---
const PORT = 8080;
const ROOT_URL = `http://localhost:${PORT}`;
const API_URL = `${ROOT_URL}/api`;
const INGEST_PATH = `/api/ingest/http-test`;
const SUBSCRIBE_PATH = `/api/subscribe/http-test`;

const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    dim: "\x1b[2m",
};

const title = (t) => console.log(`\n${colors.blue}=== ${t} ===${colors.reset}`);
const success = (msg) => console.log(`  ${colors.green}✔ PASS:${colors.reset} ${msg}`);
const fail = (msg, err) => {
    console.log(`  ${colors.red}✘ FAIL:${colors.reset} ${msg}`);
    if (err) {
        if (err.response) console.log(`    ${colors.yellow}HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}${colors.reset}`);
        else console.log(`    ${colors.yellow}${err.message}${colors.reset}`);
    }
};
const info = (msg) => console.log(`    ${colors.dim}ℹ ${msg}${colors.reset}`);

// --- Mock Webhook Receiver ---
const WEBHOOK_PORT = 9999;
const webhookApp = express();
webhookApp.use(express.json());

let receivedWebhooks = [];
webhookApp.post('/callback', (req, res) => {
    receivedWebhooks.push(req.body);
    res.sendStatus(200);
});

let webhookServer;

async function startWebhookServer() {
    return new Promise(resolve => {
        webhookServer = webhookApp.listen(WEBHOOK_PORT, () => {
            info(`Mock Webhook Receiver listening on port ${WEBHOOK_PORT}`);
            resolve();
        });
    });
}

/**
 * Main Test Suite
 */
async function runTests() {
    title("HTTP Connector Integration Tests");
    console.log(`${colors.dim}Target Server: ${ROOT_URL}${colors.reset}`);
    console.log(`${colors.dim}Requirements: Server must have a provider with ID 'http-test' and allow patterns:
    - publish: ["test/ingest/#"]
    - subscribe: ["test/webhook/#"]
    ${colors.reset}`);

    await startWebhookServer();

    try {
        // --- 1. Test Ingestion (Allowed) ---
        title("Test Ingestion (Allowed)");
        try {
            const res = await axios.post(`${ROOT_URL}${INGEST_PATH}/test/ingest/temp`, 
                { val: 42.5, unit: 'C' }, 
                { headers: { 'Content-Type': 'application/json' } }
            );
            if (res.status === 200 && res.data.success) {
                success("POST allowed topic pattern");
            } else {
                fail("POST allowed topic pattern", { message: `Status: ${res.status}` });
            }
        } catch (e) {
            fail("POST allowed topic pattern", e);
        }

        // --- 2. Test Ingestion (Forbidden) ---
        title("Test Ingestion (Forbidden)");
        try {
            await axios.post(`${ROOT_URL}${INGEST_PATH}/secret/data`, 
                { val: 'hidden' }, 
                { headers: { 'Content-Type': 'application/json' } }
            );
            fail("POST forbidden topic pattern (Should have failed with 403)");
        } catch (e) {
            if (e.response && e.response.status === 403) {
                success("POST forbidden topic pattern correctly blocked with 403");
            } else {
                fail("POST forbidden topic pattern", e);
            }
        }

        // --- 3. Test Webhook Subscription (Allowed) ---
        title("Test Webhook Subscription (Allowed)");
        let webhookId;
        try {
            const res = await axios.post(`${ROOT_URL}${SUBSCRIBE_PATH}`, {
                topic: "test/webhook/alerts",
                url: `http://localhost:${WEBHOOK_PORT}/callback`,
                min_interval_ms: 500
            });
            if (res.status === 201 && res.data.success) {
                webhookId = res.data.id;
                success(`Registered webhook for allowed topic pattern. ID: ${webhookId}`);
            } else {
                fail("Webhook registration failed", { message: `Status: ${res.status}` });
            }
        } catch (e) {
            fail("Webhook registration failed", e);
        }

        // --- 4. Test Webhook Triggering ---
        if (webhookId) {
            title("Test Webhook Triggering");
            receivedWebhooks = [];
            
            // Ingest something that should trigger the webhook
            // Note: We use the SAME http-test provider to ingest, but we could use MQTT or anything else.
            // But we must ensure http-test is ALLOWED to publish on 'test/webhook/alerts' for this test to work simply.
            // OR we use the allowed pattern 'test/ingest/temp' but register the webhook on it.
            
            info("Re-registering webhook on 'test/ingest/temp' for easier triggering...");
            await axios.post(`${ROOT_URL}${SUBSCRIBE_PATH}`, {
                topic: "test/ingest/temp",
                url: `http://localhost:${WEBHOOK_PORT}/callback`,
                min_interval_ms: 100
            });

            info("Ingesting data to trigger webhook...");
            await axios.post(`${ROOT_URL}${INGEST_PATH}/test/ingest/temp`, { trigger: 'ping' });
            
            // Wait a bit for the webhook execution
            await new Promise(r => setTimeout(r, 1000));
            
            if (receivedWebhooks.length > 0) {
                success(`Webhook triggered and received! Payload: ${JSON.stringify(receivedWebhooks[0].payload)}`);
            } else {
                fail("Webhook not received after ingestion.");
            }
        }

        // --- 5. Test Anti-Flood Protection ---
        title("Test Anti-Flood Protection");
        receivedWebhooks = [];
        const fastWebhookTopic = "test/ingest/flood";
        
        info("Registering webhook with 2s interval...");
        await axios.post(`${ROOT_URL}${SUBSCRIBE_PATH}`, {
            topic: fastWebhookTopic,
            url: `http://localhost:${WEBHOOK_PORT}/callback`,
            min_interval_ms: 2000
        });

        info("Sending 3 rapid messages (should only receive 1)...");
        await axios.post(`${ROOT_URL}${INGEST_PATH}/${fastWebhookTopic}`, { n: 1 });
        await axios.post(`${ROOT_URL}${INGEST_PATH}/${fastWebhookTopic}`, { n: 2 });
        await axios.post(`${ROOT_URL}${INGEST_PATH}/${fastWebhookTopic}`, { n: 3 });

        await new Promise(r => setTimeout(r, 1000));

        if (receivedWebhooks.length === 1) {
            success("Anti-flood protection active: Only 1 webhook received out of 3 rapid calls.");
        } else {
            fail(`Anti-flood protection failed: Received ${receivedWebhooks.length} webhooks instead of 1.`);
        }

    } catch (e) {
        console.error("Unexpected error in test runner:", e);
    } finally {
        if (webhookServer) {
            webhookServer.close();
            info("Mock Webhook Receiver stopped.");
        }
    }

    console.log(`\n${colors.green}=== HTTP Connector Tests Complete ===${colors.reset}\n`);
}

runTests();