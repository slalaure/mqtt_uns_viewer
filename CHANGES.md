# Korelate Changelog (AI Memory Bank)

## 2026-04-05 - Test Suite Cleanup & Sandbox Validation
- **Major Test Fixes**: Resolved systemic failures across multiple test files (`mqttProvider`, `opcuaProvider`, `piSystemRepository`, `llmEngine`, etc.) caused by incorrect `axios` mocking and ESM/CommonJS interop issues with `node-opcua` and `hexy`.
- **Sandbox Security**: Created `tests/sandbox.test.js` to formally verify that user-provided code (Mapper/Alerts) is strictly isolated (no `require`, no `fs`, enforced timeouts).
- **Webhook Reliability**: Patched `core/webhookManager.js` to fix an anti-flood edge case when using fake timers by switching to `.has()` checks.
- **DuckDB Fixes**: Corrected parameter binding in `core/webhookManager.js` and `storage/dbManager.js` by spreading arguments instead of passing arrays (fixing a bug with the DuckDB Node.js driver).
- **Webhook Enhancements**: Added "Test Webhook" feature with a dedicated backend method, API endpoint, and UI button in the Admin panel to allow manual verification of webhook targets.
- **Cross-View State Sync**: Added `tests/e2e/state-sync.spec.js` to ensure the application state (topic selection) persists when switching between Tree, Mapper, and Chart views.
- **Global Test Runner**: Introduced `tests/run_all.js`, a script to execute all unit and E2E tests, handle timeouts, and generate a `test-results/global_test_report.md`.
- **Playwright Config**: Updated `playwright.config.js` to `reuseExistingServer: true`, facilitating faster local development and debugging.
- **AI Guidelines**: Added `GEMINI.md` to establish architectural standards and project-specific instructions for AI assistants.
- **Core Logic Touched**: `webhookManager.trigger`, `webhookManager.testWebhook`, `dbManager.pruneOldEvents`, `adminApi.js`, `view.admin.js`, `playwright.config.js`.
- **Pitfalls & Solutions**:
    - *Cross-View Sync*: Topic selection was being lost when switching views due to incorrect state hydration in `public/state.js`. Verified that `subscribe()` and `unsubscribe()` correctly manage the lifecycle of reactive components.
    - *Test Runner Stability*: Created a custom runner in Node.js (`tests/run_all.js`) to prevent Jest or Playwright from hanging in CI environments and to provide a consolidated Markdown report.
    - *DuckDB Parameter Binding*: DuckDB's Node.js driver `run` method requires spread arguments for parameters, unlike the `sqlite3` driver which often accepts an array. This was causing silent failures in DB operations. Fixed by removing the array wrapping in `db.run` calls.
    - *Axios Mocking*: Many tests failed because `axios` was mocked as an object but used as a function. Solution: `jest.mock('axios', () => jest.fn())`.
    - *ESM Conflicts*: `node-opcua` dependencies (like `hexy`) use ESM exports which crash Jest in CommonJS mode. Solution: Explicitly mock `node-opcua` at the very top of the test file before any other `require`.
    - *File Streaming*: `fileProvider.test.js` was unstable with fake timers due to internal Node.js stream buffering. Solution: Switched to real timers with small delays for robust integration testing.

## 2026-04-05 - Enterprise Observability & Standardized Error Logging
- **Prometheus Metrics**: Implemented `/api/metrics` endpoint exposing real-time metrics: `korelate_messages_processed_total` (throughput), `korelate_active_ws_connections` (active clients), `korelate_dlq_size` (DLQ depth), and `korelate_errors_total` (error counts by code).
- **Standardized Error Logging**: Created `core/errorUtils.js` to ensure all error logs include `code`, `message`, `traceId` (mapped from `correlationId`), and `stack` (when available). This enables better observability and troubleshooting in enterprise environments.
- **Metrics Infrastructure**: Added `core/metricsManager.js` to centralize metric collection and formatting (Prometheus version 0.0.4).
- **Core Logic Touched**: `core/messageDispatcher.js`, `core/websocketManager.js`, `storage/dlqManager.js`, `interfaces/web/router.js`.
- **Pitfalls & Solutions**:
    - *Metric Consistency*: Standardized on `correlationId` as the source for `traceId` in error logs to maintain consistency with the existing distributed tracing logic in `messageDispatcher.js`.
    - *Performance Protection*: Ensured that the `/api/metrics` endpoint is protected by `ipFilterMiddleware` to prevent unauthorized scraping of system health data.
    - *DLQ Observability*: Added `getMessages().length` as a gauge in metrics to provide immediate visibility into database insertion failures.

