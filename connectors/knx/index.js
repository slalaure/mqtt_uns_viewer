/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * KNX/IP Provider Plugin
 * Implements the BaseProvider interface for KNX Home and Building Automation networks.
 */

let knx;
try {
    knx = require('knx');
} catch (e) {
    knx = null;
}

const BaseProvider = require('../baseProvider');

class KnxProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        this.host = config.host || '127.0.0.1'; // KNX/IP Router or Interface IP
        this.port = parseInt(config.port, 10) || 3671;
        this.physAddr = config.physAddr || '1.1.128'; // The physical address of this client on the bus
        
        // Mappings in format: "GroupAddress:DPT::UNS/Topic"
        // e.g. "1/1/1:DPT1.001::bms/light/1"
        this.subscribeList = config.subscribe || [];
        this.mappings = {}; // { '1/1/1': { topic: 'bms/light/1', dpt: 'DPT1.001' } }
        
        this.connection = null;
    }

    async connect() {
        if (!knx) {
            this.logger.error("❌ 'knx' library is missing. Please run: npm install knx");
            this.updateStatus('error', 'Missing library');
            return false;
        }

        this.updateStatus('connecting');
        this.logger.info(`Connecting to KNX/IP Gateway at ${this.host}:${this.port} (Physical Address: ${this.physAddr})...`);

        // Parse Mappings
        this.subscribeList.forEach(mappingStr => {
            const parts = mappingStr.split('::');
            if (parts.length === 2) {
                const knxConfig = parts[0].trim().split(':'); // "1/1/1", "DPT1.001"
                if (knxConfig.length > 0) {
                    const groupAddr = knxConfig[0].trim();
                    const dpt = knxConfig.length > 1 ? knxConfig[1].trim() : 'DPT1.001'; // Default to boolean if missing
                    const topic = parts[1].trim();
                    this.mappings[groupAddr] = { topic, dpt };
                }
            }
        });

        return new Promise((resolve) => {
            this.connection = new knx.Connection({
                ipAddr: this.host,
                ipPort: this.port,
                physAddr: this.physAddr,
                suppress_ack_ldatareq: false,
                handlers: {
                    connected: () => {
                        this.logger.info(`✅ Connected to KNX/IP Gateway.`);
                        this.connected = true;
                        this.updateStatus('connected');
                        resolve(true);
                    },
                    event: (evt, src, dest, value) => {
                        // evt could be 'GroupValue_Write', 'GroupValue_Response'
                        if (evt === 'GroupValue_Write' || evt === 'GroupValue_Response') {
                            const mapping = this.mappings[dest];
                            if (mapping) {
                                // Provide raw or decoded value to UNS
                                // If the library handles DPT conversion implicitly based on the raw buffer, great.
                                // Otherwise, we log it. `knx` lib normally returns decoded buffers.
                                this.handleIncomingMessage(mapping.topic, {
                                    value: value,
                                    sourceAddr: src,
                                    destAddr: dest,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                    },
                    error: (connstatus) => {
                        this.logger.error(`❌ KNX Connection Error: ${connstatus}`);
                        this.connected = false;
                        this.updateStatus('error', connstatus);
                        // If it fails on initial connection
                        if (!this.connected) resolve(false);
                    },
                    disconnected: () => {
                        this.logger.info(`KNX/IP Gateway disconnected.`);
                        this.connected = false;
                        this.updateStatus('disconnected');
                    }
                }
            });
            
            // Connection timeout fallback
            setTimeout(() => {
                if (!this.connected) {
                    this.logger.error("❌ KNX Connection timed out.");
                    this.updateStatus('error', "Timeout");
                    resolve(false);
                }
            }, 5000);
        });
    }

    async disconnect() {
        this.connected = false;
        if (this.connection) {
            try {
                this.connection.Disconnect();
            } catch(e) {}
            this.connection = null;
            this.updateStatus('disconnected');
        }
    }

    publish(topic, payload, options, callback) {
        if (!this.connected || !this.connection) {
            return callback(new Error("KNX Gateway not connected"));
        }

        // Find mapping based on target UNS topic
        let groupAddr = null;
        let dpt = null;
        for (const [addr, config] of Object.entries(this.mappings)) {
            if (config.topic === topic) {
                groupAddr = addr;
                dpt = config.dpt;
                break;
            }
        }

        if (!groupAddr) return callback(new Error(`No KNX Group Address mapped for topic ${topic}`));

        let valueToWrite = payload;
        try {
            const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (obj && obj.value !== undefined) valueToWrite = obj.value;
        } catch(e) {}

        try {
            // Send GroupValueWrite to the bus
            this.connection.write(groupAddr, valueToWrite, dpt);
            callback(null);
        } catch (err) {
            callback(err);
        }
    }
}

module.exports = KnxProvider;