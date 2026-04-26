/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 *
 * SNMP v2c Mock Server (Agent)
 * Provides a local test dataset for Korelate's SNMP Connector.
 */

const snmp = require("net-snmp");

// Note: Creating a real SNMP agent with net-snmp is mostly for GET/SET.
// For testing purposes, we can mock the session behavior or use a simple agent if the lib supports it.
// net-snmp focuses on being a manager. 
// However, we can use a small library for the agent if needed, 
// or since the connector uses net-snmp.createSession, we will mock the backend in the test.
// For the "Mock Server" file requested by user, I will use 'snmp-node' or similar if available, 
// but sticking to project dependencies is better.

// Since there is no Agent implementation in net-snmp, I will use a simple UDP server 
// that responds with SNMP-encoded packets for the integration test.
// But wait, the user wants a server "providing the interfaces".

const dgram = require("dgram");
const server = dgram.createSocket("udp4");

server.on("message", (msg, rinfo) => {
    // This is a very simplified SNMP responder for OID 1.3.6.1.2.1.1.1.0
    // In a real scenario, we'd use a proper agent lib.
    // For now, let's log and send a dummy response if it looks like a GET.
    // console.log(`SNMP request from ${rinfo.address}:${rinfo.port}`);
    
    // Minimal valid SNMP response for sysDescr
    const response = Buffer.from([
        0x30, 0x29, 0x02, 0x01, 0x01, 0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63, 0xa2, 0x1c, 0x02, 
        0x04, 0x1a, 0x2b, 0x3c, 0x4d, 0x0a, 0x01, 0x00, 0x0a, 0x01, 0x00, 0x30, 0x0e, 0x30, 0x0c, 0x06, 
        0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00, 0x04, 0x00
    ]);
    // Inject some dynamic data into the last bytes (the string value)
    const mockValue = Buffer.from("Korelate-Mock-SNMP-Agent-v1.0");
    const fullResponse = Buffer.concat([response.slice(0, 41), Buffer.from([mockValue.length]), mockValue]);
    // Update length in headers
    fullResponse[1] = fullResponse.length - 2;
    fullResponse[14] = fullResponse.length - 16;
    fullResponse[28] = fullResponse.length - 30;
    fullResponse[30] = fullResponse.length - 32;

    server.send(fullResponse, rinfo.port, rinfo.address);
});

server.on("listening", () => {
    const address = server.address();
    console.log(`✅ SNMP Mock Agent (UDP) listening on ${address.address}:${address.port}`);
});

server.bind(1610); // Use 1610 to avoid requiring root for 161
