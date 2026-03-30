/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Local File Provider Plugin
 * Implements the BaseProvider interface to stream data from a local CSV or JSONL file.
 * Features automatic CSV parsing, numeric conversion, and dynamic topic routing.
 * Supports publishing (loopback) to act as a unified data stream bus.
 */
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const BaseProvider = require('../baseProvider');

class FileProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        // Custom configuration specific to 'file' providers
        this.filePath = config.filePath ? path.resolve(process.cwd(), config.filePath) : null;
        this.streamRateMs = config.streamRateMs || 1000;
        this.defaultTopic = config.defaultTopic || `file/${this.id}/data`;
        this.loop = config.loop !== false; // Loop by default
        this.isCsv = this.filePath ? this.filePath.toLowerCase().endsWith('.csv') : false;
        this.readStream = null;
        this.rl = null;
        this.timer = null;
        this.headers = [];
    }

    async connect() {
        return new Promise((resolve) => {
            if (!this.filePath || !fs.existsSync(this.filePath)) {
                this.updateStatus('error', 'File not found');
                this.logger.error(`File not found: ${this.filePath}`);
                return resolve(false);
            }

            this.logger.info(`Opening file stream from ${this.filePath} (Rate: ${this.streamRateMs}ms, Loop: ${this.loop})`);
            this.updateStatus('connected');
            this.connected = true;

            // Setup and start reading stream
            this.startReading();

            resolve(true);
        });
    }

    startReading() {
        if (!this.connected) return;

        this.readStream = fs.createReadStream(this.filePath, { encoding: 'utf8' });
        this.rl = readline.createInterface({
            input: this.readStream,
            crlfDelay: Infinity
        });

        let isFirstLine = true;
        const iterator = this.rl[Symbol.asyncIterator]();

        const processNextLine = async () => {
            if (!this.connected) return;

            const { value, done } = await iterator.next();

            if (done) {
                this.logger.info(`End of file reached for ${this.id}.`);
                if (this.loop) {
                    this.logger.info(`Looping enabled. Restarting file stream for ${this.id}...`);
                    this.rl.close();
                    this.readStream.destroy();
                    // Wait one stream interval before restarting
                    this.timer = setTimeout(() => this.startReading(), this.streamRateMs);
                } else {
                    this.disconnect();
                }
                return;
            }

            const line = value.trim();

            if (line) {
                // Handle CSV Headers
                if (this.isCsv && isFirstLine) {
                    this.headers = this.parseCsvLine(line);
                    isFirstLine = false;
                    // Move to the next line immediately (headers don't emit payloads)
                    setImmediate(processNextLine);
                    return;
                }

                isFirstLine = false;
                let payloadObj = null;
                let dynamicTopic = this.defaultTopic;

                if (this.isCsv) {
                    const values = this.parseCsvLine(line);
                    payloadObj = {};
                    
                    for (let i = 0; i < this.headers.length; i++) {
                        let val = values[i] !== undefined ? values[i] : "";
                        const headerName = this.headers[i];

                        // Feature: If the column is named 'topic', use it for routing instead of adding it to payload
                        if (headerName.toLowerCase() === 'topic') {
                            dynamicTopic = val.replace(/^"|"$/g, '');
                            continue;
                        }

                        // Attempt to parse as number if applicable
                        if (!isNaN(val) && val.trim() !== "") {
                            val = Number(val);
                        }
                        
                        payloadObj[headerName] = val;
                    }
                } else {
                    // Attempt JSON parse for JSONL, fallback to raw string
                    try {
                        payloadObj = JSON.parse(line);
                    } catch(e) {
                        payloadObj = { raw: line };
                    }
                }

                // Send the parsed object to the central Korelate engine
                this.handleIncomingMessage(dynamicTopic, payloadObj);
            } else {
                // Ignore empty lines without adding a time penalty
                setImmediate(processNextLine);
                return;
            }

            // Queue next line based on the configured rate
            this.timer = setTimeout(processNextLine, this.streamRateMs);
        };

        // Boot up the recursive reader
        processNextLine();
    }

    parseCsvLine(text) {
        // Robust CSV split that respects commas inside double quotes
        const re = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;
        return text.split(re).map(val => val.replace(/^"|"$/g, '').trim());
    }

    async disconnect() {
        this.connected = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.rl) this.rl.close();
        if (this.readStream) this.readStream.destroy();
        
        this.updateStatus('disconnected');
        this.logger.info(`File stream ${this.id} closed.`);
    }

    publish(topic, payload, options, callback) {
        // Loopback the message into the central engine to act as a local message bus
        this.logger.info(`File Provider '${this.id}' routing publish back to stream: '${topic}'`);
        
        let parsedPayload = payload;
        
        // Attempt to parse string payloads to JSON for consistency in the engine
        if (typeof payload === 'string') {
            try {
                parsedPayload = JSON.parse(payload);
            } catch(e) {
                parsedPayload = { raw: payload };
            }
        }
        
        // Loopback the message to the central engine
        this.handleIncomingMessage(topic, parsedPayload);
        
        if (callback) callback(null);
    }
}

module.exports = FileProvider;