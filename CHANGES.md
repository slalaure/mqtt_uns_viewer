# Korelate Changelog (AI Memory Bank)

## 2026-04-05 - Test Suite Cleanup & Sandbox Validation
- **Major Test Fixes**: Resolved systemic failures across multiple test files (`mqttProvider`, `opcuaProvider`, `piSystemRepository`, `llmEngine`, etc.) caused by incorrect `axios` mocking and ESM/CommonJS interop issues with `node-opcua` and `hexy`.
- **Sandbox Security**: Created `tests/sandbox.test.js` to formally verify that user-provided code (Mapper/Alerts) is strictly isolated (no `require`, no `fs`, enforced timeouts).
- **Webhook Reliability**: Patched `core/webhookManager.js` to fix an anti-flood edge case when using fake timers by switching to `.has()` checks.
- **DuckDB Fixes**: Corrected parameter binding in `core/webhookManager.js` and `storage/dbManager.js` by spreading arguments instead of passing arrays (fixing a bug with the DuckDB Node.js driver).
- **Webhook Enhancements**: Added "Test Webhook" feature with a dedicated backend method, API endpoint, and UI button in the Admin panel to allow manual verification of webhook targets.
- **Core Logic Touched**: `webhookManager.trigger`, `webhookManager.testWebhook`, `dbManager.pruneOldEvents`, `adminApi.js`, `view.admin.js`.
- **Pitfalls & Solutions**:
    - *DuckDB Parameter Binding*: DuckDB's Node.js driver `run` method requires spread arguments for parameters, unlike the `sqlite3` driver which often accepts an array. This was causing silent failures in DB operations. Fixed by removing the array wrapping in `db.run` calls.
    - *Axios Mocking*: Many tests failed because `axios` was mocked as an object but used as a function. Solution: `jest.mock('axios', () => jest.fn())`.
    - *ESM Conflicts*: `node-opcua` dependencies (like `hexy`) use ESM exports which crash Jest in CommonJS mode. Solution: Explicitly mock `node-opcua` at the very top of the test file before any other `require`.
    - *File Streaming*: `fileProvider.test.js` was unstable with fake timers due to internal Node.js stream buffering. Solution: Switched to real timers with small delays for robust integration testing.

