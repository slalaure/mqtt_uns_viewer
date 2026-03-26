/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Local File Provider Plugin (Skeleton)
 * Implements the BaseProvider interface to stream data from a local CSV or JSON file.
 */
const fs = require('fs');
const readline = require('readline');
const BaseProvider = require('../base-provider');

class FileProvider extends BaseProvider {
    constructor(config, context) {
        super(config, context);
        // Custom configuration specific to 'file' providers
        this.filePath = config.filePath || null;
        this.streamRateMs = config.streamRateMs || 1000;
        this.defaultTopic = config.defaultTopic || `file/${this.id}/data`;
        
        this.readStream = null;
        this.timer = null;
    }

    async connect() {
        return new Promise((resolve) => {
            if (!this.filePath || !fs.existsSync(this.filePath)) {
                this.updateStatus('error', 'File not found');
                this.logger.error(`File not found: ${this.filePath}`);
                return resolve(false);
            }

            this.logger.info(`Opening file stream from ${this.filePath}`);
            this.updateStatus('connected');
            this.connected = true;

            // Setup a read stream
            this.readStream = readline.createInterface({
                input: fs.createReadStream(this.filePath),
                crlfDelay: Infinity
            });

            const iterator = this.readStream[Symbol.asyncIterator]();

            const emitNextLine = async () => {
                if (!this.connected) return;
                
                const { value, done } = await iterator.next();
                if (done) {
                    this.logger.info(`End of file reached for ${this.id}.`);
                    this.disconnect();
                    return;
                }

                // Send the line content to the central Korelate engine
                // (In a real implementation, you might parse CSV into JSON here)
                this.handleIncomingMessage(this.defaultTopic, value);

                // Queue next line based on the configured rate
                this.timer = setTimeout(emitNextLine, this.streamRateMs);
            };

            // Start streaming
            emitNextLine();
            resolve(true);
        });
    }

    async disconnect() {
        this.connected = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.readStream) {
            this.readStream.close();
            this.readStream = null;
        }
        this.updateStatus('disconnected');
        this.logger.info(`File stream ${this.id} closed.`);
    }

    publish(topic, payload, options, callback) {
        // A file provider is typically read-only.
        // We could implement writing to a file here if needed.
        this.logger.warn(`Publish called on File Provider '${this.id}'. Action ignored (Read-Only).`);
        if (callback) callback(new Error("File Provider is Read-Only"));
    }
}

module.exports = FileProvider;