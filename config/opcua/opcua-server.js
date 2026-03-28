/**
 * Simple OPC UA Server for local testing/development
 * Provides sample data with various node types and periodic updates
 */

const {
    OPCUAServer,
    Variant,
    DataType,
    StatusCodes,
    NodeClass,
    AttributeIds
} = require("node-opcua");

const pino = require('pino');
const logger = pino();

const PORT = parseInt(process.env.OPCUA_PORT, 10) || 4840;
const ENDPOINT_URL = `opc.tcp://0.0.0.0:${PORT}`;

async function startOpcUaServer() {
    logger.info(`Starting OPC UA Server on ${ENDPOINT_URL}`);

    const server = new OPCUAServer({
        port: PORT,
        resourcePath: "/",
        buildInfo: {
            productName: "MQTT UNS Viewer - Local Test Server",
            productUri: "http://mqtt-uns-viewer/",
            manufacturerName: "MQTT UNS Viewer",
            softwareVersion: "1.0",
            buildNumber: "0",
            buildDate: new Date()
        }
    });

    await server.initialize();

    // Get the Objects folder
    const addressSpace = server.engine.addressSpace;
    const objectsFolder = addressSpace.findNode("ObjectsFolder") || addressSpace.rootFolder.objects;
    if (!objectsFolder) {
        throw new Error("Objects folder not found in OPC UA address space.");
    }

    // Create a custom namespace for our test data
    const namespace = addressSpace.getOwnNamespace();

    // Create main folder for our test equipment
    const testEquipment = namespace.addObject({
        browseName: "TestEquipment",
        organizedBy: objectsFolder
    });

    // Create a simulated pump device
    const pump = namespace.addObject({
        browseName: "Pump_01",
        organizedBy: testEquipment
    });

    // Pump status
    const pumpStatus = namespace.addObject({
        browseName: "Status",
        organizedBy: pump
    });

    namespace.addVariable({
        componentOf: pumpStatus,
        nodeId: "ns=1;s=Pump_01.Status.Running",
        browseName: "Running",
        dataType: DataType.Boolean,
        value: {
            get() {
                return new Variant({
                    dataType: DataType.Boolean,
                    value: Math.random() > 0.5
                });
            }
        }
    });

    namespace.addVariable({
        componentOf: pumpStatus,
        nodeId: "ns=1;s=Pump_01.Status.Speed",
        browseName: "Speed",
        dataType: DataType.Float,
        value: {
            get() {
                return new Variant({
                    dataType: DataType.Float,
                    value: 1000 + Math.random() * 500
                });
            }
        }
    });

    namespace.addVariable({
        componentOf: pumpStatus,
        nodeId: "ns=1;s=Pump_01.Status.Pressure",
        browseName: "Pressure",
        dataType: DataType.Float,
        value: {
            get() {
                return new Variant({
                    dataType: DataType.Float,
                    value: 100 + Math.random() * 50
                });
            }
        }
    });

    // Create a simulated sensor
    const sensor = namespace.addObject({
        browseName: "Sensor_01",
        organizedBy: testEquipment
    });

    namespace.addVariable({
        componentOf: sensor,
        nodeId: "ns=1;s=Sensor_01.Temperature",
        browseName: "Temperature",
        dataType: DataType.Float,
        value: {
            get() {
                return new Variant({
                    dataType: DataType.Float,
                    value: 20 + Math.random() * 30
                });
            }
        }
    });

    namespace.addVariable({
        componentOf: sensor,
        nodeId: "ns=1;s=Sensor_01.Humidity",
        browseName: "Humidity",
        dataType: DataType.Float,
        value: {
            get() {
                return new Variant({
                    dataType: DataType.Float,
                    value: 40 + Math.random() * 50
                });
            }
        }
    });

    // Create a counter variable (writable)
    namespace.addVariable({
        componentOf: sensor,
        nodeId: "ns=1;s=Sensor_01.Counter",
        browseName: "Counter",
        dataType: DataType.Int32,
        value: {
            get() {
                return new Variant({
                    dataType: DataType.Int32,
                    value: Math.floor(Math.random() * 1000)
                });
            }
        }
    });

    // Create a modifiable setpoint
    let setpoint = 25.0;
    namespace.addVariable({
        componentOf: sensor,
        nodeId: "ns=1;s=Sensor_01.Setpoint",
        browseName: "Setpoint",
        dataType: DataType.Float,
        value: new Variant({
            dataType: DataType.Float,
            value: setpoint
        }),
        writable: true,
        getter() {
            return new Variant({
                dataType: DataType.Float,
                value: setpoint
            });
        },
        setter(variant) {
            setpoint = parseFloat(variant.value);
            return StatusCodes.Good;
        }
    });

    // Start the server
    await server.start();
    logger.info(`✅ OPC UA Server running on opc.tcp://localhost:${PORT}`);
    logger.info(`   Browse address space at opc.tcp://localhost:${PORT}/`);

    // Graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Shutting down OPC UA Server...');
        await server.shutdown();
        process.exit(0);
    });
}

startOpcUaServer().catch(err => {
    logger.error(err, 'Failed to start OPC UA Server');
    process.exit(1);
});
