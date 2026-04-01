/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the Chart Logic algorithms.
 * Verifies payload parsing, numeric key extraction, and axis grouping.
 */

// --- Extracted Frontend Logic (from public/view.chart.js) ---
function getNestedValue(obj, path) {
    if (typeof path !== 'string' || !obj) return undefined;
    const parts = path.split(/\.|\[|\]/).filter(Boolean); 
    let current = obj;
    for (const part of parts) {
        if (current === undefined || current === null) return undefined;
        if (Array.isArray(current)) {
            const metric = current.find(m => m.name === part);
            current = metric ? metric.value : undefined;
        } else {
            current = current[part];
        }
    }
    return current;
}

function findNumericKeys(obj, path = '', list = []) {
    if (obj === null || typeof obj !== 'object') return list;
    if (Array.isArray(obj)) {
        if (obj.length > 0 && obj.every(item => typeof item === 'object' && item.hasOwnProperty('name') && item.hasOwnProperty('value'))) {
            obj.forEach(metric => {
                const newPath = path ? `${path}[${metric.name}]` : `[${metric.name}]`; 
                const value = metric.value;
                if (typeof value === 'number') {
                    list.push({ path: newPath, type: Number.isInteger(value) ? 'int' : 'float' });
                } else if (typeof value === 'string' && value.trim() !== '') {
                    if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
                        list.push({ path: newPath, type: value.includes('.') ? 'float (string)' : 'int (string)' });
                    }
                }
            });
        }
        return list;
    }
    for (const key of Object.keys(obj)) {
        const newPath = path ? `${path}.${key}` : key;
        const value = obj[key];
        if (typeof value === 'number') {
            list.push({ path: newPath, type: Number.isInteger(value) ? 'int' : 'float' });
        } else if (typeof value === 'string' && value.trim() !== '') {
            if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
                list.push({ path: newPath, type: value.includes('.') ? 'float (string)' : 'int (string)' });
            }
        } else if (typeof value === 'object') { 
            findNumericKeys(value, newPath, list);
        }
    }
    return list;
}

function isBooleanLike(dataPoints) {
    if (!dataPoints || dataPoints.length === 0) return false;
    for (const p of dataPoints) {
        if (p.y !== 0 && p.y !== 1) return false;
    }
    return true;
}

function guessGroupKey(topic, path) {
    const fullString = (topic + '/' + path).toLowerCase();
    const keywords = [
        'temperature', 'humidity', 'pressure', 'bar', 'psi', 'pascal',
        'power', 'current', 'voltage', 'energy', 
        'speed', 'vibration', 'level', 'percent', 'battery', 'soc', 
        'heater', 'status', 'fire', 
        'load', 'flow', 'rate', 'debit', 'throughput',
        'concentration', 'ppm', 'ppb', 'mg', 'µg', 'aqi', 'co2', 'pm25'
    ];
    for (const kw of keywords) {
        if (fullString.includes(kw)) return kw;
    }
    const topicParts = topic.split('/');
    const lastPart = topicParts[topicParts.length - 1];
    if (path === '(value)' || path.toLowerCase() === 'value') {
        return lastPart.toLowerCase();
    }
    return (lastPart + '_' + path).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}
// -------------------------------------------------------

describe('Chart Logic: getNestedValue', () => {
    test('should extract simple nested object properties', () => {
        const payload = { sensor: { temp: 24.5, active: true } };
        expect(getNestedValue(payload, 'sensor.temp')).toBe(24.5);
        expect(getNestedValue(payload, 'sensor.active')).toBe(true);
    });

    test('should extract Sparkplug B formatted arrays', () => {
        const payload = {
            metrics: [
                { name: 'Speed', value: 1500 },
                { name: 'Pressure', value: 1.2 }
            ]
        };
        // The algorithm translates brackets into matching the 'name' key in Sparkplug arrays
        expect(getNestedValue(payload, 'metrics[Speed]')).toBe(1500);
        expect(getNestedValue(payload, 'metrics[Pressure]')).toBe(1.2);
        expect(getNestedValue(payload, 'metrics[Unknown]')).toBeUndefined();
    });

    test('should gracefully return undefined for missing or invalid paths', () => {
        const payload = { data: 123 };
        expect(getNestedValue(payload, 'data.missing')).toBeUndefined();
        expect(getNestedValue(payload, 'wrong.path')).toBeUndefined();
        expect(getNestedValue(null, 'data')).toBeUndefined();
    });
});

describe('Chart Logic: findNumericKeys', () => {
    test('should find integers and floats in standard objects', () => {
        const payload = {
            motor: { speed: 1000, temp: 45.2 },
            status: "Running" // String, should be ignored
        };
        const keys = findNumericKeys(payload);
        
        expect(keys).toHaveLength(2);
        expect(keys).toEqual(expect.arrayContaining([
            { path: 'motor.speed', type: 'int' },
            { path: 'motor.temp', type: 'float' }
        ]));
    });

    test('should detect numeric strings', () => {
        const payload = {
            flow_rate: "15.5",
            error_code: "404",
            ignored_string: "hello"
        };
        const keys = findNumericKeys(payload);
        
        expect(keys).toHaveLength(2);
        expect(keys).toEqual(expect.arrayContaining([
            { path: 'flow_rate', type: 'float (string)' },
            { path: 'error_code', type: 'int (string)' }
        ]));
    });

    test('should parse Sparkplug B array structures', () => {
        const payload = {
            metrics: [
                { name: 'Voltage', value: 220 },
                { name: 'Current', value: 12.5 },
                { name: 'Message', value: 'Overload' } // Should ignore non-numeric value
            ]
        };
        const keys = findNumericKeys(payload.metrics, 'metrics');
        
        expect(keys).toHaveLength(2);
        expect(keys).toEqual(expect.arrayContaining([
            { path: 'metrics[Voltage]', type: 'int' },
            { path: 'metrics[Current]', type: 'float' }
        ]));
    });
});

describe('Chart Logic: isBooleanLike', () => {
    test('should return true if array only contains 0s and 1s', () => {
        const data = [{ x: 100, y: 0 }, { x: 101, y: 1 }, { x: 102, y: 0 }];
        expect(isBooleanLike(data)).toBe(true);
    });

    test('should return false if array contains other numbers', () => {
        const data = [{ x: 100, y: 0 }, { x: 101, y: 0.5 }, { x: 102, y: 1 }];
        expect(isBooleanLike(data)).toBe(false);
    });

    test('should return false for empty or null arrays', () => {
        expect(isBooleanLike([])).toBe(false);
        expect(isBooleanLike(null)).toBe(false);
    });
});

describe('Chart Logic: guessGroupKey', () => {
    test('should identify known semantic keywords for smart axes grouping', () => {
        expect(guessGroupKey('factory/furnace/temp', 'data.temp1')).toBe('temperature');
        expect(guessGroupKey('factory/pump', 'pressure_bar')).toBe('pressure');
        expect(guessGroupKey('building/bms/kwh', '(value)')).toBe('power');
    });

    test('should fallback to last topic part and path if no keyword matches', () => {
        // No recognizable keyword inside "factory/robot" or "axis_x"
        expect(guessGroupKey('factory/robot', 'axis_x')).toBe('robot_axis_x');
    });

    test('should handle the primitive (value) path gracefully', () => {
        expect(guessGroupKey('factory/custom_metric', '(value)')).toBe('custom_metric');
        expect(guessGroupKey('factory/custom_metric', 'value')).toBe('custom_metric');
    });
});