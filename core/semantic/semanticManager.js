/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 * * Semantic Manager (I3X Core)
 * Loads the I3X semantic model, builds the in-memory graph, and 
 * resolves raw MQTT topics to structured I3X Elements.
 * [UPDATED] Implemented Graph Relationship Indexer for custom I3X relationships (forward/reverse).
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
        this.topicMappings = []; 
        this.elementsMap = new Map();
        // [NEW] Graph storage: Map<elementId, Map<relationshipType, Set<targetId>>>
        this.relationshipsIndex = new Map();
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
                    this.saveModel(this.model);
                } else {
                    this.model = parsed;
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
     * Including the [NEW] Graph Relationship Index.
     */
    buildIndex() {
        this.elementsMap.clear();
        this.topicMappings = [];
        this.relationshipsIndex.clear();

        // 1. Index I3X Instances
        for (const instance of this.model.instances) {
            this.elementsMap.set(instance.elementId, instance);
            
            // Index standard parent/child hierarchy
            if (instance.parentId && instance.parentId !== '/') {
                this.addRelationship(instance.elementId, "HasParent", instance.parentId);
                this.addRelationship(instance.parentId, "HasChildren", instance.elementId);
            }

            // Index standard composition (if flag is set, though usually defined in relationships)
            if (instance.isComposition) {
                // Logic handled by explicit relationship definitions below
            }

            // [NEW] Index custom Graph Relationships
            if (instance.relationships) {
                for (const [relType, targets] of Object.entries(instance.relationships)) {
                    const targetList = Array.isArray(targets) ? targets : [targets];
                    targetList.forEach(targetId => {
                        this.addRelationship(instance.elementId, relType, targetId);
                        
                        // Automatically index the reverse relationship if defined in types
                        const relTypeDef = this.model.relationshipTypes.find(rt => rt.elementId === relType);
                        if (relTypeDef && relTypeDef.reverseOf) {
                            this.addRelationship(targetId, relTypeDef.reverseOf, instance.elementId);
                        }
                    });
                }
            }

            if (instance.topic_mapping) {
                this.topicMappings.push({
                    pattern: instance.topic_mapping,
                    elementId: instance.elementId,
                    typeId: instance.typeId,
                    isComposition: !!instance.isComposition
                });
            }
        }

        // 2. Index Legacy Concepts
        for (const concept of this.model.legacy_concepts) {
            if (concept.topic_template) {
                const virtualElementId = `legacy_${concept.concept.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
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
        this.logger.info(`Semantic Index built: ${this.elementsMap.size} instances, ${this.topicMappings.length} topic maps.`);
    }

    /**
     * Internal helper to register an edge in the graph.
     */
    addRelationship(sourceId, type, targetId) {
        if (!this.relationshipsIndex.has(sourceId)) {
            this.relationshipsIndex.set(sourceId, new Map());
        }
        const sourceRels = this.relationshipsIndex.get(sourceId);
        if (!sourceRels.has(type)) {
            sourceRels.set(type, new Set());
        }
        sourceRels.get(type).add(targetId);
    }

    /**
     * Returns a list of element IDs related to a source by a specific type.
     */
    getRelatedIds(elementId, relationshipType) {
        const sourceRels = this.relationshipsIndex.get(elementId);
        if (!sourceRels) return [];
        
        if (!relationshipType) {
            // Return everything
            const all = new Set();
            sourceRels.forEach(targets => targets.forEach(t => all.add(t)));
            return Array.from(all);
        }

        // Exact match or Case-insensitive match
        for (const [type, targets] of sourceRels.entries()) {
            if (type.toLowerCase() === relationshipType.toLowerCase()) {
                return Array.from(targets);
            }
        }
        return [];
    }

    /**
     * Resolves a raw MQTT topic to an I3X element ID.
     */
    resolveTopic(topic) {
        for (const mapping of this.topicMappings) {
            if (mqttMatch(mapping.pattern, topic)) {
                return {
                    elementId: mapping.elementId,
                    typeId: mapping.typeId,
                    isComposition: mapping.isComposition
                };
            }
        }
        return null;
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