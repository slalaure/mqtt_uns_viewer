/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025-2026 Sebastien Lalaurette
 * * Semantic Manager (I3X Core)
 * Loads the I3X semantic model, builds the in-memory graph, and 
 * resolves raw MQTT topics to structured I3X Elements.
 * Features persistent external_instances segregation in uns_model.json.
 * [UPDATED] Reverted getModel() to return RAW model to prevent corrupting local instances on Save.
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
            external_instances: [], 
            legacy_concepts: []
        };
        
        this.topicMappings = []; 
        this.elementsMap = new Map();
        this.relationshipsIndex = new Map();
        
        this.externalElements = new Map();
        this.externalTopicMappings = [];
        this.externalRelationshipsIndex = new Map();
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
                        { uri: "https://cesmii.org/i3x", displayName: "I3X Core" }
                    ];
                    this.model.objectTypes = [
                        {
                            elementId: "LegacyConceptType",
                            displayName: "Legacy Concept",
                            namespaceUri: "https://cesmii.org/i3x",
                            schema: { type: "object" }
                        }
                    ];
                    this.model.relationshipTypes = [];
                    this.model.instances = [];
                    this.model.external_instances = [];
                    this.saveModel(this.model);
                } else {
                    this.model = parsed;
                    this.model.namespaces = this.model.namespaces || [];
                    this.model.objectTypes = this.model.objectTypes || [];
                    this.model.relationshipTypes = this.model.relationshipTypes || [];
                    this.model.instances = this.model.instances || [];
                    this.model.external_instances = this.model.external_instances || [];
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

        const allInstances = [
            ...(this.model.instances || []),
            ...(this.model.external_instances || [])
        ];

        for (const instance of allInstances) {
            this.elementsMap.set(instance.elementId, instance);
            
            // Index standard parent/child hierarchy
            if (instance.parentId && instance.parentId !== '/') {
                this.addRelationship(instance.elementId, "HasParent", instance.parentId);
                this.addRelationship(instance.parentId, "HasChildren", instance.elementId);
            }

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
                    isComposition: !!instance.isComposition,
                    sourceId: instance._providerId 
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
        this.logger.info(`Semantic Index built: ${this.elementsMap.size} total instances, ${this.topicMappings.length} topic maps.`);
    }

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

    registerExternalElements(providerId, elements) {
        let hasChanges = false;
        this.model.external_instances = this.model.external_instances || [];
        
        const existingExtMap = new Map(this.model.external_instances.map(e => [e.elementId, e]));

        elements.forEach(el => {
            if (!el.elementId) return;

            const enrichedElement = {
                ...el,
                _isExternal: true,
                _providerId: providerId,
                topic_mapping: el.topic_mapping || el.elementId 
            };

            const existing = existingExtMap.get(el.elementId);
            
            if (!existing || JSON.stringify(existing) !== JSON.stringify(enrichedElement)) {
                existingExtMap.set(el.elementId, enrichedElement);
                hasChanges = true;
            }
        });

        if (hasChanges) {
            this.model.external_instances = Array.from(existingExtMap.values());
            this.saveModel(this.model);
            this.logger.info(`I3X Discovery: Saved updated external elements to uns_model.json for provider '${providerId}'.`);
        }
    }

    getRelatedIds(elementId, relationshipType) {
        const allTargets = new Set();
        const relsMap = this.relationshipsIndex.get(elementId);

        if (!relsMap) return [];

        if (!relationshipType) {
            relsMap.forEach(targets => targets.forEach(t => allTargets.add(t)));
        } else {
            for (const [type, targets] of relsMap.entries()) {
                if (type.toLowerCase() === relationshipType.toLowerCase()) {
                    targets.forEach(t => allTargets.add(t));
                }
            }
        }
        return Array.from(allTargets);
    }

    resolveTopic(topic) {
        for (const mapping of this.topicMappings) {
            if (mqttMatch(mapping.pattern, topic)) return mapping;
        }
        for (const mapping of this.externalTopicMappings) {
            if (mqttMatch(mapping.pattern, topic)) return mapping;
        }
        return null;
    }

    getTopicMapping(elementId) {
        let mapping = this.topicMappings.find(m => m.elementId === elementId);
        if (!mapping) {
            mapping = this.externalTopicMappings.find(m => m.elementId === elementId);
        }
        return mapping || null;
    }

    resolveElement(elementId) {
        return this.elementsMap.get(elementId) || this.externalElements.get(elementId) || null;
    }

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
     * Returns the RAW model object.
     * CRITICAL: Used by API saving endpoints (like /apply-learn) so we don't 
     * inadvertently serialize dynamic external_instances into the static instances array.
     */
    getModel() {
        return this.model;
    }

    /**
     * Helper to return all instances (local + external) combined.
     * Used exclusively by read-only Data APIs (like i3xRouter).
     */
    getAllInstances() {
        return [
            ...(this.model.instances || []),
            ...(this.model.external_instances || [])
        ];
    }
}

module.exports = new SemanticManager();