/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 *
 * Advanced I3X Test Suite
 * Focus: maxDepth recursion, EngUnit metadata, and Historical VQT arrays.
 */
import axios from 'axios';

const PORT = 8080;
const API_URL = `http://localhost:${PORT}/api/i3x`;
const AUTH_URL = `http://localhost:${PORT}/auth/login`;

const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    blue: "\x1b[34m",
    yellow: "\x1b[33m",
};

let sessionCookie = null;

async function authenticate() {
    console.log(`${colors.blue}=== I3X ADVANCED FEATURES TEST ===${colors.reset}\n`);
    const res = await axios.post(AUTH_URL, { username: 'admin', password: 'admin' });
    sessionCookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
}

async function run() {
    await authenticate();
    const headers = { 'Cookie': sessionCookie };

    try {
        // 1. Find a composition object (e.g. a Machine with sensors)
        const objects = await axios.get(`${API_URL}/objects`, { headers });
        const composite = objects.data.find(o => o.isComposition === true);

        if (!composite) {
            console.log("⚠️ No composite objects found in model. Skipping recursion tests.");
        } else {
            console.log(`Testing Recursive Value for: ${composite.elementId}`);
            
            // 2. Test maxDepth=0 (Infinite recursion)
            const val = await axios.post(`${API_URL}/objects/value`, { 
                elementIds: [composite.elementId],
                maxDepth: 0 
            }, { headers });

            const node = val.data[composite.elementId];
            const childrenKeys = Object.keys(node).filter(k => k !== 'data');
            
            if (childrenKeys.length > 0) {
                console.log(`  ${colors.green}✔ PASS:${colors.reset} Recursion found ${childrenKeys.length} child elements.`);
            } else {
                console.log(`  ${colors.yellow}ℹ Info:${colors.reset} Composition flag is true but no children were returned. Check parentId mappings.`);
            }

            // 3. Test Unit Extraction
            const hasUnits = JSON.stringify(val.data).includes('engUnit');
            if (hasUnits) {
                console.log(`  ${colors.green}✔ PASS:${colors.reset} EngUnit metadata detected in VQT response.`);
            } else {
                console.log(`  ${colors.yellow}ℹ Info:${colors.reset} No EngUnits found. Add 'unit' to your MQTT payloads or 'engUnit' to semantic model.`);
            }
        }

        // 4. Test Historical Array structure
        const firstId = objects.data[0].elementId;
        const history = await axios.post(`${API_URL}/objects/history`, { 
            elementIds: [firstId],
            startTime: new Date(Date.now() - 3600000).toISOString() // Last hour
        }, { headers });

        if (history.data[firstId] && Array.isArray(history.data[firstId].data)) {
            console.log(`  ${colors.green}✔ PASS:${colors.reset} POST /history returned a VQT array (${history.data[firstId].data.length} pts).`);
        }

    } catch (e) {
        console.error("❌ Test failed:", e.message);
    }
}

run();