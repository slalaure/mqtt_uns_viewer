/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 */

import { connectWebSocket } from '../ws-client.js';

/**
 * Service for handling real-time messages with batching and throttling.
 * Prevents UI freezes during high-frequency data bursts.
 */
class RealtimeService {
    constructor() {
        /** @type {any[]} */
        this.queue = [];
        this.isFlushing = false;
        this.queueLimit = 5000;
        /** @type {Object|null} */
        this.callbacks = null;
        /** @type {boolean} */
        this.isInitialized = false;
        /** @type {any[]} */
        this.buffer = [];
    }

    /**
     * Initializes the service and connects the WebSocket.
     * @param {string} wsUrl WebSocket URL.
     * @param {Object} callbacks Callbacks for various message types and events.
     */
    init(wsUrl, callbacks) {
        this.callbacks = callbacks;

        connectWebSocket(wsUrl, {
            onOpen: () => {
                if (this.callbacks.onOpen) this.callbacks.onOpen();
                this.isInitialized = true;
                this.flushBuffer();
            },
            onMessage: (message) => {
                if (this.isInitialized) {
                    this.handleMessage(message);
                } else {
                    this.buffer.push(message);
                }
            },
            onError: (err) => {
                if (this.callbacks.onError) this.callbacks.onError(err);
            },
            onClose: (event) => {
                this.isInitialized = false;
                if (this.callbacks.onClose) this.callbacks.onClose(event);
            },
            onReconnect: () => {
                if (this.callbacks.onReconnect) this.callbacks.onReconnect();
            }
        });
    }

    flushBuffer() {
        while (this.buffer.length > 0) {
            this.handleMessage(this.buffer.shift());
        }
    }

    /**
     * @param {Object} message 
     */
    handleMessage(message) {
        if (message.type === 'mqtt-message') {
            this.enqueueRealtimeMessage(message);
        } else {
            if (this.callbacks.onOtherMessage) {
                this.callbacks.onOtherMessage(message);
            }
        }
    }

    /**
     * @param {Object} message 
     */
    enqueueRealtimeMessage(message) {
        if (this.queue.length > this.queueLimit) {
            // Drop half the queue if limit exceeded (sampling)
            this.queue.splice(0, this.queue.length - (this.queueLimit / 2));
            if (this.callbacks.onSamplingWarning) this.callbacks.onSamplingWarning();
        }

        this.queue.push(message);

        if (!this.isFlushing) {
            this.isFlushing = true;
            requestAnimationFrame(() => this.flushQueue());
        }
    }

    flushQueue() {
        if (this.queue.length === 0) {
            this.isFlushing = false;
            return;
        }

        const batch = this.queue;
        this.queue = [];

        // Deduplicate topics in this batch to only process the latest value for each
        const uniqueTopics = new Map();
        const historyEntries = [];

        // Reverse batch to make it Newest -> Oldest for history unshift-like behavior
        for (let i = batch.length - 1; i >= 0; i--) {
            const msg = batch[i];
            const topicKey = `${msg.brokerId}|${msg.topic}`;

            if (!uniqueTopics.has(topicKey)) {
                uniqueTopics.set(topicKey, msg);
                if (this.callbacks.onTopicUpdate) {
                    this.callbacks.onTopicUpdate(msg.brokerId, msg.topic, msg.payload);
                }
            }
            historyEntries.push(msg);
        }

        if (this.callbacks.onBatchProcessed) {
            this.callbacks.onBatchProcessed(historyEntries);
        }

        this.isFlushing = false;
        if (this.queue.length > 0) {
            this.isFlushing = true;
            requestAnimationFrame(() => this.flushQueue());
        }
    }
}

const realtimeService = new RealtimeService();
export default realtimeService;
