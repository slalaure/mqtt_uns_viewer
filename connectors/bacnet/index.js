/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * BACnet/IP Provider Plugin
 * Implements the BaseProvider interface for BACnet Building Automation systems.
 */

let bacnet;
try {
    bacnet = require('node-bacnet');
} catch (e) {
    bacnet = null;
}

const BaseProvider = require('../baseProvider');

class BacnetProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        this.host = config.host || '0.0.0.0'; // Listen interface
        this.port = parseInt(config.port, 10) || 47808; // 0xBAC0
        this.broadcastAddress = config.broadcastAddress || '255.255.255.255';
        this.targetDeviceIp = config.targetDeviceIp || null; // Specific device to poll
        this.pollingInterval = parseInt(config.pollingInterval, 10) || 5000;
        
        // Mappings format: "Type:Instance:Property::bms/hvac/temp"
        // e.g. "0:1:85::bms/room1/temp" -> AnalogInput(0), Instance 1, PresentValue(85)
        this.subscribeList = config.subscribe || [];
        this.mappings = [];
        
        this.pollIntervalId = null;
        this.client = null;
    }

    async connect() {
        if (!bacnet) {
            this.logger.error("❌ 'node-bacnet' library is missing. Please run: npm install node-bacnet");
            this.updateStatus('error', 'Missing library');
            return false;
        }

        this.updateStatus('connecting');
        this.logger.info(`Initializing BACnet/IP client on ${this.host}:${this.port}...`);

        try {
            this.client = new bacnet({
                port: this.port,
                interface: this.host,
                broadcastAddress: this.broadcastAddress
            });

            this.client.on('error', (err) => {
                this.logger.error({ err }, "BACnet Client Error");
                this.connected = false;
                this.updateStatus('error', err.message);
            });

            // Parse Mappings
            this.mappings = this.subscribeList.map(mappingStr => {
                const parts = mappingStr.split('::');
                if (parts.length !== 2) return null;
                
                const bacnetParts = parts[0].split(':');
                if (bacnetParts.length !== 3) return null;

                const objectType = parseInt(bacnetParts[0], 10);
                const objectInstance = parseInt(bacnetParts[1], 10);
                const propertyId = parseInt(bacnetParts[2], 10); // Usually 85 for PresentValue
                const topic = parts[1].trim();

                return { 
                    objectId: { type: objectType, instance: objectInstance }, 
                    propertyId: propertyId, 
                    topic: topic,
                    rawString: parts[0]
                };
            }).filter(Boolean);

            this.logger.info(`✅ BACnet/IP Client initialized. Ready to poll ${this.mappings.length} objects.`);
            this.connected = true;
            this.updateStatus('connected');
            
            if (this.targetDeviceIp) {
                this.startPolling();
            } else {
                this.logger.warn("BACnet Client is running, but no 'Target Device IP' was provided. Polling is disabled.");
            }

            return true;
        } catch (err) {
            this.logger.error({ err }, "❌ Failed to initialize BACnet/IP client.");
            this.updateStatus('error', err.message);
            return false;
        }
    }

    startPolling() {
        if (this.mappings.length === 0 || !this.targetDeviceIp) return;

        this.pollIntervalId = setInterval(() => {
            if (!this.connected || !this.client) return;

            for (const map of this.mappings) {
                this.client.readProperty(
                    this.targetDeviceIp,
                    map.objectId,
                    map.propertyId,
                    (err, value) => {
                        if (err) {
                            this.logger.warn(`BACnet read error on ${map.rawString} at ${this.targetDeviceIp}: ${err.message}`);
                            return;
                        }
                        
                        if (value && value.values && value.values.length > 0) {
                            // BACnet typically returns an array of values for a property
                            const payload = value.values[0].value;
                            this.handleIncomingMessage(map.topic, {
                                value: payload,
                                timestamp: new Date().toISOString(),
                                objectType: map.objectId.type,
                                instance: map.objectId.instance
                            });
                        }
                    }
                );
            }
        }, this.pollingInterval);
    }

    async disconnect() {
        if (this.pollIntervalId) clearInterval(this.pollIntervalId);
        this.connected = false;
        
        if (this.client) {
            try {
                this.client.close();
                this.logger.info(`BACnet/IP client closed.`);
                this.updateStatus('disconnected');
            } catch(e) {}
            this.client = null;
        }
    }

    publish(topic, payload, options, callback) {
        if (!this.client || !this.targetDeviceIp) {
            return callback(new Error("BACnet client not connected or Target IP not set"));
        }

        // Find mapping
        const map = this.mappings.find(m => m.topic === topic);
        if (!map) return callback(new Error(`No BACnet mapping found for topic ${topic}`));

        let valueToWrite = payload;
        try {
            const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (obj && obj.value !== undefined) valueToWrite = obj.value;
        } catch(e) {}

        // BACnet write requires type guessing. We'll assume Real (4) or Boolean (9) for simplicity in this basic connector.
        let bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_REAL;
        if (typeof valueToWrite === 'boolean') {
            bacnetType = bacnet.enum.ApplicationTags.BACNET_APPLICATION_TAG_BOOLEAN;
        }

        this.client.writeProperty(
            this.targetDeviceIp,
            map.objectId,
            map.propertyId,
            [{ type: bacnetType, value: valueToWrite }],
            (err, value) => {
                if (err) callback(err);
                else callback(null);
            }
        );
    }
}

module.exports = BacnetProvider;