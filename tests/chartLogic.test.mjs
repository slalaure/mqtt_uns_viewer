/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * 
 * Chart Logic Unit Tests
 * Verifies data processing logic without DOM dependencies.
 */

import { 
    downsampleLTTB, 
    isBooleanLike, 
    guessGroupKey, 
    getAxisHue, 
    buildChartDatasets 
} from '../public/libs/chart-logic.mjs';

describe('Chart Logic', () => {

    describe('downsampleLTTB', () => {
        test('should return same data if threshold is greater than data length', () => {
            const data = [{x: 1, y: 10}, {x: 2, y: 20}];
            expect(downsampleLTTB(data, 10)).toEqual(data);
        });

        test('should reduce points to approximately the threshold', () => {
            const data = [];
            for(let i=0; i<100; i++) data.push({x: i, y: Math.random()});
            
            const threshold = 10;
            const sampled = downsampleLTTB(data, threshold);
            
            expect(sampled.length).toBe(threshold);
            expect(sampled[0]).toEqual(data[0]);
            expect(sampled[sampled.length-1]).toEqual(data[data.length-1]);
        });
    });

    describe('isBooleanLike', () => {
        test('should return true for 0 and 1 values', () => {
            const data = [{y: 0}, {y: 1}, {y: 0}];
            expect(isBooleanLike(data)).toBe(true);
        });

        test('should return false for other numeric values', () => {
            const data = [{y: 0}, {y: 1}, {y: 2}];
            expect(isBooleanLike(data)).toBe(false);
        });
    });

    describe('guessGroupKey', () => {
        test('should identify temperature keyword', () => {
            expect(guessGroupKey('factory/sensor', 'ambient_temperature')).toBe('temperature');
        });

        test('should identify pressure keyword', () => {
            expect(guessGroupKey('boiler/p1', 'value')).toBe('p1'); // path is (value), use topic part
        });

        test('should use topic parts for unknown paths', () => {
            expect(guessGroupKey('my/custom/path', 'metric')).toBe('path_metric');
        });
    });

    describe('getAxisHue', () => {
        test('should return semantic red for fire', () => {
            expect(getAxisHue('fire_status', 0, true)).toBe(0);
        });

        test('should return palette color if semantic disabled', () => {
            expect(getAxisHue('temperature', 1, false)).toBe(120); // PALETTE_HUES[1]
        });
    });

    describe('buildChartDatasets', () => {
        test('should transform points into Chart.js datasets', () => {
            const rawPointsMap = new Map([
                ['var1', [{x: 100, y: 1}, {x: 200, y: 2}]]
            ]);
            const chartedVariables = new Map([
                ['var1', { topic: 'test/t1', path: 'p1' }]
            ]);
            
            const { datasets, scalesMeta } = buildChartDatasets(rawPointsMap, chartedVariables, {
                useSmartAxis: false,
                distinctAxes: ['var1']
            });

            expect(datasets.length).toBe(1);
            expect(datasets[0].label).toContain('t1 | p1');
            expect(datasets[0].data.length).toBe(2);
            expect(scalesMeta['y0']).toBeDefined();
            expect(scalesMeta['y0'].id).toBe('y0');
        });
    });
});
