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
 * Standardized Error Logging Utility
 */

/**
 * Standardizes an error object and logs it with the provided logger.
 * @param {Object} params
 * @param {Object} params.logger The pino logger instance.
 * @param {Error|Object|string} params.err The error object or message.
 * @param {string} params.code A unique error code for tracking.
 * @param {string} [params.traceId] A correlation or trace ID.
 * @param {string} [params.message] An additional descriptive message.
 * @param {Object} [params.context] Additional context to log.
 */
function logError({ logger, err, code, traceId, message, context = {} }) {
    // 1. Increment metric
    const metricsManager = require('./metricsManager');
    if (metricsManager && metricsManager.incrementError) {
        metricsManager.incrementError(code);
    }

    // 2. Prepare log object
    const errorLog = {
        code,
        traceId: traceId || (context && context.correlationId),
        message: message || (err && err.message) || (typeof err === 'string' ? err : 'Unknown error'),
        stack: err instanceof Error ? err.stack : undefined,
        ...context
    };

    // 3. Log with pino
    if (logger) {
        logger.error({ err: errorLog }, message || errorLog.message);
    } else {
        console.error(`[${code}] ${message || errorLog.message}`, errorLog);
    }
}

module.exports = {
    logError
};
