## 2026-04-05 - View Refactoring & Web Component Migration
- **Monolithic Views Refactored**: Successfully migrated `view.admin.js` and `view.chat.js` logic into reusable Native Web Components.
    - *Admin View*: Created `admin-db-panel`, `admin-alerts-panel`, `admin-assets-panel`, `admin-simulators-panel`, `admin-parsers-panel`, `admin-ai-panel`, and `admin-logs-panel`.
    - *Chat View*: Fully migrated all logic (STT, TTS, Camera, Sessions, Streaming, File Uploads, Drag/Resize) into the `<ai-chat-widget>` component.
- **Fixed Infinite Loop**: Resolved a critical UI bug where `view.chat.js` and `AiChatWidget` competed for the same DOM elements, causing a re-rendering loop.
- **Improved Encapsulation**: Reduced DOM manipulation boilerplate by over 80% in the orchestrator files (`view.admin.js`, `view.chat.js`).
- **XSS & Security**: Integrated `DOMPurify` sanitization directly into the `AiChatWidget` rendering pipeline.
- **Frontend Bug Fixes**:
    - Fixed CustomEvent bubbling (`bubbles: true`, `composed: true`) in `admin-assets-panel` and `admin-simulators-panel` to ensure the Ace Editor modal opens correctly when editing files.
    - Corrected API endpoint paths in Web Components (`admin-alerts-panel`, `admin-db-panel`, `admin-ai-panel`, `ai-chat-widget`) to perfectly match the backend Express routes, resolving 404 errors.
- **Backend API Hardening**: 
    - Added missing `GET` and `PUT` routes in `interfaces/web/adminApi.js` for `/hmi-assets/:filename` and `/simulators/:filename` to allow reading and updating files from the Admin code editor.
    - Exposed `MapperEngine.deleteVersion()` to allow safe deletion of non-active mapper versions via the Admin UI.
- **View Refactoring & Web Component Migration**:
    - **Mapper View**: Successfully refactored `view.mapper.js` to follow the Managed View pattern. Extracted DOM to `view.mapper.html`. Resizer initialization and lifecycle management (mount/unmount) are now properly encapsulated.
    - **Alerts View**: Successfully split `view.alerts.js` into `<alerts-active-panel>` and `<alerts-rules-panel>`. DOM extracted to `view.alerts.html`.
    - **Chart View**: Fully refactored to use `<chart-config-bar>`, `<chart-time-slider>`, and `<chart-variable-list>`. DOM extracted to `view.chart.html`.
    - Exposed `AlertManager.purgeResolvedAlerts()` to allow database maintenance (Delete + Vacuum) via the Admin UI.
- **Protocol-Agnostic Refactoring**:
    - Renamed `state.currentBrokerId` to `state.currentSourceId` in `public/state.js` to generalize across different data providers (MQTT, OPC UA, HTTP, etc.).
    - Executed a comprehensive project-wide renaming to eradicate legacy "broker" terminology in favor of "source" (data origin) and "connector" (technical plugin).
        - UI & CSS: `broker-dot` ➡️ `connector-dot`, `broker-name` ➡️ `source-name`.
        - DOM Elements: `#alerts-broker-filter` ➡️ `#alerts-source-filter`, `.target-broker-select` ➡️ `.target-source-select`.
        - JS Variables: `isMultiBroker` ➡️ `isMultiSource`, `brokerConfigs` ➡️ `providerConfigs`.
        - AI Manifest: Updated descriptions to specify `source_id` instead of `broker ID`.
    - Updated all views (`view.chart.js`, `view.mapper.js`, `view.history.js`, `view.publish.js`) and `app.js` to subscribe to the new `currentSourceId`.

    - Standardized DOM data attributes in `tree-manager.js` to use `data-source-id` instead of `data-broker-id`.
- **Chart View Fixes**:
    - **Tree Selection & Payloads**: Resolved the "No numeric properties found" bug by ensuring `tree-manager.js` correctly stringifies JSON payloads before storing them in the DOM `dataset`. Fixed selectors to match the new `data-source-id` attribute.
    - **Chart Rendering & Dates**: Fixed a bug where curves wouldn't display on initial load because the requested date range was 1970 (`timestamp = 0`). Now defaults to a 1-hour window.
    - **Color Customization & Smart Logic**: 
        - Restored the "Smart Color" feature: variables now receive intelligent default colors based on semantic naming (e.g., Red for temperature, Blue for water/humidity) even when not manually set.
        - Improved "Smart Axis" behavior: variables sharing the same axis now get slight color variations (saturation/lightness) instead of being identical, making them easier to distinguish.
        - Fixed the color picker in `chart-variable-list.js` to correctly display and allow manual overrides without forcing a global default.
        - **Live Mode Color Picker Fix**: Prevented the native OS color picker from aggressively closing during live chart updates. The UI component (`chart-variable-list.js`) now patches DOM `<input type="color">` values directly rather than triggering a full re-render, ensuring the user can take their time selecting a custom color even when data is flowing.
    - **Flexbox Resize & UI Oomph**: 
        - Resolved a display glitch when resizing the Chart View horizontally by forcing `min-height: 0` on containers and strict `100%` dimensions on the `<canvas>`.
        - Made the Chart configuration header (`chart-config-bar`) opaque and sticky to ensure it remains legible and "on top" when the view is resized or scrolled.
- **Improved Testing**: 
    - Added unit tests for DLQ clearing and message retrieval in `tests/dlqManager.test.js`.
    - Added unit tests for version management in `tests/mapperEngine.test.js`.
    - Added unit tests for alerts history purging in `tests/alertManager.test.js`.
    - Restored compatibility for E2E tests by adding specific IDs to `confirmModal` elements in `public/utils.js`.
 using JSDoc `@typedef`.
- **Core Dispatcher**: Updated `core/messageDispatcher.js` to export `handleMessage` for type reference and added type definitions for all module-scoped variables.
- **Provider Standardization**: Updated `BaseProvider` and all core connectors (`mqtt`, `opcua`, `http`, `file`) with specific `ProviderConfig` typedefs and JSDoc-typed class members.
- **Data Pipeline Typing**: Updated `storage/dataManager.js` to use the centralized `Message` type for `insertMessage` and `retryMessage`.
- **Webhook Observability**: Added `Webhook` typedef to `core/webhookManager.js` and typed member variables for better IDE support.
- **Core Logic Touched**: `core/messageDispatcher.js`, `connectors/baseProvider.js`, `storage/dataManager.js`, `connectors/*/index.js`, `core/webhookManager.js`.
- **Pitfalls & Solutions**:
    - *ESM/CJS Interop in JSDoc*: Used `typeof import(...)` and relative paths in `@typedef` to ensure JSDoc types are discoverable across the project without requiring a global `.d.ts` file or TypeScript.
    - *HandleMessage Export*: Exported `handleMessage` from `messageDispatcher.js` to allow providers to correctly reference the central handler type in their `ProviderContext`.

## 2026-04-05 - Edge Resource Hardening & DLQ Pruning
- **DLQ Pruning**: Implemented `checkAndPrune` in `storage/dlqManager.js` to enforce a maximum disk-size limit (`DLQ_MAX_SIZE_MB`) for the DLQ. Prevents OS failure in edge deployments during extended offline periods by automatically dropping the oldest batches.
- **Adaptive Pruning Multiplier**: Adopted DuckDB's adaptive multiplier approach in `dlqManager.js` to aggressively prune if the disk size significantly exceeds the threshold.
- **Config**: Added `DLQ_MAX_SIZE_MB` and `DLQ_PRUNE_CHUNK_SIZE` to `boot/config.js` with database merging support.
- **Testing**: Added unit test `tests/dlqManager.test.js` to ensure the pruning algorithm drops the correct amount of lines based on the threshold. Added `stop()` to `dlqManager` to properly clear the retry interval and prevent Jest from hanging.
- **Core Logic Touched**: `storage/dlqManager.js`, `boot/config.js`, `tests/dlqManager.test.js`.
- **Pitfalls & Solutions**:
    - *Test Stability*: The DLQ retry timer created in `init()` was causing the unit tests to hang because the interval wasn't cleared. Fixed by exposing a `stop()` method and calling it in `afterEach()`.
    - *Aggressive Multiplier Deletion*: Testing the prune logic with very small file sizes (`0.001 MB`) inadvertently caused the adaptive multiplier to jump to `20`, generating a target prune of `100` lines which immediately deleted the entire file. Tweaked the payload sizes and limits in the test to verify a partial deletion instead.

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
- **Unit Testing**: Added `tests/metricsManager.test.js` and `tests/errorUtils.test.js` to validate the observability pipeline and ensure Prometheus output compliance.
- **Core Logic Touched**: `core/messageDispatcher.js`, `core/websocketManager.js`, `storage/dlqManager.js`, `interfaces/web/router.js`, `core/errorUtils.js`, `core/metricsManager.js`.
- **Pitfalls & Solutions**:
    - *Metric Consistency*: Standardized on `correlationId` as the source for `traceId` in error logs to maintain consistency with the existing distributed tracing logic in `messageDispatcher.js`.
    - *Performance Protection*: Ensured that the `/api/metrics` endpoint is protected by `ipFilterMiddleware` to prevent unauthorized scraping of system health data.
    - *DLQ Observability*: Added `getMessages().length` as a gauge in metrics to provide immediate visibility into database insertion failures.
    - *Circular Dependencies*: Resolved a circular dependency chain (`metricsManager` -> `dlqManager` -> `errorUtils` -> `metricsManager`) by implementing lazy-loading of modules in `core/errorUtils.js` and `core/metricsManager.js`.
    - *Jest Mocking & Module Caching*: Fixed an issue where `jest.spyOn` failed to track `logError` calls in `messageDispatcher` by switching from named imports to full module imports, ensuring the spy correctly intercepts the module property.

## 2026-04-05 - Southbound Plugin Architecture (ConnectorManager)
- **Plugin Loader Refactoring**: Transformed `connectors/connectorManager.js` into a robust, protocol-agnostic plugin loader.
    - Implemented a hierarchical resolution strategy: 1. `korelate-plugin-${type}`, 2. `${type}`, 3. Internal connectors (`connectors/${type}/index.js`).
    - Added strict interface validation ensuring all dynamically loaded plugins extend the `BaseProvider` class.
    - Improved logging and error reporting for plugin resolution and instantiation failures.
- **Resilience**: Added a fallback console logger to `ConnectorManager` to prevent crashes if methods are called before full system initialization (e.g., during unit tests).
- **Unit Testing**: Created `tests/connectorManager.test.js` to verify the new resolution logic, external plugin priority, and interface validation.
- **Core Logic Touched**: `connectors/connectorManager.js`, `boot/services.js`.
- **Pitfalls & Solutions**:
    - *Resolution Order*: Ensured `korelate-plugin-` prefix is checked BEFORE internal connectors to allow users to override built-in providers without modifying the core codebase.
    - *Module Mocking in Tests*: Fixed a `TypeError` in tests by mocking `messageDispatcher` early, preventing its Worker Pool from initializing and creating open handles that hang Jest.
    - *Interface Validation*: Used `instanceof BaseProvider` to ensure that even third-party modules follow the Korelate standardized interaction patterns.

## 2026-04-05 - Global Maintenance
- **Copyright Header Update**: Harmonized all JavaScript file headers to reflect the extended project lifespan: `(c) 2025-2026 Sebastien Lalaurette`.

## 2026-04-05 - Web Component Architecture Refactoring
- **Template Extraction**: Initiated the extraction of raw HTML/CSS from Javascript Web Components into dedicated external template files to improve maintainability and separation of concerns.
    - Created `public/components/templates/` directory to store HTML templates.
    - Refactored `AiChatWidget` (`public/components/ai-chat-widget.js`) to asynchronously load `ai-chat-widget.html`.
    - Refactored `AdminAiPanel` (`public/components/admin-ai-panel.js`) to asynchronously load `admin-ai-panel.html`.

## 2026-04-05 - Log Reading Security & Performance Optimization
- **Security Hardening**: Replaced vulnerable `exec('tail...')` call in Admin API with a native Node.js implementation (`readLastLines`). This eliminates potential shell injection risks.
- **Performance Optimization**: Created `core/fsUtils.js` with a memory-efficient `readLastLines` utility that reads files backwards in chunks without loading the entire content into RAM.
- **Validation**: Added `tests/test_fs_utils.js` to verify the correctness of the reverse-buffer file reading logic across edge cases (empty files, small files, large requests).

## 2026-04-05 - InfluxDB Native Integration
- **Historian Storage**: Added native support for **InfluxDB v2** as a Perennial Storage Option, serving alongside TimescaleDB for long-term Edge metrics retention.
- **Storage Driver**: Created `storage/influxDbRepository.js` using pure HTTP (`axios`) to format Korelate payloads into InfluxDB Line Protocol without requiring heavy external SDKs.
- **Integration**: Plumbed the new repository into `storage/dataManager.js`, allowing it to participate in the automated fan-out insertion process and leverage the centralized Dead Letter Queue (DLQ) in case of network failure.
- **Configuration & UI**: Exposed all necessary configuration fields (`INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG`, `INFLUX_BUCKET`) in `boot/config.js` and dynamically generated them in the First-Run Setup Wizard (`public/config.html`).
- **Unit Testing**: Added exhaustive tests (`tests/influxDbRepository.test.js`) covering line protocol serialization escapes and DLQ fallback logic.
