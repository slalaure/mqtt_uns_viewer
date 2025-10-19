/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import axios from 'axios';

// --- Configuration ---
const CONTEXT_API_URL = 'http://localhost:8080/api/context';
const SIMULATOR_API_URL = 'http://localhost:8080/api/simulator';
let TOPIC_TO_TEST = ''; // Will be filled by the "get_topics_list" test

// --- Helpers for clear logging ---
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

const logSuccess = (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`);
const logError = (msg, err) => {
  console.error(`${colors.red}❌ ${msg}${colors.reset}`);
  if (err) {
    const errorData = err.response ? err.response.data : { message: err.message };
    console.error(JSON.stringify(errorData, null, 2));
  }
};
const logInfo = (msg) => console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`);
const logTest = (title) => console.log(`\n${colors.cyan}--- Test: ${title} ---${colors.reset}`);
const logData = (data) => console.log(`${colors.dim}${JSON.stringify(data, null, 2).substring(0, 500)}...${colors.reset}`);

/**
 * Main test function
 */
async function main() {
  logInfo('Starting the API test suite for MQTT UNS Viewer...');

  try {
    // --- 1. Simulator Control (to generate data) ---
    logTest('Start Simulator');
    await axios.post(`${SIMULATOR_API_URL}/start`);
    logSuccess('Simulator started. Waiting 5 seconds for data collection...');
    await new Promise(resolve => setTimeout(resolve, 5000)); // Allow time for data to arrive

    // --- 2. Data Endpoint Tests ---

    logTest('Get Application Status (/status)');
    const statusRes = await axios.get(`${CONTEXT_API_URL}/status`);
    if (statusRes.data && statusRes.data.mqtt_connected) {
      logSuccess('Application status retrieved.');
      logData(statusRes.data);
    } else {
      throw new Error('Invalid status or MQTT not connected.');
    }

    logTest('Get Topics List (/topics)');
    const topicsRes = await axios.get(`${CONTEXT_API_URL}/topics`);
    if (Array.isArray(topicsRes.data) && topicsRes.data.length > 0) {
      logSuccess(`List of ${topicsRes.data.length} topics retrieved.`);
      TOPIC_TO_TEST = topicsRes.data.find(t => t.includes('maintenance')); // Target a known topic
      if (!TOPIC_TO_TEST) TOPIC_TO_TEST = topicsRes.data[0]; // Fallback
      logInfo(`Topic selected for tests: ${TOPIC_TO_TEST}`);
    } else {
      throw new Error('No topics found. Did the simulator run correctly?');
    }

    logTest('Get Topics Tree (/tree)');
    const treeRes = await axios.get(`${CONTEXT_API_URL}/tree`);
    if (treeRes.data && Object.keys(treeRes.data).length > 0) {
      logSuccess('Topic tree retrieved.');
      logData(treeRes.data);
    } else {
      throw new Error('Tree is empty.');
    }

    logTest('Get Latest Message (/topic/:topic)');
    const latestRes = await axios.get(`${CONTEXT_API_URL}/topic/${encodeURIComponent(TOPIC_TO_TEST)}`);
    if (latestRes.data && latestRes.data.topic === TOPIC_TO_TEST) {
      logSuccess(`Latest message for '${TOPIC_TO_TEST}' retrieved.`);
      logData(latestRes.data);
    } else {
      throw new Error('Invalid message for topic.');
    }

    logTest('Get Topic History (/history/:topic)');
    const historyRes = await axios.get(`${CONTEXT_API_URL}/history/${encodeURIComponent(TOPIC_TO_TEST)}?limit=3`);
    if (Array.isArray(historyRes.data) && historyRes.data.length > 0) {
      logSuccess(`History (limit 3) for '${TOPIC_TO_TEST}' retrieved.`);
      logData(historyRes.data);
    } else {
      throw new Error('History is empty for topic.');
    }

    logTest('Search Data (/search?q=maintenance)');
    const searchRes = await axios.get(`${CONTEXT_API_URL}/search?q=maintenance`);
    if (Array.isArray(searchRes.data) && searchRes.data.length > 0) {
      logSuccess(`Search for "maintenance" returned ${searchRes.data.length} result(s).`);
      logData(searchRes.data);
    } else {
      throw new Error('Search for "maintenance" returned no results.');
    }

    // --- 3. Expected Error Case Tests ---

    logTest('Error 404 for unknown topic (/topic/...)');
    try {
      await axios.get(`${CONTEXT_API_URL}/topic/a/topic/that/does/not/exist`);
      logError('Expected 404 error, but request succeeded (test failed).', null);
    } catch (err) {
      if (err.response && err.response.status === 404) {
        logSuccess('Received 404 error as expected.');
      } else {
        logError('An unexpected error occurred.', err);
      }
    }

    logTest('Error 400 for short search (/search?q=a)');
    try {
      await axios.get(`${CONTEXT_API_URL}/search?q=a`);
      logError('Expected 400 error, but request succeeded (test failed).', null);
    } catch (err) {
      if (err.response && err.response.status === 400) {
        logSuccess('Received 400 error as expected.');
      } else {
        logError('An unexpected error occurred.', err);
      }
    }


  } catch (error) {
    logError('!!! A CRITICAL TEST FAILED !!!', error);
  } finally {
    // --- 4. Stop Simulator ---
    logTest('Stop Simulator');
    try {
      await axios.post(`${SIMULATOR_API_URL}/stop`);
      logSuccess('Simulator stopped.');
    } catch (e) {
      logError('Error stopping simulator.', e);
    }
  }
}

main();