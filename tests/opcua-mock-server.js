/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 *
 * Mini OPC UA Mock Server
 * Provides a local test dataset for Korelate's OPC UA Connector.
 * Run with: node tests/opcua-mock-server.js
 */

const { OPCUAServer, Variant, DataType } = require("node-opcua");

(async () => {
    try {
        // 1. Initialize the OPC UA Server
        const server = new OPCUAServer({
            port: 4334, // Custom port to avoid conflicts
            resourcePath: "/UA/KorelateMock",
            buildInfo: {
                productName: "KorelateMockServer",
                buildNumber: "1.0",
                buildDate: new Date()
            }
        });

        await server.initialize();
        console.log("✅ OPC UA Server initialized.");

        const addressSpace = server.engine.addressSpace;
        const namespace = addressSpace.getOwnNamespace();

        // 2. Create a custom device folder in the address space
        const device = namespace.addObject({
            organizedBy: addressSpace.rootFolder.objects,
            browseName: "KorelateTestLine"
        });

        // 3. Define local state variables for simulation
        let temperature = 22.0;
        let pressure = 1.0;
        let isRunning = true;

        // 4. Bind variables to the address space
        // Temperature Node
        namespace.addVariable({
            componentOf: device,
            nodeId: "ns=1;s=Temperature",
            browseName: "Temperature",
            dataType: "Double",
            value: {
                get: () => new Variant({ dataType: DataType.Double, value: temperature })
            }
        });

        // Pressure Node
        namespace.addVariable({
            componentOf: device,
            nodeId: "ns=1;s=Pressure",
            browseName: "Pressure",
            dataType: "Double",
            value: {
                get: () => new Variant({ dataType: DataType.Double, value: pressure })
            }
        });

        // Status Node (Boolean)
        namespace.addVariable({
            componentOf: device,
            nodeId: "ns=1;s=IsRunning",
            browseName: "IsRunning",
            dataType: "Boolean",
            value: {
                get: () => new Variant({ dataType: DataType.Boolean, value: isRunning })
            }
        });

        // 5. Simulation loop: Update values dynamically every second
        setInterval(() => {
            // Temperature fluctuates on a sine wave between ~7 and ~37
            temperature = 22.0 + Math.sin(Date.now() / 5000) * 15.0; 
            // Pressure has some random noise
            pressure = 1.0 + Math.random() * 0.5; 
            // 5% chance of the machine stopping briefly
            isRunning = Math.random() > 0.05; 
        }, 1000);

        // 6. Start the server
        await server.start();
        
        console.log("\n==================================================");
        console.log("🚀 Mini OPC UA Mock Server is running!");
        console.log(`📡 Endpoint URL: opc.tcp://localhost:${server.endpoints[0].port}/UA/KorelateMock`);
        console.log("==================================================\n");
        
        console.log("💡 To connect Korelate to this mock server, add the following object");
        console.log("   to the DATA_PROVIDERS array in your data/.env file:\n");
        console.log(`{
  "id": "test_opc",
  "type": "opcua",
  "endpointUrl": "opc.tcp://localhost:4334/UA/KorelateMock",
  "subscribe": [
    { "nodeId": "ns=1;s=Temperature", "topic": "uns/test_line/temperature" },
    { "nodeId": "ns=1;s=Pressure", "topic": "uns/test_line/pressure" },
    { "nodeId": "ns=1;s=IsRunning", "topic": "uns/test_line/status" }
  ]
}`);
        console.log("\n==================================================");

    } catch (err) {
        console.error("❌ Error starting OPC UA Server:", err);
        process.exit(1);
    }
})();