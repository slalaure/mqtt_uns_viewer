/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Utility functions (Regex parsing).
 * Verifies that MQTT wildcards (+ and #) are correctly converted to JavaScript Regex.
 */

// We extract the exact core logic from public/utils.js to test it in Node.js
// without requiring Babel/ESM transpilation for the test runner.
function mqttPatternToRegex(pattern) {
    const escapedPattern = pattern.replace(/[.^$*?()[\]{}|\\]/g, '\\$&');
    const regexString = escapedPattern
        .replace(/\+/g, '[^/]+')
        .replace(/#/g, '.*');
    return new RegExp(`^${regexString}$`);
}

describe('MQTT Pattern to Regex Conversion', () => {
    test('should match exact topics', () => {
        const regex = mqttPatternToRegex("factory/line1/temp");
        
        expect(regex.test("factory/line1/temp")).toBe(true);
        expect(regex.test("factory/line1/temperature")).toBe(false);
        expect(regex.test("factory/line1/temp/extra")).toBe(false);
    });

    test('should handle single-level wildcard (+)', () => {
        const regex = mqttPatternToRegex("factory/+/temp");
        
        expect(regex.test("factory/line1/temp")).toBe(true);
        expect(regex.test("factory/line2/temp")).toBe(true);
        // Should NOT match multiple levels
        expect(regex.test("factory/line1/machineA/temp")).toBe(false); 
        // Should NOT match if the level is missing
        expect(regex.test("factory/temp")).toBe(false); 
    });

    test('should handle multi-level wildcard (#)', () => {
        const regex = mqttPatternToRegex("factory/#");
        
        expect(regex.test("factory/line1/temp")).toBe(true);
        expect(regex.test("factory/line1/machineA/temp")).toBe(true);
        expect(regex.test("factory/")).toBe(true);
        // Should NOT match if prefix is different
        expect(regex.test("other/factory/line1")).toBe(false);
    });

    test('should handle mixed wildcards', () => {
        const regex = mqttPatternToRegex("site/+/area/#");
        
        expect(regex.test("site/paris/area/line1/temp")).toBe(true);
        expect(regex.test("site/lyon/area/")).toBe(true);
        expect(regex.test("site/paris/other/line1")).toBe(false);
    });

    test('should escape regex special characters in topic names', () => {
        // Topics with $, ^ or brackets shouldn't break the regex
        const regex = mqttPatternToRegex("$SYS/broker/clients");
        
        expect(regex.test("$SYS/broker/clients")).toBe(true);
        expect(regex.test("SYS/broker/clients")).toBe(false); // The $ must be matched literally
    });
});