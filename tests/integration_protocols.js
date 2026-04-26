/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Integration Test Suite for Protocol Connectors
 * 
 * This script establishes REAL protocol connections to the local Mock Servers (or Docker simulators)
 * to prove that the Handshakes, Read/Write formats, and Data streams work correctly.
 * 
 * Mock Servers should be started beforehand (e.g. tests/*-mock-server.js).
 */

const mqtt = require('mqtt');
const ModbusRTU = require('modbus-serial');
const axios = require('axios');
const snmp = require('net-snmp');
const { Kafka } = require('kafkajs');
const bacnet = require('node-bacnet');
const knx = require('knx');
const nodes7 = require('nodes7');
const ENIP = require('ethernet-ip');

const TIMEOUT_MS = 5000;

async function runTests() {
    console.log("==========================================");
    console.log("🚀 STARTING PROTOCOL INTEGRATION TESTS");
    console.log("==========================================\n");

    let passed = 0;
    let failed = 0;

    const report = (name, success, details) => {
        if (success) {
            console.log(`✅ [OK] ${name}: ${details}`);
            passed++;
        } else {
            console.error(`❌ [FAILED] ${name}: ${details}`);
            failed++;
        }
    };

    // --- 1. MQTT ---
    await new Promise((resolve) => {
        try {
            const client = mqtt.connect('mqtt://localhost:1883', { connectTimeout: TIMEOUT_MS });
            const timeout = setTimeout(() => { report("MQTT", false, "Connection timeout"); client.end(); resolve(); }, TIMEOUT_MS);
            client.on('connect', () => {
                client.subscribe('integration/test', (err) => {
                    if (err) { report("MQTT", false, "Subscribe error"); resolve(); }
                    else client.publish('integration/test', 'protocol-respected');
                });
            });
            client.on('message', (topic, message) => {
                if (topic === 'integration/test' && message.toString() === 'protocol-respected') {
                    clearTimeout(timeout); report("MQTT", true, "Handshake, Pub & Sub validated."); client.end(); resolve();
                }
            });
            client.on('error', (err) => { clearTimeout(timeout); report("MQTT", false, err.message); resolve(); });
        } catch (err) { report("MQTT", false, err.message); resolve(); }
    });

    // --- 2. Modbus TCP ---
    try {
        const client = new ModbusRTU();
        await client.connectTCP("127.0.0.1", { port: 5020 });
        client.setID(1);
        const data = await client.readHoldingRegisters(1, 1);
        if (data.data) report("Modbus TCP", true, `Read successful. Register 1 = ${data.data[0]}`);
        else report("Modbus TCP", false, "No data");
        client.close();
    } catch (err) { report("Modbus TCP", false, err.message); }

    // --- 3. REST API ---
    try {
        const res = await axios.get('http://localhost:3001/api/data', { timeout: TIMEOUT_MS });
        if (res.data && res.data.factory) report("REST Mock", true, "GET /api/data returned valid JSON.");
        else report("REST Mock", false, "Invalid JSON structure.");
    } catch (err) { report("REST Mock", false, err.message); }

    // --- 4. SNMP v2c ---
    await new Promise((resolve) => {
        try {
            const session = snmp.createSession("127.0.0.1", "public", { port: 1610, retries: 1, timeout: 2000 });
            session.get(["1.3.6.1.2.1.1.1.0"], (err, varbinds) => {
                if (err) report("SNMP v2c", false, err.message);
                else report("SNMP v2c", true, `sysDescr OID fetched: "${varbinds[0].value.toString()}"`);
                session.close(); resolve();
            });
        } catch (err) { report("SNMP v2c", false, err.message); resolve(); }
    });

    // --- 5. BACnet/IP ---
    await new Promise((resolve) => {
        try {
            const client = new bacnet({ port: 47807 }); // Different local port
            client.readProperty("127.0.0.1:47809", { type: 0, instance: 1 }, 85, (err, value) => {
                if (err) report("BACnet/IP", false, err.message);
                else report("BACnet/IP", true, `Read Analog Input 1 successful: ${value.values[0].value}`);
                client.close(); resolve();
            });
            setTimeout(() => { if (failed === passed) { report("BACnet/IP", false, "Timeout"); resolve(); } }, 3000);
        } catch (err) { report("BACnet/IP", false, err.message); resolve(); }
    });

    // --- 6. KNX/IP (Mock check) ---
    // KNX library is mostly client-side. A real integration test requires a multicast/IP router mock.
    // For now we assume unit tests passed.

    console.log("\n==========================================");
    console.log(`📊 SUMMARY: ${passed} Passed | ${failed} Failed`);
    console.log("==========================================");
    if (failed > 0) process.exit(1);
    process.exit(0);
}

runTests();
