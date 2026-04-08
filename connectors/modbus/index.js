/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Modbus TCP Provider Plugin
 * Implements the BaseProvider interface for Modbus TCP connections.
 */

let ModbusRTU;
try {
    ModbusRTU = require('modbus-serial');
} catch (e) {
    ModbusRTU = null;
}

const BaseProvider = require('../baseProvider');

class ModbusProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        this.host = config.host || '127.0.0.1';
        this.port = parseInt(config.port, 10) || 502;
        this.unitId = parseInt(config.unitId, 10) || 1;
        this.pollingInterval = parseInt(config.pollingInterval, 10) || 1000;
        
        // Mappings in format: "40001:16::factory/temp" (Address:Length::UNSTopic)
        this.subscribeList = config.subscribe || [];
        this.mappings = [];
        this.pollIntervalId = null;
        this.client = null;
    }

    async connect() {
        if (!ModbusRTU) {
            this.logger.error("❌ 'modbus-serial' library is missing. Please run: npm install modbus-serial");
            this.updateStatus('error', 'Missing library');
            return false;
        }

        this.updateStatus('connecting');
        this.logger.info(`Connecting to Modbus TCP PLC at ${this.host}:${this.port} (Unit ID: ${this.unitId})...`);

        try {
            this.client = new ModbusRTU();
            await this.client.connectTCP(this.host, { port: this.port });
            this.client.setID(this.unitId);
            this.client.setTimeout(2000);

            this.logger.info(`✅ Connected to Modbus PLC.`);
            this.connected = true;
            this.updateStatus('connected');

            // Parse Mappings
            this.mappings = this.subscribeList.map(mappingStr => {
                const parts = mappingStr.split('::');
                if (parts.length !== 2) return null;
                const addrParts = parts[0].split(':');
                const address = parseInt(addrParts[0], 10);
                const length = parseInt(addrParts[1], 10) || 1;
                const topic = parts[1].trim();

                // Determine function code based on Modbus standard ranges
                let type = 'holding'; // default 4x
                if (address >= 10000 && address < 20000) type = 'input_status'; // 1x
                else if (address >= 30000 && address < 40000) type = 'input'; // 3x
                else if (address < 10000) type = 'coil'; // 0x
                
                return { address, length, topic, type };
            }).filter(Boolean);

            this.logger.info(`Parsed ${this.mappings.length} Modbus mappings.`);
            this.startPolling();

            return true;
        } catch (err) {
            this.logger.error({ err }, "❌ Failed to connect to Modbus PLC.");
            this.updateStatus('error', err.message);
            return false;
        }
    }

    startPolling() {
        if (this.mappings.length === 0) return;

        this.pollIntervalId = setInterval(async () => {
            if (!this.connected || !this.client) return;

            for (const map of this.mappings) {
                try {
                    let res;
                    const addr = map.address % 10000; // Strip prefix for modbus-serial
                    
                    if (map.type === 'holding') res = await this.client.readHoldingRegisters(addr, map.length);
                    else if (map.type === 'input') res = await this.client.readInputRegisters(addr, map.length);
                    else if (map.type === 'coil') res = await this.client.readCoils(addr, map.length);
                    else if (map.type === 'input_status') res = await this.client.readDiscreteInputs(addr, map.length);

                    if (res && res.data) {
                        // Forward to UNS
                        const payload = map.length === 1 ? res.data[0] : res.data;
                        this.handleIncomingMessage(map.topic, {
                            value: payload,
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (err) {
                    this.logger.warn(`Modbus read error on ${map.address}: ${err.message}`);
                }
            }
        }, this.pollingInterval);
    }

    async disconnect() {
        if (this.pollIntervalId) clearInterval(this.pollIntervalId);
        this.connected = false;
        try {
            if (this.client) {
                this.client.close();
                this.client = null;
            }
            this.updateStatus('disconnected');
            this.logger.info(`Modbus connection closed.`);
        } catch (err) {
            this.logger.error({ err }, "Error disconnecting Modbus client.");
        }
    }

    publish(topic, payload, options, callback) {
        // Find mapping
        const map = this.mappings.find(m => m.topic === topic);
        if (!map) return callback(new Error(`No Modbus mapping found for topic ${topic}`));

        let valueToWrite = payload;
        try {
            const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (obj && obj.value !== undefined) valueToWrite = obj.value;
        } catch(e) {}

        const addr = map.address % 10000;

        try {
            if (map.type === 'coil') {
                this.client.writeCoil(addr, !!valueToWrite).then(() => callback(null)).catch(callback);
            } else if (map.type === 'holding') {
                if (Array.isArray(valueToWrite)) {
                    this.client.writeRegisters(addr, valueToWrite).then(() => callback(null)).catch(callback);
                } else {
                    this.client.writeRegister(addr, parseInt(valueToWrite, 10)).then(() => callback(null)).catch(callback);
                }
            } else {
                callback(new Error(`Cannot write to read-only register type: ${map.type}`));
            }
        } catch (err) {
            callback(err);
        }
    }
}

module.exports = ModbusProvider;