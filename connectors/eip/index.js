/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * EtherNet/IP (CIP) Provider Plugin
 * Implements the BaseProvider interface for EtherNet/IP PLC connections (Allen-Bradley, Omron, etc.).
 */

let ENIP;
try {
    ENIP = require('ethernet-ip');
} catch (e) {
    ENIP = null;
}

const BaseProvider = require('../baseProvider');

class EipProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        this.host = config.host || '127.0.0.1';
        this.port = parseInt(config.port, 10) || 44818;
        this.routing = config.routing || [0x01, 0x00]; // Port 1, Slot 0
        this.pollingInterval = parseInt(config.pollingInterval, 10) || 1000;
        
        // Mappings in format: "MyTag.SubTag::factory/temp"
        this.subscribeList = config.subscribe || [];
        this.mappings = {}; 
        
        this.pollIntervalId = null;
        this.plc = null;
    }

    async connect() {
        if (!ENIP) {
            this.logger.error("❌ 'ethernet-ip' library is missing. Please run: npm install ethernet-ip");
            this.updateStatus('error', 'Missing library');
            return false;
        }

        this.updateStatus('connecting');
        this.logger.info(`Connecting to EtherNet/IP PLC at ${this.host}:${this.port}...`);

        // Parse Mappings
        this.subscribeList.forEach(mappingStr => {
            const parts = mappingStr.split('::');
            if (parts.length === 2) {
                const tag = parts[0].trim();
                const topic = parts[1].trim();
                this.mappings[tag] = topic;
            }
        });

        try {
            let routingArr = this.routing;
            if (typeof routingArr === 'string') {
                try { routingArr = JSON.parse(routingArr); } catch(e) { routingArr = [0x01, 0x00]; }
            }

            this.plc = new ENIP.Controller();
            
            await this.plc.connect(this.host, this.port);
            this.logger.info(`✅ Connected to EtherNet/IP PLC.`);
            this.connected = true;
            this.updateStatus('connected');
            
            this.startPolling();
            return true;
        } catch (err) {
            this.logger.error({ err }, "❌ Failed to connect to EtherNet/IP PLC.");
            this.updateStatus('error', err.message);
            return false;
        }
    }

    startPolling() {
        const tagsToRead = Object.keys(this.mappings);
        if (tagsToRead.length === 0) return;

        // Create Tag objects
        const tagObjects = tagsToRead.map(tagName => new ENIP.Tag(tagName));

        this.pollIntervalId = setInterval(async () => {
            if (!this.connected || !this.plc) return;

            try {
                // Read all tags
                for (const tag of tagObjects) {
                    await this.plc.readTag(tag);
                    const topic = this.mappings[tag.name];
                    if (topic && tag.value !== null) {
                        this.handleIncomingMessage(topic, {
                            value: tag.value,
                            timestamp: new Date().toISOString(),
                            quality: "Good" 
                        });
                    }
                }
            } catch (err) {
                this.logger.warn(`EtherNet/IP read error: ${err.message}`);
            }
        }, this.pollingInterval);
    }

    async disconnect() {
        if (this.pollIntervalId) clearInterval(this.pollIntervalId);
        this.connected = false;
        
        if (this.plc) {
            try {
                await this.plc.disconnect();
                this.logger.info(`EtherNet/IP connection closed.`);
                this.updateStatus('disconnected');
            } catch(e) {}
            this.plc = null;
        }
    }

    publish(topic, payload, options, callback) {
        // Find mapping
        const tagName = Object.keys(this.mappings).find(key => this.mappings[key] === topic);
        if (!tagName) return callback(new Error(`No EtherNet/IP mapping found for topic ${topic}`));

        let valueToWrite = payload;
        try {
            const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (obj && obj.value !== undefined) valueToWrite = obj.value;
        } catch(e) {}

        if (!this.plc) return callback(new Error("Not connected"));

        const tag = new ENIP.Tag(tagName);
        this.plc.readTag(tag).then(() => {
            tag.value = valueToWrite;
            return this.plc.writeTag(tag);
        }).then(() => callback(null)).catch(callback);
    }
}

module.exports = EipProvider;