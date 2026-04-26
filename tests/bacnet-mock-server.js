/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 *
 * BACnet/IP Mock Server
 * Provides a local test dataset for Korelate's BACnet Connector.
 */

const bacnet = require("node-bacnet");

// Note: node-bacnet doesn't have a high-level 'Server' class but can listen and respond.
const client = new bacnet({ port: 47809 }); // Use 47809 to avoid conflict with standard 47808

client.on("whoIs", (data) => {
    console.log("BACnet: Received Who-Is from", data.address);
    client.iAmResponse(data.address, 1234, bacnet.enum.Segmentation.SEGMENTATION_BOTH, 123);
});

client.on("readProperty", (data) => {
    console.log(`BACnet: ReadProperty for Object ${data.request.objectId.type}:${data.request.objectId.instance}, Property ${data.request.property.id}`);
    
    let value = 0;
    if (data.request.objectId.instance === 1) value = 22.5 + Math.random();
    else if (data.request.objectId.instance === 2) value = 45.0 + Math.random() * 5;

    client.readPropertyResponse(data.address, data.invokeId, data.request.objectId, data.request.property, [
        { type: bacnet.enum.ApplicationTag.REAL, value: value }
    ]);
});

console.log("✅ BACnet Mock Server listening on port 47809");
