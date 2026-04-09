/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * SNMP Poller Provider Plugin
 * Implements the BaseProvider interface for polling SNMP devices.
 */
const BaseProvider = require('../baseProvider');

class SnmpProvider extends BaseProvider {
    /**
     * @param {import('../baseProvider').ProviderConfig} config 
     * @param {import('../baseProvider').ProviderContext} context 
     */
    constructor(config, context) {
        super(config, context);
        this.options = config.options || {};
        this.target = this.options.target || '127.0.0.1';
        this.community = this.options.community || 'public';
        this.oids = this.options.oids || []; // Array of string OIDs
        this.interval = this.options.interval || 60000;
        this.topic = this.options.topic || `snmp/${this.id}`;
        this.version = this.options.version || 'v2c';
        
        this.session = null;
        this.timer = null;
        this.isPolling = false;
        this.snmp = null;
    }

    async connect() {
        this.logger.info(`Connecting to SNMP target ${this.target} for ${this.id}`);
        try {
            this.snmp = require('net-snmp');
        } catch (err) {
            this.logger.error("Missing dependency 'net-snmp'. Please install it using: npm install net-snmp");
            this.updateStatus('error', 'Missing net-snmp library');
            return false;
        }

        try {
            const version = this.version === 'v1' ? this.snmp.Version1 : this.snmp.Version2c;
            this.session = this.snmp.createSession(this.target, this.community, { version });
            
            this.connected = true;
            this.updateStatus('connected');
            this.startPolling();
            return true;
        } catch (err) {
            this.logger.error({ err }, `Failed to connect to SNMP target ${this.target}`);
            this.updateStatus('error', err.message);
            return false;
        }
    }

    startPolling() {
        if (this.timer) clearInterval(this.timer);
        if (this.oids.length === 0) {
            this.logger.warn(`No OIDs configured for SNMP provider ${this.id}. Poller will not start.`);
            return;
        }
        this.timer = setInterval(() => this.poll(), this.interval);
        setImmediate(() => this.poll());
    }

    async poll() {
        if (this.isPolling || !this.connected || !this.session) return;
        this.isPolling = true;

        try {
            this.session.get(this.oids, (error, varbinds) => {
                if (error) {
                    this.logger.error({ err: error.message }, `SNMP Poll Error for ${this.id}`);
                } else {
                    const payload = {};
                    for (let i = 0; i < varbinds.length; i++) {
                        if (this.snmp.isVarbindError(varbinds[i])) {
                            this.logger.warn(this.snmp.varbindError(varbinds[i]));
                        } else {
                            const oid = varbinds[i].oid;
                            // Convert Buffer value to string if necessary
                            const value = Buffer.isBuffer(varbinds[i].value) ? varbinds[i].value.toString() : varbinds[i].value;
                            payload[oid] = value;
                        }
                    }
                    this.handleIncomingMessage(this.topic, payload);
                }
                this.isPolling = false;
            });
        } catch (err) {
            this.logger.error({ err: err.message }, `Exception during SNMP poll for ${this.id}`);
            this.isPolling = false;
        }
    }

    async disconnect() {
        if (this.timer) clearInterval(this.timer);
        this.connected = false;
        if (this.session) {
            this.session.close();
        }
        this.updateStatus('disconnected');
    }

    publish(topic, payload, options, callback) {
        const err = new Error("SNMP Provider does not support outbound publishing.");
        this.logger.warn(err.message);
        if (callback) callback(err);
    }
}

module.exports = SnmpProvider;
