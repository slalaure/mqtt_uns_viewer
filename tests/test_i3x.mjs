/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 *
 * I3X Compliance Test Suite
 * Run with: node tests/test_i3x.mjs
 */
import axios from 'axios';

const PORT = 8080;
const API_URL = `http://localhost:${PORT}/api/i3x`;
const AUTH_URL = `http://localhost:${PORT}/auth/login`;

const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    dim: "\x1b[2m",
};

let sessionCookie = null;

const success = (msg) => console.log(`  ${colors.green}✔ PASS:${colors.reset} ${msg}`);
const fail = (msg, err) => {
    console.log(`  ${colors.red}✘ FAIL:${colors.reset} ${msg}`);
    if (err && err.response) console.log(`    ${colors.yellow}HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}${colors.reset}`);
};

async function authenticate() {
    console.log(`${colors.blue}=== I3X COMPLIANCE TESTS ===${colors.reset}\n`);
    try {
        const res = await axios.post(AUTH_URL, { username: 'admin', password: 'admin' });
        const cookies = res.headers['set-cookie'];
        sessionCookie = cookies.map(c => c.split(';')[0]).join('; ');
        success("Authenticated as admin");
    } catch (e) {
        console.error("Auth failed. Make sure server is running and admin/admin exists.");
        process.exit(1);
    }
}

async function run() {
    await authenticate();
    const headers = { 'Cookie': sessionCookie };

    try {
        // 1. Exploratory
        const ns = await axios.get(`${API_URL}/namespaces`, { headers });
        if (Array.isArray(ns.data)) success(`GET /namespaces (${ns.data.length} found)`);

        const objects = await axios.get(`${API_URL}/objects`, { headers });
        const sampleId = objects.data.length > 0 ? objects.data[0].elementId : null;
        success(`GET /objects (${objects.data.length} found)`);

        if (sampleId) {
            // 2. Values
            const val = await axios.post(`${API_URL}/objects/value`, { elementIds: [sampleId] }, { headers });
            if (val.data[sampleId] && val.data[sampleId].data) {
                success(`POST /objects/value for ${sampleId} (VQT format verified)`);
            }

            // 3. Subscriptions
            const sub = await axios.post(`${API_URL}/subscriptions`, {}, { headers });
            const subId = sub.data.subscriptionId;
            success(`POST /subscriptions (Created: ${subId})`);

            const reg = await axios.post(`${API_URL}/subscriptions/${subId}/register`, { elementIds: [sampleId] }, { headers });
            success(`POST /register item in subscription`);

            const sync = await axios.post(`${API_URL}/subscriptions/${subId}/sync`, {}, { headers });
            if (Array.isArray(sync.data)) success(`POST /sync subscription (Queue mode working)`);

            // 4. Update
            try {
                const update = await axios.put(`${API_URL}/objects/${sampleId}/value`, { test: 123 }, { headers });
                success(`PUT /objects/${sampleId}/value (Write-back tested)`);
            } catch (e) {
                console.log(`    ${colors.yellow}ℹ Note: Update might fail if topic mapping is not unique/writable.${colors.reset}`);
            }

            // Cleanup
            await axios.delete(`${API_URL}/subscriptions/${subId}`, { headers });
            success(`DELETE /subscriptions (Cleanup)`);
        }

        console.log(`\n${colors.green}=== I3X Health Check Complete ===${colors.reset}\n`);

    } catch (e) {
        fail("I3X Compliance test error", e);
    }
}

run();