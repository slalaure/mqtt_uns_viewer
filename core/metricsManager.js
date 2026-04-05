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

/**
 * Metrics Manager
 * Tracks application performance and health metrics.
 */

const wsManager = require('./websocketManager');

// --- In-Memory Counters ---
let messagesProcessedTotal = 0;
const errorsTotal = new Map(); // Map<string, number>

/**
 * Increments the total messages processed counter.
 */
function incrementMessagesProcessed() {
    messagesProcessedTotal++;
}

/**
 * Increments the error counter for a specific error code.
 * @param {string} code The error code.
 */
function incrementError(code = 'unknown_error') {
    const current = errorsTotal.get(code) || 0;
    errorsTotal.set(code, current + 1);
}

/**
 * Generates Prometheus-formatted metrics.
 * @returns {string}
 */
function getPrometheusMetrics() {
    let metrics = '';

    // 1. Message Throughput
    metrics += '# HELP korelate_messages_processed_total Total number of messages processed by the dispatcher.\n';
    metrics += '# TYPE korelate_messages_processed_total counter\n';
    metrics += `korelate_messages_processed_total ${messagesProcessedTotal}\n\n`;

    // 2. Active WS Connections
    const wsConnections = wsManager.getActiveConnectionsCount();
    metrics += '# HELP korelate_active_ws_connections Current number of active WebSocket connections.\n';
    metrics += '# TYPE korelate_active_ws_connections gauge\n';
    metrics += `korelate_active_ws_connections ${wsConnections}\n\n`;

    // 3. DLQ Size
    const dlqManager = require('../storage/dlqManager');
    const dlqMessages = dlqManager.getMessages();
    const dlqSize = dlqMessages.length;
    metrics += '# HELP korelate_dlq_size Current number of messages in the Dead Letter Queue.\n';
    metrics += '# TYPE korelate_dlq_size gauge\n';
    metrics += `korelate_dlq_size ${dlqSize}\n\n`;

    // 4. Error Rates
    metrics += '# HELP korelate_errors_total Total number of errors encountered.\n';
    metrics += '# TYPE korelate_errors_total counter\n';
    if (errorsTotal.size === 0) {
        metrics += 'korelate_errors_total{code="none"} 0\n';
    } else {
        for (const [code, count] of errorsTotal.entries()) {
            metrics += `korelate_errors_total{code="${code}"} ${count}\n`;
        }
    }
    metrics += '\n';

    return metrics;
}

module.exports = {
    incrementMessagesProcessed,
    incrementError,
    getPrometheusMetrics
};
