/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Utility functions (Regex parsing, formatting).
 * Verifies that pure helper functions from public/utils.js work correctly.
 */

// --- Extracted Frontend Logic (from public/utils.js) ---
function formatTimestampForLabel(timestamp) {
    const date = new Date(timestamp);
    const timePart = date.toLocaleTimeString('en-GB');
    const datePart = date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    return `${timePart} ${datePart}`;
}

function highlightText(text, term) {
    if (!term) return text;
    // Escape special regex characters in the search term
    const regex = new RegExp(term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
    return text.replace(regex, `<mark class="highlight">$&</mark>`);
}

function mqttPatternToClientRegex(pattern) {
    const regexString = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
        .replace(/\+/g, '[^/]+') // '+' matches one level segment
        .replace(/#/g, '.*'); // '#' matches zero or more levels at the end
    return new RegExp(`^${regexString}$`);
}

function mqttPatternToRegex(pattern) {
    // Escape characters with special meaning in regex, except for '+' and '#'
    const escapedPattern = pattern.replace(/[.^$*?()[\]{}|\\]/g, '\\$&');
    const regexString = escapedPattern
        .replace(/\+/g, '[^/]+')       
        .replace(/#/g, '.*');          
    return new RegExp(`^${regexString}$`);
}
// -------------------------------------------------------


describe('Frontend Utils: Date Formatting', () => {
    test('formatTimestampForLabel should format to en-GB short date', () => {
        // Use a fixed timestamp to avoid timezone flakiness in CI
        // "2025-10-28T14:30:05.000Z"
        const ts = Date.UTC(2025, 9, 28, 14, 30, 5); 
        // We use regex to match format because Node's local timezone will shift the exact hour
        const formatted = formatTimestampForLabel(ts);
        expect(formatted).toMatch(/\d{2}:\d{2}:\d{2}\s\d{2}\/\d{2}\/\d{2}/);
    });
});

describe('Frontend Utils: Text Highlighting', () => {
    test('highlightText should wrap matched terms in <mark> tags', () => {
        const text = "Error in pump sensor reading";
        const result = highlightText(text, "pump");
        expect(result).toBe('Error in <mark class="highlight">pump</mark> sensor reading');
    });

    test('highlightText should be case insensitive', () => {
        const text = "WARNING: System Failure";
        const result = highlightText(text, "warning");
        expect(result).toBe('<mark class="highlight">WARNING</mark>: System Failure');
    });

    test('highlightText should handle regex special characters gracefully', () => {
        const text = "Speed value is [150.5]*";
        const result = highlightText(text, "[150.5]*");
        expect(result).toBe('Speed value is <mark class="highlight">[150.5]*</mark>');
    });

    test('highlightText should return original text if term is empty', () => {
        const text = "Normal operation";
        expect(highlightText(text, "")).toBe(text);
        expect(highlightText(text, null)).toBe(text);
    });
});

describe('MQTT Pattern to Regex Conversion (Client & Server)', () => {
    test('should match exact topics', () => {
        const regex = mqttPatternToRegex("factory/line1/temp");
        const clientRegex = mqttPatternToClientRegex("factory/line1/temp");
        
        expect(regex.test("factory/line1/temp")).toBe(true);
        expect(regex.test("factory/line1/temperature")).toBe(false);
        expect(regex.test("factory/line1/temp/extra")).toBe(false);
        
        expect(clientRegex.test("factory/line1/temp")).toBe(true);
    });

    test('should handle single-level wildcard (+)', () => {
        const regex = mqttPatternToRegex("factory/+/temp");
        
        expect(regex.test("factory/line1/temp")).toBe(true);
        expect(regex.test("factory/line2/temp")).toBe(true);
        expect(regex.test("factory/line1/machineA/temp")).toBe(false); 
        expect(regex.test("factory/temp")).toBe(false); 
    });

    test('should handle multi-level wildcard (#)', () => {
        const regex = mqttPatternToRegex("factory/#");
        
        expect(regex.test("factory/line1/temp")).toBe(true);
        expect(regex.test("factory/line1/machineA/temp")).toBe(true);
        expect(regex.test("factory/")).toBe(true);
        expect(regex.test("other/factory/line1")).toBe(false);
    });

    test('should handle mixed wildcards', () => {
        const regex = mqttPatternToRegex("site/+/area/#");
        
        expect(regex.test("site/paris/area/line1/temp")).toBe(true);
        expect(regex.test("site/lyon/area/")).toBe(true);
        expect(regex.test("site/paris/other/line1")).toBe(false);
    });

    test('should escape regex special characters in topic names', () => {
        const regex = mqttPatternToRegex("$SYS/broker/clients");
        expect(regex.test("$SYS/broker/clients")).toBe(true);
        expect(regex.test("SYS/broker/clients")).toBe(false); 
    });
});