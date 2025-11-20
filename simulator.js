/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Simulator Manager
 *
 * This module manages multiple, parallel simulation scenarios.
 * It dynamically loads all scenarios from the /data directory.
 */

// ---  Node.js Core Imports ---
const fs = require('fs');
const path = require('path');

// --- [REMOVED] Built-in scenario imports ---
// const starkIndustriesScenario = require('./simulator-stark');
// const deathStarScenario = require('./simulator-deathstar');
// const parisMetroScenario = require('./simulator-paris-metro');

// --- Module-level State ---
let mainLogger = null;
let mainPublish = null;
let mainSparkplugEnabled = false;
const DATA_PATH = path.join(__dirname, 'data'); //  Define data path

// Map of all available scenario "factories"
const availableScenarios = new Map();

// Map of all *running* scenario instances
// Key: scenarioName, Value: { start: fn, stop: fn }
const activeSimulations = new Map();

/**
 * Initializes the Simulator Manager with required callbacks.
 * This MUST be called by server.js before any other function.
 * * @param {pino.Logger} logger - The main pino logger.
 * @param {function} publishCallback - The callback to publish MQTT data.
 * @param {boolean} isSparkplugEnabled - Global Sparkplug flag.
 */
function init(logger, publishCallback, isSparkplugEnabled) {
    mainLogger = logger.child({ component: 'SimulatorManager' });
    mainPublish = publishCallback;
    mainSparkplugEnabled = isSparkplugEnabled;

    mainLogger.info("Simulator Manager initialized.");

    // --- 1. [REMOVED] Register all DEFAULT (built-in) scenarios ---
    
    // --- 2.  Scan /data for ALL scenarios ---
    mainLogger.info(`Scanning ${DATA_PATH} for all simulators (simulator-*.js)...`);
    try {
        if (fs.existsSync(DATA_PATH)) {
            const files = fs.readdirSync(DATA_PATH);
            const simFiles = files.filter(f => f.startsWith('simulator-') && f.endsWith('.js'));

            if (simFiles.length > 0) {
                mainLogger.info(`Found ${simFiles.length} simulator file(s).`);
                simFiles.forEach(filename => {
                    // Extract name: "simulator-my-sim.js" -> "my_sim"
                    const scenarioName = filename.replace(/^simulator-/, '').replace(/\.js$/, '').replace(/-/g, '_');
                    
                    if (availableScenarios.has(scenarioName)) {
                        mainLogger.warn(`Simulator ${filename} is skipped: a scenario named '${scenarioName}' is already registered.`);
                        return;
                    }

                    try {
                        const customScenarioPath = path.join(DATA_PATH, filename);
                        const customScenarioModule = require(customScenarioPath);
                        
                        if (typeof customScenarioModule === 'function') {
                            registerScenario(scenarioName, customScenarioModule);
                        } else {
                            mainLogger.error(`Failed to load ${filename}: module.exports is not a function.`);
                        }
                    } catch (loadErr) {
                        mainLogger.error({ err: loadErr, file: filename }, `❌ Error loading simulator file.`);
                    }
                });
            } else {
                 mainLogger.info("No simulators found in /data. The 'Publish' tab simulator list will be empty.");
            }
        } else {
            mainLogger.warn("The /data directory does not exist. Skipping simulator scan.");
        }
    } catch (err) {
        mainLogger.error({ err }, "❌ Error scanning /data directory for simulators.");
    }
}

/**
 * Registers a scenario factory function.
 * @param {string} name - The unique name for the scenario (e.g., 'stark_industries').
 * @param {function} factory - The factory function (logger, publish, isSparkplugEnabled) => ({ start, stop }).
 */
function registerScenario(name, factory) {
    if (availableScenarios.has(name)) {
        mainLogger.warn(`Scenario [${name}] is already registered.`);
        return;
    }
    availableScenarios.set(name, factory);
    mainLogger.info(`✅ Scenario registered: [${name}]`);
}

/**
 * Starts a simulation scenario by its name.
 * @param {string} name - The name of the scenario to start.
 * @returns {object} { status: 'running' | 'already running' | 'not found' }
 */
function startSimulator(name) {
    if (activeSimulations.has(name)) {
        mainLogger.warn(`Simulator [${name}] is already running.`);
        return { status: 'already running' };
    }

    const factory = availableScenarios.get(name);
    if (!factory) {
        mainLogger.error(`Simulator [${name}] not found.`);
        return { status: 'not found' };
    }

    try {
        // Create a new logger instance for this specific simulation
        const scenarioLogger = mainLogger.child({ scenario: name });
        // Create the scenario instance by calling the factory
        const simulationInstance = factory(scenarioLogger, mainPublish, mainSparkplugEnabled);
        
        // Store the instance and start it
        activeSimulations.set(name, simulationInstance);
        simulationInstance.start();
        
        mainLogger.info(`🚀 Simulator [${name}] started.`);
        return { status: 'running' };

    } catch (err) {
        mainLogger.error({ err, scenario: name }, "❌ Failed to start simulation scenario.");
        return { status: 'error', message: err.message };
    }
}

/**
 * Stops a simulation scenario by its name.
 * @param {string} name - The name of the scenario to stop.
 * @returns {object} { status: 'stopped' | 'already stopped' | 'not found' }
 */
function stopSimulator(name) {
    const simulationInstance = activeSimulations.get(name);
    
    if (!simulationInstance) {
        // mainLogger.warn(`Simulator [${name}] is not running (or not found).`);
        return { status: 'already stopped' };
    }

    try {
        simulationInstance.stop();
        activeSimulations.delete(name);
        mainLogger.info(`🛑 Simulator [${name}] stopped.`);
        return { status: 'stopped' };
    } catch (err) {
        mainLogger.error({ err, scenario: name }, "❌ Failed to stop simulation scenario.");
        return { status: 'error', message: err.message };
    }
}

/**
 * Gets the status of all available simulators.
 * @returns {object} A map of scenario names to their status ('running' | 'stopped').
 */
function getStatuses() {
    const statuses = {};
    for (const name of availableScenarios.keys()) {
        statuses[name] = activeSimulations.has(name) ? 'running' : 'stopped';
    }
    return statuses;
}

module.exports = {
    init,
    startSimulator,
    stopSimulator,
    getStatuses
};