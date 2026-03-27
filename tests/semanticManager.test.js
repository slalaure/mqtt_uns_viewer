/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Semantic Manager.
 * Verifies topic resolution and legacy concept auto-migration.
 */

const fs = require('fs');
const semanticManager = require('../core/semantic/semanticManager');

// Mock the fs module to avoid reading real files during the test
jest.mock('fs');

describe('SemanticManager', () => {
    let mockContext;

    beforeEach(() => {
        // Reset mocks before each test
        jest.clearAllMocks();
        
        // Mock the application context (logger)
        mockContext = {
            logger: {
                child: jest.fn().mockReturnValue({
                    info: jest.fn(),
                    warn: jest.fn(),
                    error: jest.fn()
                })
            }
        };
    });

    test('should resolve I3X instances using topic_mapping', () => {
        const mockModel = {
            namespaces: [], 
            objectTypes: [], 
            relationshipTypes: [], 
            legacy_concepts: [],
            instances: [
                {
                    elementId: "pump_101",
                    typeId: "PumpType",
                    isComposition: false,
                    topic_mapping: "factory/line1/pump101/#"
                }
            ]
        };

        // Simulate reading the uns_model.json file
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(mockModel));

        // Initialize the manager
        semanticManager.init(mockContext);

        // Test resolving a topic that matches the wildcard pattern
        const result = semanticManager.resolveTopic("factory/line1/pump101/temperature");
        
        expect(result).not.toBeNull();
        expect(result.elementId).toBe("pump_101");
        expect(result.typeId).toBe("PumpType");
        expect(result.isComposition).toBe(false);
    });

    test('should auto-migrate and resolve legacy concepts with variables', () => {
        const mockModel = {
            namespaces: [], 
            objectTypes: [], 
            relationshipTypes: [], 
            instances: [],
            legacy_concepts: [
                {
                    concept: "Legacy Biogas Unit",
                    topic_template: "dt/iot/bgs/{plant_name}"
                }
            ]
        };

        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(mockModel));

        semanticManager.init(mockContext);

        // The {plant_name} variable should have been converted to a '+' wildcard
        const result = semanticManager.resolveTopic("dt/iot/bgs/PARIS_PLANT");
        
        expect(result).not.toBeNull();
        // The elementId is auto-generated based on the concept name
        expect(result.elementId).toBe("legacy_Legacy_Biogas_Unit");
        expect(result.typeId).toBe("LegacyConceptType");
    });

    test('should return null for unknown topics', () => {
        const mockModel = { instances: [], legacy_concepts: [] };
        
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(mockModel));
        
        semanticManager.init(mockContext);
        
        const result = semanticManager.resolveTopic("unknown/topic/here");
        expect(result).toBeNull();
    });
});