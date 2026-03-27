/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Semantic Manager (I3X Core)
 * Loads the I3X semantic model, builds the in-memory graph, and 
 * resolves raw MQTT topics to structured I3X Elements.
 */
const fs = require('fs');
const path = require('path');
const mqttMatch = require('mqtt-match');

class SemanticManager {
    constructor() {
        this.modelPath = '';
        this.logger = null;
        this.model = {
            namespaces: [],
            objectTypes: [],
            relationshipTypes: [],
            instances: [],
            legacy_concepts: []
        };
        this.topicMappings = []; // Cache of { pattern: string, elementId: string, typeId: string }
        this.elementsMap = new Map();
    }

    /**
     * Initializes the Semantic Manager.
     * @param {Object} context Application context
     */
    init(context) {
        this.logger = context.logger.child({ component: 'SemanticManager' });
        this.modelPath = path.join(__dirname, '..', '..', 'data', 'uns_model.json');
        this.loadModel();
        this.logger.info("✅ Semantic Manager initialized.");
    }

    /**
     * Loads and parses the uns_model.json file.
     * Handles auto-migration from legacy flat-array models to I3X structure.
     */
    loadModel() {
        try {
            if (fs.existsSync(this.modelPath)) {
                const rawData = fs.readFileSync(this.modelPath, 'utf8');
                const parsed = JSON.parse(rawData);

                // Auto-migrate if it's the old flat array format
                if (Array.isArray(parsed)) {
                    this.logger.warn("⚠️ Legacy UNS model detected. Auto-migrating to I3X structure...");
                    this.model.legacy_concepts = parsed;
                    this.model.namespaces = [
                        { uri: "https://cesmii.org/i3x", displayName: "I3X Core" },
                        { uri: "https://korelate.io/models/custom", displayName: "Custom Models" }
                    ];
                    this.model.objectTypes = [
                        {
                            elementId: "LegacyConceptType",
                            displayName: "Legacy Concept",
                            namespaceUri: "https://korelate.io/models/custom",
                            schema: { type: "object", description: "Auto-generated type for legacy concepts" }
                        }
                    ];
                    this.model.relationshipTypes = [
                        { elementId: "HasParent", displayName: "HasParent", namespaceUri: "https://cesmii.org/i3x", reverseOf: "HasChildren" },
                        { elementId: "HasChildren", displayName: "HasChildren", namespaceUri: "https://cesmii.org/i3x", reverseOf: "HasParent" },
                        { elementId: "HasComponent", displayName: "HasComponent", namespaceUri: "https://cesmii.org/i3x", reverseOf: "ComponentOf" },
                        { elementId: "ComponentOf", displayName: "ComponentOf", namespaceUri: "https://cesmii.org/i3x", reverseOf: "HasComponent" }
                    ];
                    this.model.instances = [];
                    // Save migrated format immediately
                    this.saveModel(this.model);
                } else {
                    this.model = parsed;
                    // Ensure required arrays exist
                    this.model.namespaces = this.model.namespaces || [];
                    this.model.objectTypes = this.model.objectTypes || [];
                    this.model.relationshipTypes = this.model.relationshipTypes || [];
                    this.model.instances = this.model.instances || [];
                    this.model.legacy_concepts = this.model.legacy_concepts || [];
                }
                
                this.buildIndex();
            } else {
                this.logger.warn("No uns_model.json found. Running with empty semantic model.");
            }
        } catch (err) {
            this.logger.error({ err }, "❌ Failed to load uns_model.json");
        }
    }

    /**
     * Builds fast-lookup maps from the model definition.
     */
    buildIndex() {
        this.elementsMap.clear();
        this.topicMappings = [];

        // 1. Index I3X Instances
        for (const instance of this.model.instances) {
            this.elementsMap.set(instance.elementId, instance);

            // If the instance has a direct topic mapping defined in its structure
            if (instance.topic_mapping) {
                this.topicMappings.push({
                    pattern: instance.topic_mapping,
                    elementId: instance.elementId,
                    typeId: instance.typeId,
                    isComposition: !!instance.isComposition
                });
            }
        }

        // 2. Index Legacy Concepts (Temporary Adapter)
        // Maps old concepts into virtual I3X elements to keep AI tools functioning seamlessly
        for (const concept of this.model.legacy_concepts) {
            if (concept.topic_template) {
                // Create a virtual element mapping for the old concept
                // Clean the name to create a safe elementId
                const virtualElementId = `legacy_${concept.concept.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                
                // Replace curly braces {var} with MQTT single-level wildcard '+' for matching
                const safePattern = concept.topic_template.replace(/\{[^}]+\}/g, '+');

                this.topicMappings.push({
                    pattern: safePattern,
                    elementId: virtualElementId,
                    typeId: "LegacyConceptType",
                    isComposition: false,
                    _isLegacy: true,
                    conceptDef: concept
                });
            }
        }

        this.logger.info(`Semantic Index built: ${this.elementsMap.size} pure I3X instances, ${this.topicMappings.length} active topic mappings.`);
    }

    /**
     * Resolves a raw MQTT topic to an I3X element ID.
     * @param {string} topic The MQTT topic received
     * @returns {Object|null} Object containing { elementId, typeId, isComposition } or null if unmapped.
     */
    resolveTopic(topic) {
        // Find the first mapping that matches the incoming topic
        for (const mapping of this.topicMappings) {
            if (mqttMatch(mapping.pattern, topic)) {
                return {
                    elementId: mapping.elementId,
                    typeId: mapping.typeId,
                    isComposition: mapping.isComposition
                };
            }
        }
        return null; // No semantic mapping found for this topic
    }

    /**
     * Retrieves the full instance definition by its ID.
     */
    resolveElement(elementId) {
        return this.elementsMap.get(elementId) || null;
    }

    /**
     * Persists the semantic model to disk.
     */
    saveModel(newModel) {
        try {
            this.model = newModel;
            fs.writeFileSync(this.modelPath, JSON.stringify(this.model, null, 2), 'utf8');
            this.buildIndex();
            this.logger.info("✅ Semantic Model saved and re-indexed.");
            return { success: true };
        } catch (err) {
            this.logger.error({ err }, "❌ Failed to save Semantic Model.");
            return { error: err.message };
        }
    }

    /**
     * Returns the complete model object.
     */
    getModel() {
        return this.model;
    }
}

module.exports = new SemanticManager();