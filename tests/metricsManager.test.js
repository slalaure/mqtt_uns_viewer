/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 * * Unit tests for Metrics Manager
 */

jest.mock('../core/websocketManager', () => ({
    getActiveConnectionsCount: jest.fn().mockReturnValue(3)
}));

jest.mock('../storage/dlqManager', () => ({
    getMessages: jest.fn().mockReturnValue([{}, {}, {}, {}, {}]) // 5 messages
}));

const metricsManager = require('../core/metricsManager');
const wsManager = require('../core/websocketManager');
const dlqManager = require('../storage/dlqManager');

describe('MetricsManager', () => {

    test('should increment messages processed counter', () => {
        metricsManager.incrementMessagesProcessed();
        metricsManager.incrementMessagesProcessed();
        
        const metrics = metricsManager.getPrometheusMetrics();
        expect(metrics).toContain('korelate_messages_processed_total 2');
    });

    test('should increment error counters by code', () => {
        metricsManager.incrementError('db_error');
        metricsManager.incrementError('db_error');
        metricsManager.incrementError('network_timeout');
        metricsManager.incrementError(); // unknown_error by default
        
        const metrics = metricsManager.getPrometheusMetrics();
        
        expect(metrics).toContain('korelate_errors_total{code="db_error"} 2');
        expect(metrics).toContain('korelate_errors_total{code="network_timeout"} 1');
        expect(metrics).toContain('korelate_errors_total{code="unknown_error"} 1');
    });

    test('should include active WS connections gauge', () => {
        const metrics = metricsManager.getPrometheusMetrics();
        expect(metrics).toContain('korelate_active_ws_connections 3');
    });

    test('should include DLQ size gauge', () => {
        const metrics = metricsManager.getPrometheusMetrics();
        expect(metrics).toContain('korelate_dlq_size 5');
    });

    test('should format output as Prometheus plaintext', () => {
        const metrics = metricsManager.getPrometheusMetrics();
        expect(metrics).toContain('# HELP korelate_messages_processed_total');
        expect(metrics).toContain('# TYPE korelate_messages_processed_total counter');
        expect(metrics).toContain('# HELP korelate_dlq_size');
        expect(metrics).toContain('# TYPE korelate_dlq_size gauge');
    });
});
