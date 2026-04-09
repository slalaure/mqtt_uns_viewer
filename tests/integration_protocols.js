/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Integration Test Suite for Protocol Connectors
 * 
 * This script establishes REAL protocol connections to the local Docker simulators
 * to prove that the Handshakes, Read/Write formats, and Data streams work correctly.
 */

const mqtt = require('mqtt');
const ModbusRTU = require('modbus-serial');
const axios = require('axios');
const { Client } = require('pg');
const snmp = require('net-snmp');
const { Kafka } = require('kafkajs');

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

    // ---------------------------------------------------------
    // 1. MQTT (Pub/Sub Protocol)
    // ---------------------------------------------------------
    await new Promise((resolve) => {
        try {
            const client = mqtt.connect('mqtt://localhost:1883', { connectTimeout: TIMEOUT_MS });
            
            const timeout = setTimeout(() => {
                report("MQTT", false, "Connection timeout");
                client.end();
                resolve();
            }, TIMEOUT_MS);

            client.on('connect', () => {
                client.subscribe('integration/test', (err) => {
                    if (err) {
                        report("MQTT", false, "Subscribe error");
                        resolve();
                    } else {
                        client.publish('integration/test', 'protocol-respected');
                    }
                });
            });

            client.on('message', (topic, message) => {
                if (topic === 'integration/test' && message.toString() === 'protocol-respected') {
                    clearTimeout(timeout);
                    report("MQTT", true, "Handshake, Pub & Sub validated on Mosquitto.");
                    client.end();
                    resolve();
                }
            });
            
            client.on('error', (err) => {
                clearTimeout(timeout);
                report("MQTT", false, err.message);
                resolve();
            });
        } catch (err) {
            report("MQTT", false, err.message);
            resolve();
        }
    });

    // ---------------------------------------------------------
    // 2. MODBUS TCP (Industrial Handshake & Registers)
    // ---------------------------------------------------------
    try {
        const client = new ModbusRTU();
        client.setTimeout(TIMEOUT_MS);
        await client.connectTCP("127.0.0.1", { port: 5020 });
        client.setID(1);
        
        // Write to register 10 then read it to prove logic
        await client.writeRegister(10, 4242);
        const data = await client.readHoldingRegisters(10, 1);
        
        if (data.data && data.data[0] === 4242) {
            report("Modbus TCP", true, `Read/Write successful. Register 10 = ${data.data[0]}`);
        } else {
            report("Modbus TCP", false, "Data mismatch");
        }
        client.close();
    } catch (err) {
        report("Modbus TCP", false, err.message);
    }

    // ---------------------------------------------------------
    // 3. REST / HTTP (API Poller)
    // ---------------------------------------------------------
    try {
        // Query the Prism Mock Server (Petstore OpenAPI)
        const res = await axios.get('http://localhost:3001/pets', { timeout: TIMEOUT_MS });
        if (Array.isArray(res.data) && res.data.length > 0) {
            report("REST Mock", true, `GET /pets returned array of ${res.data.length} mock items.`);
        } else {
            report("REST Mock", false, "Invalid JSON structure returned.");
        }
    } catch (err) {
        report("REST Mock", false, err.message);
    }

    // ---------------------------------------------------------
    // 4. POSTGRESQL (SQL Database Poller)
    // ---------------------------------------------------------
    try {
        const pgClient = new Client({
            connectionString: 'postgres://postgres:password@localhost:5432/korelate',
            connectionTimeoutMillis: TIMEOUT_MS
        });
        await pgClient.connect();
        
        // Execute real SQL protocol query
        const res = await pgClient.query('SELECT 100 AS valid_ping');
        if (res.rows && res.rows[0].valid_ping === 100) {
            report("PostgreSQL", true, "Connection and SELECT query validated.");
        } else {
            report("PostgreSQL", false, "Query failed");
        }
        await pgClient.end();
    } catch (err) {
        report("PostgreSQL", false, err.message);
    }

    // ---------------------------------------------------------
    // 5. SNMP (Network Protocol)
    // ---------------------------------------------------------
    await new Promise((resolve) => {
        try {
            // Using standard SNMP simulator port 161
            const session = snmp.createSession("127.0.0.1", "public", { port: 161, retries: 1, timeout: 2000 });
            const oids = ["1.3.6.1.2.1.1.1.0"]; // sysDescr standard OID
            
            session.get(oids, (err, varbinds) => {
                if (err) {
                    report("SNMP v2c", false, err.message);
                } else {
                    if (snmp.isVarbindError(varbinds[0])) {
                        report("SNMP v2c", false, snmp.varbindError(varbinds[0]));
                    } else {
                        const val = varbinds[0].value.toString();
                        report("SNMP v2c", true, `sysDescr OID fetched: "${val.substring(0, 40)}..."`);
                    }
                }
                session.close();
                resolve();
            });
        } catch (err) {
            report("SNMP v2c", false, err.message);
            resolve();
        }
    });

    // ---------------------------------------------------------
    // 6. APACHE KAFKA (Broker Metadata Fetch)
    // ---------------------------------------------------------
    try {
        const kafka = new Kafka({
            clientId: 'korelate-test',
            brokers: ['localhost:9092'],
            connectionTimeout: TIMEOUT_MS
        });
        const admin = kafka.admin();
        await admin.connect();
        const topics = await admin.listTopics();
        
        if (Array.isArray(topics)) {
            report("Kafka", true, `Admin client connected. Broker has ${topics.length} topics.`);
        } else {
            report("Kafka", false, "Failed to fetch topics.");
        }
        await admin.disconnect();
    } catch (err) {
        report("Kafka", false, err.message);
    }

    console.log("\n==========================================");
    console.log(`📊 SUMMARY: ${passed} Passed | ${failed} Failed`);
    console.log("==========================================");
    
    if (failed > 0) process.exit(1);
    process.exit(0);
}

runTests();
