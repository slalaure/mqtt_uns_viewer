/**
 * @license MIT
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * Simulator Manager
 *
 * This module manages multiple, parallel simulation scenarios.
 * It loads scenario definitions and provides controls to start/stop them.
 */

// --- Import Scenario Definitions ---
const starkIndustriesScenario = require('./simulator-stark');
const deathStarScenario = require('./simulator-deathstar'); // [MODIFIED]
const parisMetroScenario = require('./simulator-paris-metro'); // [NEW] Import Paris Métro scenario

// --- Module-level State ---
let mainLogger = null;
let mainPublish = null;
let mainSparkplugEnabled = false;

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

    // --- Register all available scenarios ---
    registerScenario('stark_industries', starkIndustriesScenario);
    registerScenario('death_star', deathStarScenario); // [MODIFIED]
    registerScenario('paris_metro', parisMetroScenario); // [NEW] Register Paris Métro scenario
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