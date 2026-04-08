/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Siemens S7 Communication Provider Plugin
 * Implements the BaseProvider interface for Siemens S7 PLC connections.
 */

let nodes7;
try {
    nodes7 = require('nodes7');
} catch (e) {
    nodes7 = null;
}

const BaseProvider = require('../baseProvider');

class S7Provider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        this.host = config.host || '127.0.0.1';
        this.port = parseInt(config.port, 10) || 102;
        this.rack = parseInt(config.rack, 10) || 0;
        this.slot = parseInt(config.slot, 10) || 1;
        this.pollingInterval = parseInt(config.pollingInterval, 10) || 1000;
        
        // Mappings in format: "DB1,REAL4::factory/temp"
        this.subscribeList = config.subscribe || [];
        this.mappings = {}; // { 'DB1,REAL4': 'factory/temp' }
        this.s7Tags = [];   // ['DB1,REAL4']
        
        this.pollIntervalId = null;
        this.client = null;
    }

    async connect() {
        if (!nodes7) {
            this.logger.error("❌ 'nodes7' library is missing. Please run: npm install nodes7");
            this.updateStatus('error', 'Missing library');
            return false;
        }

        this.updateStatus('connecting');
        this.logger.info(`Connecting to Siemens S7 PLC at ${this.host}:${this.port} (Rack: ${this.rack}, Slot: ${this.slot})...`);

        // Parse Mappings
        this.subscribeList.forEach(mappingStr => {
            const parts = mappingStr.split('::');
            if (parts.length === 2) {
                const tag = parts[0].trim();
                const topic = parts[1].trim();
                this.mappings[tag] = topic;
                this.s7Tags.push(tag);
            }
        });

        return new Promise((resolve) => {
            this.client = new nodes7();
            
            this.client.initiateConnection({ 
                port: this.port, 
                host: this.host, 
                rack: this.rack, 
                slot: this.slot 
            }, (err) => {
                if (err) {
                    this.logger.error({ err }, "❌ Failed to connect to S7 PLC.");
                    this.updateStatus('error', err.message || "Connection refused");
                    resolve(false);
                    return;
                }

                this.logger.info(`✅ Connected to Siemens S7 PLC.`);
                this.connected = true;
                this.updateStatus('connected');
                
                // Add translation variables
                this.client.setTranslationCB((tag) => tag); // Keep raw tag names
                this.client.addItems(this.s7Tags);

                this.startPolling();
                resolve(true);
            });
            
            this.client.on('error', (err) => {
                this.logger.error({ err }, "S7 Connection Error");
                this.connected = false;
                this.updateStatus('error', err.message);
            });
        });
    }

    startPolling() {
        if (this.s7Tags.length === 0) return;

        this.pollIntervalId = setInterval(() => {
            if (!this.connected || !this.client) return;

            this.client.readAllItems((err, values) => {
                if (err) {
                    this.logger.warn(`S7 read error: ${err}`);
                    return;
                }
                
                for (const tag in values) {
                    const topic = this.mappings[tag];
                    if (topic) {
                        this.handleIncomingMessage(topic, {
                            value: values[tag],
                            timestamp: new Date().toISOString(),
                            quality: "Good" // S7 lib handles bad quality by throwing errors mostly
                        });
                    }
                }
            });
        }, this.pollingInterval);
    }

    async disconnect() {
        if (this.pollIntervalId) clearInterval(this.pollIntervalId);
        this.connected = false;
        
        if (this.client) {
            try {
                this.client.dropConnection(() => {
                    this.logger.info(`S7 connection closed.`);
                    this.updateStatus('disconnected');
                    this.client = null;
                });
            } catch(e) {}
        }
    }

    publish(topic, payload, options, callback) {
        // Find mapping
        const tag = Object.keys(this.mappings).find(key => this.mappings[key] === topic);
        if (!tag) return callback(new Error(`No S7 mapping found for topic ${topic}`));

        let valueToWrite = payload;
        try {
            const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (obj && obj.value !== undefined) valueToWrite = obj.value;
        } catch(e) {}

        this.client.writeItems(tag, valueToWrite, (err) => {
            if (err) callback(err);
            else callback(null);
        });
    }
}

module.exports = S7Provider;