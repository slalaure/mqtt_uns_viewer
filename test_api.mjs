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
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY, EXPRESS OR
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
    // Si l'erreur vient d'axios (réponse HTTP), afficher les données
    if (err.response && err.response.data) {
        console.error(JSON.stringify(err.response.data, null, 2));
    } else {
        // Sinon, afficher le message d'erreur standard
        console.error(err.message);
        // Optionnel : afficher la stack trace si disponible
        if (err.stack) {
            console.error(colors.dim + err.stack + colors.reset);
        }
    }
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
    // [FIX] Uncommented wait time to allow simulator to generate data
    await new Promise(resolve => setTimeout(resolve, 5000));

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
      // [FIX] Target a topic that is generated quickly by the sensor loop
      TOPIC_TO_TEST = topicsRes.data.find(t => t.includes('humidity')); 
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
      logError('History is empty for topic (this may be ok if simulator just started).', null);
    }

    // [FIX] Changed test to search for 'humidity' which appears in the fast sensor loop
    logTest('Search Data (Full-Text /search?q=humidity)');
    const searchRes = await axios.get(`${CONTEXT_API_URL}/search?q=humidity`);
    if (Array.isArray(searchRes.data) && searchRes.data.length > 0) {
      logSuccess(`Full-text search for "humidity" returned ${searchRes.data.length} result(s).`);
      logData(searchRes.data);
    } else {
      logError('Full-text search for "humidity" returned no results. This is a failure.', null);
      throw new Error('Full-text search failed to find data.');
    }

    // --- [MODIFIED] Model-Driven Search Tests ---

    // [FIX] Changed test to search for a topic from the fast sensor loop
    logTest('Model Search (/search/model - Topic Only)');
    const modelSearchBody1 = {
      topic_template: "%/clean_room_01/humidity"
    };
    const modelSearchRes1 = await axios.post(`${CONTEXT_API_URL}/search/model`, modelSearchBody1);
    if (Array.isArray(modelSearchRes1.data) && modelSearchRes1.data.length > 0) {
      logSuccess(`Model search for topic "%/clean_room_01/humidity" returned ${modelSearchRes1.data.length} result(s).`);
      logData(modelSearchRes1.data);
    } else {
      logError('Model search (topic only) returned no results. This is a failure.', null);
      throw new Error('Model search (topic only) failed.');
    }

    // [MODIFIED] Changed test to search for topic and JSON from the fast sensor loop
    logTest('Model Search (/search/model - Topic + JSON Filter)');
    // [MODIFIED] Use the new 'filters' object signature
    const modelSearchBody2 = {
      topic_template: "%/clean_room_01/humidity",
      filters: {
        "unit": "%RH"
      }
    };
    const modelSearchRes2 = await axios.post(`${CONTEXT_API_URL}/search/model`, modelSearchBody2);

    let payloadObject = null;
    let testPassed = false; // Flag pour savoir si le test a réussi

    // Vérifier si des données ont été retournées AVANT de parser
    if (Array.isArray(modelSearchRes2.data) && modelSearchRes2.data.length > 0) {
        const payloadString = modelSearchRes2.data[0].payload;
        
        // --- [TRY CATCH AJOUTÉ ICI] ---
        try {
            // Tenter de parser le payload (qui devrait être un string JSON)
            if (payloadString && typeof payloadString === 'string') {
                payloadObject = JSON.parse(payloadString);
                
                // [FIX] Check for the correct key and value
                if (payloadObject && payloadObject.unit === "%RH") {
                    testPassed = true; // Le test réussit
                } else {
                    logError(`Model search check failed: Payload parsed but 'unit' is not '%RH' or missing. Payload: ${payloadString}`, null);
                }
            } else {
                logError(`Model search check failed: Payload received is not a string. Type: ${typeof payloadString}. Data:`, null);
                logData(modelSearchRes2.data);
            }
        } catch (e) {
            // Si le parsing échoue
            logError("Model search check failed: Failed to parse payload string received from API!", e);
            logInfo("Raw payload string received:");
            console.log(payloadString); // Afficher le string brut qui a échoué
            logData(modelSearchRes2.data); // Afficher toute la réponse
        }
        // --- [FIN DU TRY CATCH] ---
    } else {
        // Si aucune donnée n'est retournée par l'API
        logInfo('Model search (topic + filter) returned no results from API.');
    }

    // Afficher le résultat du test et lever une erreur s'il a échoué
    if (testPassed) {
        logSuccess(`Model search for "unit: %RH" returned ${modelSearchRes2.data.length} result(s) and check PASSED.`);
        logData(modelSearchRes2.data);
    } else {
        logError('!!! TEST FAILED: Model search (topic + filter) !!!', null);
        throw new Error('Model search (topic + filter) returned no results or an invalid result.'); // [FIX] Re-throw error
    }


    // --- 3. Expected Error Case Tests ---
    // (Le reste du fichier reste identique)

    logTest('Error 404 for unknown topic (/topic/...)');
    try {
      await axios.get(`${CONTEXT_API_URL}/topic/a/topic/that/does/not/exist`);
      logError('Expected 404 error, but request succeeded (test failed).', null);
    } catch (err) {
      if (err.response && err.response.status === 404) {
        logSuccess('Received 404 error as expected.');
      } else {
        logError('An unexpected error occurred during 404 test.', err);
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
        logError('An unexpected error occurred during 400 search test.', err);
      }
    }

    logTest('Error 400 for bad model search (missing topic_template)');
    try {
      // [MODIFIED] Test with the new 'filters' signature
      const badBody = { filters: { "priority": "HIGH" } };
      await axios.post(`${CONTEXT_API_URL}/search/model`, badBody);
      logError('Expected 400 error, but request succeeded (test failed).', null);
    } catch (err) {
      if (err.response && err.response.status === 400) {
        logSuccess('Received 400 error as expected.');
      } else {
        logError('An unexpected error occurred during 400 model search test.', err);
      }
    }


  } catch (error) {
    // Erreur critique attrapée plus haut dans le script (ex: connexion impossible)
    logError('!!! A CRITICAL ERROR OCCURRED OUTSIDE SPECIFIC TESTS !!!', error);
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