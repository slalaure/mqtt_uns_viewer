## 2026-04-10 - AI Learning Studio (DuckDB Profiling & LLM Synthesis)
- **DuckDB Profiling API**: Created `/api/context/profile` endpoint in `interfaces/web/contextApi.js`. 
    - Implemented advanced SQL using CTEs (Common Table Expressions) and Window Functions (`lag()`).
    - Calculates Min, Max, Mean, StdDev, Null Count, Frequency (Avg sampling interval), and "Chatter" (number of mean crossings) for multiple topics and variables in parallel.
    - [BUGFIX] Replaced `db.get` with `db.all` to avoid "get() is not implemented because it's evil" fatal error in DuckDB Node.js driver.
    - [BUGFIX] Casted `COUNT(*)` to `INTEGER` to prevent `JSON.stringify` BigInt serialization crash.
- **LLM Synthesis Engine**: 
    - Added `generateDataProfilePrompt(profileData, currentModel)` to `core/engine/llmEngine.js`.
    - Injects the active `uns_model.json` to allow the LLM to infer missing objects and guess relationships (e.g. `HasParent`, `HasComponent`).
    - Added strict "Ontology Rules" preventing the LLM from grouping independent telemetry into monolithic "Global" concepts. Forces distinct ObjectTypes and Instances per logical asset based on the topic hierarchy.
    - Explicitly mandates **ISA-95** conventions (e.g., `EnterpriseType`, `SiteType`, `AreaType`) for OT hierarchies and **Brick Schema** conventions (e.g., `BuildingType`, `FloorType`, `AHUType`) for BMS environments.
    - Enforces rigorous semantic naming (`snake_case` for instances, `PascalCase` ending in `Type` for object types) to eliminate fallback artifacts like `generated_xxx`.
    - Instructs the AI to analyze statistical fingerprints and propose strictly formatted JSON updates for `uns_model.json` (nominal values, quality scores) and `alertRules` (including debounce-aware logic).
- **Frontend Integration**: 
    - Added "Profile & Learn" button to `public/components/chart-config-bar.js`.
    - Implemented a rich, interactive approval modal in `public/view.chart.js` allowing operators to individually review, modify, or reject every suggested schema update and alert rule.
    - Revamped the UI to be responsive and full-width, utilizing a CSS grid layout. Added info-boxes to clarify the role of `Element ID`, `Type ID`, and `Topic`, along with guidance on establishing physical hierarchies through relationships (`HasParent`, `HasComponent`). Colors are now fully dark-mode compatible.
    - Added editable relationships: AI-inferred relationships can now be manually corrected or added directly within the UI.
    - Converted `Element ID` and `Type ID` fields into hybrid dropdowns (`<datalist>`) populated with existing instances and types from the current semantic model, ensuring structural consistency.
    - Renamed "Quality" label to "Standard Quality Level".
    - [BUGFIX] Fixed `confirmModal` in `public/utils.js` blindly replacing `\n` with `<br>` for HTML strings, which caused extreme layout expansion and broke scrolling. Forced modal containers to `90vh` max-height with Flexbox overflow handling.
- **Hot-Reloading**: Created `/api/context/apply-learn` which directly integrates approved updates into the `SemanticManager` and `AlertManager` at runtime, triggering an immediate UI refresh.
    - [BUGFIX] Corrected the payload builder to target `.instances` and `.objectTypes` rather than `.objects` to align with I3X schema formatting in `uns_model.json`. Also correctly maps `HasParent` relations to the native `parentId` property.
    - Improved the API fallback element generator to construct semantic identifiers based on the physical MQTT topic path rather than blind timestamps if the LLM skips an object definition.
- **AI Chat Widget**: 
    - [BUGFIX] Fixed a critical logic flaw in the Agent loop (`chatApi.js`) where tool executions were not triggering a subsequent LLM fetch, causing the AI to abruptly stop after calling a tool without providing an answer.
    - [BUGFIX] Resolved an "infinite approval loop" where the AI Chat would repeatedly ask for permission to use `update_uns_model`. This was caused by an outdated schema validation rule in `aiTools.js` that rejected valid Object payloads by strictly expecting a legacy Array, forcing the LLM into a perpetual retry cycle.
    - Restored the v1.5.1 WebSocket streaming capabilities in the UI (`ai-chat-widget.js`). The chat now displays real-time `status` updates (e.g., "⏳ Analyzing results (Turn 2)...") and calculates the exact execution duration for every tool used (e.g., "✅ 🔧 Finished get_alerts 1.25s"), providing complete transparency into the AI's internal reasoning loop.
    - Implemented a missing `approval_required` handler in the UI. When the AI attempts to use a destructive tool (e.g., `update_uns_model`), the UI now pauses execution, decodes the tool arguments, and presents an interactive Confirmation Modal to the user before resuming the backend agent loop.
- **CDM Modeler Improvements**:
    - Added an "Advanced Raw JSON" mode (⚙️ Raw) to view and edit the entire `uns_model.json` (Namespaces, Types, and Instances) globally within the embedded Ace Editor, instead of only editing single selected items.
    - [UI FIX] The Raw Mode now properly disables the "Display Name" input to prevent accidental renames of the "uns_model.json" label, hides the irrelevant "Form/JSON" toggle and "Delete" button, and dynamically tracks unsaved changes to enable the global "Save" button.
    - [BUGFIX] Fixed the JSON view desynchronization: switching between tree objects while in "JSON Mode" now instantly updates the editor content without having to toggle back and forth to the "Form Mode".
    - [BUGFIX] Fixed a lifecycle bug where the `Namespace URI` dropdown would render completely empty because its options were being populated before the DOM element was correctly attached and bound to the state manager.
    - Prevented data loss during UI saves: The "Form Mode" now preserves all deep/custom AI profiling schema attributes (`nominal_value`, `expected_range`, `data_frequency_seconds`, `quality_score`) when saving properties, rather than blindly overwriting them.
    - Added a dedicated "Profiling" sub-row in the Object Schema Attributes UI to explicitly display and allow manual editing of Nominal, Min, Max, Freq, and Qual values discovered by the AI Learning Studio. This sub-row now dynamically appears only for `number` or `integer` data types.
    - Automatically falls back the `Label/Title` to the `ID` if left empty, rather than saving an empty string.
    - [UI FIX] When a Namespace is selected in the registry, the irrelevant "Object Schema Attributes" and "i3X Relationships" sections are now hidden. Additionally, the "Namespace URI" dropdown dynamically transforms into an editable text input to allow creating and modifying custom URIs.
- **Testing**: Added a dedicated test scenario to `test_plan.md` (Section 3.11) to cover the full "Learning Studio" flow.
- **Core Logic Touched**: `interfaces/web/contextApi.js`, `core/engine/llmEngine.js`, `public/view.chart.js`, `public/components/chart-config-bar.js`, `interfaces/web/router.js`.

- **Docker Testing Environment**: Completely overhauled `docker-compose.yml.local` to include 14 distinct simulation containers (Mosquitto, OPC UA, Modbus, Postgres, MySQL, MSSQL, Kafka, Zookeeper, SNMP, REST Mock, plus mocks for S7, EIP, BACnet, and KNX).
- **Docker Profiles**: Implemented Compose Profiles (`core`, `ot`, `bms`, `it`, `all`) to allow developers to spin up specific subsets of simulators without overwhelming their local RAM.
- **Port Flexibility**: Added dynamic environment variables (`PORT_HTTP`, `PORT_MCP`) to the Compose file to easily avoid local `8080` port binding conflicts.
- **Protocol Integration Testing**: Created a dedicated `tests/integration_protocols.js` Node.js script. Instead of just pinging ports, this script uses actual Node.js drivers (`mqtt`, `pg`, `axios`, `modbus-serial`, `net-snmp`, `kafkajs`) to perform real protocol handshakes, register reads, and queries against the local Docker simulators, guaranteeing that the connectors are talking to valid endpoints.

## 2026-04-09 - IT & Data Connectors Expansion
- **New Data Providers**: Added 4 new generic data/IT protocols to Korelate's Southbound connector library:
  - 🗄️ **SQL Database Poller**: Periodically queries PostgreSQL, MySQL, or MS SQL Server, leveraging a cursor to fetch new rows incrementally.
  - 🌐 **REST API Poller**: Actively interrogates HTTP GET endpoints at set intervals, supporting Basic, Bearer, and API Key authentication.
  - 📶 **SNMP Poller**: Fetches OID data from network equipment using SNMP v1 and v2c.
  - 🚀 **Apache Kafka**: High-throughput bidirectional integration with Kafka clusters.
- **Dynamic Imports**: Uses optional dependencies (`pg`, `mysql2`, `mssql`, `axios`, `net-snmp`, `kafkajs`). If a missing package is requested, Korelate logs an error suggesting the `npm install` command rather than crashing.
- **UI Integrations**: 
  - Added new protocols to the Data Provider Builder Wizard in `public/config.html` and `public/config.js` with dynamic forms.
  - Updated the Help Guide modal with precise explanations and syntax examples for the new connectors.
- **Testing**: Added unit tests (`tests/sqlProvider.test.js`, `tests/restPollerProvider.test.js`, `tests/snmpProvider.test.js`, `tests/kafkaProvider.test.js`) and updated `test_plan.md` to cover their functionality.

## 2026-04-08 - Industrial Connectors Expansion
- **New Data Providers**: Added 4 new native industrial protocols to Korelate's Southbound connector library (`connectors/`):
  - 📡 **Modbus TCP**: Uses `modbus-serial`. Supports Coil, Holding, Input, and Discrete mapping via simple Address parsing (e.g., `40001:16::factory/temp`).
  - ⚙️ **Siemens S7 (S7-Comm)**: Uses `nodes7`. Connects over TCP 102 to S7-300/400/1200/1500 PLCs with direct tag mapping (e.g., `DB1,REAL4::factory/pressure`).
  - 🔌 **EtherNet/IP (CIP)**: Uses `ethernet-ip`. Connects to Allen-Bradley/Omron PLCs with CIP Tag mapping.
  - 🏢 **BACnet/IP**: Uses `node-bacnet`. Connects to Building Management Systems (BMS), HVACs, and sensors. Maps `ObjectType:Instance:PropertyId` to the UNS (e.g., `0:1:85::bms/room1/temp`).
  - 💡 **KNX/IP**: Uses `knx`. Connects to home and building automation systems via IP Gateways. Event-driven mapping using Group Addresses and DPTs (e.g., `1/1/1:DPT1.001::bms/light`).
- **Dynamic Imports**: These libraries are massive and very specific. They are built as *optional dependencies*. If a user configures a Modbus PLC but hasn't installed the library, Korelate won't crash; it will log a clear error asking the user to run `npm install modbus-serial`.
- **UI Integrations**: 
  - Added all 4 protocols to the `config.html` Wizard with dynamic conditional forms for Host, Port, Rack, Slot, and Routing paths.
  - Updated the Data Providers Guide (Help Modal) to reflect these new industrial capabilities.

## 2026-04-08 - I3X Client Connector & UI Hierarchy Improvements
- **UNS Model Migration**: Moved the JSON Import/Export features for `uns_model.json` from the generic Configuration page directly into the CDM Modeler view. This centralizes all schema management in a single logical workspace.
- **I3X Client Support**: Added a new data connector (`connectors/i3x/index.js`) allowing Korelate to act as an I3X client. It can:
  - Connect to remote I3X servers (RFC 001).
  - Subscribe to real-time data using the I3X Subscription and SSE streaming protocol.
  - Publish (write) data back to remote objects using the `PUT /value` endpoint.
- **Agnostic Hierarchy Support**: Refactored the "ISA-95 Level" field into a more flexible "Hierarchy Level". 
  - It is now optional and provides autocompletion for both ISA-95 (Industry) and Brick Schema (Buildings).
  - Empty levels are no longer persisted in the JSON model, keeping it clean for non-industrial use cases.
- **UI & UX Polish**:
  - Added an "ℹ️ Help" guide in the Modeler view explaining CDM, UNS, and AI Assistant integration.
  - Replaced the chat FAB emoji with the official Korelate SVG logo.
  - Updated chat header to "Start to Korelate, chat now".
- **Core Logic Touched**: `connectors/i3x/index.js`, `public/config.html`, `public/config.js`, `public/html/view.modeler.html`, `public/view.modeler.js`.

## 2026-04-08 - I3X RFC 001 Full Compliance Achieved
- **REST Endpoints Added**: Upgraded the `i3xRouter` to support standard RESTful `GET` queries mandated by the I3X compliance test suite. Added:
  - `GET /objecttypes/:elementId`
  - `GET /relationshiptypes/:elementId`
  - `GET /objects/:elementId`
  - `GET /objects/:elementId/related`
  - `GET /objects/:elementId/value`
  - `GET /objects/:elementId/history`
- **Subscription Lifecycle Completeness**: 
  - Added `GET /subscriptions/:id` to retrieve details of an active subscription.
  - Added `POST /subscriptions/:id/unregister` to dynamically remove elements from a subscription.
  - Enforced strict validation during `/register` to return `404` for unknown element IDs.
  - Ensured `/delete` is idempotent, returning `200` regardless of prior existence.
- **SSE Streaming Compatibility**: Implemented a graceful stream closure timeout specifically for `python-requests` clients that fail to utilize `stream=True`, preventing indefinite blocking during automated compliance checks.
- **Authentication Bypass (API Keys)**: Enabled API Keys in `authMiddleware` to directly authorize headless script interactions without UI login.
- **Core Logic Touched**: `interfaces/i3x/i3xRouter.js`, `interfaces/web/middlewares/auth.js`, `storage/userManager.js`.
- **Result**: The server now passes 100% (71/71) of the CESMII I3X Compliance test suite, achieving the "Full" compliance level.

## 2026-04-08 - CDM Modeler Metadata & Key Constraints
- **Enhanced Property Metadata**: Added granular control over each CDM attribute with support for:
  - **Confidentiality Levels**: Public, Internal, Confidential, Restricted.
  - **Sensitivity Levels**: Normal, Sensitive, Highly Sensitive.
- **Key Constraints & Linking**:
  - Added support for **Primary Key (PK)** and **Foreign Key (FK)** designations for each attribute.
  - **Foreign Key Linking**: Implemented a dynamic dropdown allowing users to link an FK attribute *specifically* to the Primary Key attributes of any other Object Type or Instance within the model. The dropdown list actively scans the entire model's schema to extract and present only properties marked as 'PK'.
- **UI Improvements**:
  - Added a dedicated header row for the "Object Schema Attributes" table to clarify metadata fields.
  - Optimized the property row layout with responsive `flex` sizing and conditional visibility for the FK target selector.
  - Added reactive re-rendering logic so designating a new property as a 'PK' immediately makes it available as a target in the 'FK' dropdowns.
- **Core Logic Touched**: `public/view.modeler.js`, `public/html/view.modeler.html`.
- **Pitfalls & Solutions**:
  - *Layout Density*: Adding 4 new fields to the property row made it tight. Solved by using `min-width` and a clear header row to maintain readability while ensuring all enterprise metadata is accessible.

## 2026-04-06 - Replacing Vis-Network with Custom SVG KorelateGraph Engine
- **Architectural Shift**: Removed the `vis-network` dependency completely from the Modeler view. The library demonstrated catastrophic conflicts with the SPA lifecycle, Vue/Proxy-like reactive state, and Flexbox `display: none` DOM rendering, leading to "ghost canvas" click interception and frozen nodes.
- **KorelateGraph Engine**: Built a 100% dependency-free, native SVG Force-Directed graph engine (`KorelateGraph`) directly into `public/view.modeler.js`.
- **Features Implemented Natively**:
  - **Custom Physics**: Hooke's law springs and Coulomb repulsion computed manually in a `requestAnimationFrame` loop.
  - **Flawless Interaction**: Native SVG DOM events handle Drag & Drop perfectly, eliminating coordinates desync caused by CSS flexbox delays.
  - **Freeze Toggle**: Pauses the physics integration loop instantly without breaking drag events.
  - **Double-Click Navigation**: Seamlessly jumps to parent/type/linked nodes.
- **Result**: The Modeler Dependency Graph is now extremely fast, visually stable, and completely immune to external library bugs.

## 2026-04-06 - CDM Modeler V3 Refactoring (i3X Compliance)
- **3-Column IDE Layout**: Refactored the Modeler view into a Master-Detail-Graph layout using native resizers and Flexbox.
- **i3X Relationships Editor**: Added a dedicated section to manage semantic relationships (HasParent, HasComponent, SuppliesTo, etc.) directly from the UI, syncing securely with the backend JSON.
- **Schema Simplification**: Merged "Properties" and "Telemetry" into a single "Object Schema Attributes" list, aligning with the i3X JSON Schema standard where dynamic/static properties are not strictly segregated.
- **Dependency Graph**: Re-implemented the `vis-network` graph to show full semantic dependencies (Namespaces, Parents, Types, and custom relations).
- **Simulation Model Overhaul**: Rewrote `data/uns_model.json` to exhaustively map Stark Industries and HyDroChem-AG simulators, including complex topological relationships.
- **Core Logic Touched**: `public/view.modeler.js`, `public/html/view.modeler.html`, `data/uns_model.json`.
- **Pitfalls & Solutions**:
    - *ResizeObserver Loops*: `vis-network` triggered infinite layout loops in Flexbox. Fixed by explicitly sizing the container, binding the right resizer to the graph panel (`panelB`), and suppressing benign ResizeObserver errors globally.
    - *Graph Interactivity*: Frequent auto-saves reset the physics engine. Decoupled graph redrawing from text input and added a "Freeze/Unfreeze" toggle to allow manual node positioning.

## 2026-04-05 - Publish View Multi-Source UX Fixes
- **Data Provider Visibility**: Resolved a UX issue in the Publish view where users couldn't see or select the target data provider. 
    - **Manual Publish**: The 'Target Provider' dropdown is now always visible. If only a single broker/provider is configured, the dropdown renders in a disabled (read-only) state to clearly indicate the destination. Fixed a parameter mismatch (`sourceConfigs` vs `providerConfigs`) that caused the dropdown to fail to populate legacy MQTT brokers.
    - **Simulators**: Replaced the global target note with a dynamic dropdown selector for *each* individual simulator. Users can now independently route data from different simulators to different connectors (e.g., sending `deathstar` telemetry to `factory_opc` while `hydrochem` publishes to `mqttunsviewer.com`). The backend `simulatorManager` was updated to accept a `sourceId` on startup and inject it dynamically into the simulation scenario factory.

## 2026-04-05 - Alert Creation Routing Hotfix
- **[HOTFIX] Alert Creation Routing**: Fixed a bug where clicking "Create Alert Rule" from the Tree view navigated to the default Alerts Dashboard instead of opening the Rule Creation modal. Reversing the execution order in `public/app.js` ensures the Alerts View DOM is fully mounted and event listeners (including the Ace editor) are attached *before* simulating the tab switch and populating the code editor.

## 2026-04-05 - AI Chat Restoration & WebSocket Bi-directional Flow
- **Fixed AI Chat Communication**: Resolved a critical breakage where chat messages were sent via WebSocket by the frontend but ignored by the backend due to missing handlers.
- **WebSocket Plugin Architecture**: Enhanced `core/websocketManager.js` with a `registerHandler` mechanism, allowing external APIs (like Chat) to plug into the real-time event loop without bloating the core manager.
- **Chat Logic Refactoring**: 
    - Migrated `interfaces/web/chatApi.js` to a shared logic model. The same `handleCompletion` engine now powers both legacy REST requests and new real-time WebSocket streams.
    - Added **Context Awareness**: The AI now receives the user's currently selected topic and data source as part of its system prompt, enabling more precise answers.
- **Frontend Streaming Bridge & Rendering**: 
    - Patched `public/view.chat.js` to correctly translate WebSocket envelope messages (`chat-stream`) into internal component states (`start`, `chunk`, `done`).
    - **[HOTFIX] Disappearing Messages**: Fixed a bug where `AiChatWidget` would wipe the UI after a generation. The WebSocket handshake bypasses Express sessions, causing the backend to save the chat history in an 'Anonymous' global directory instead of the user's folder. When the frontend later fetched the history via an authenticated HTTP request, it found an empty array and cleared the UI. Solved by injecting `window.currentUser` directly into the WS payload from `view.chat.js`.
    - **[HOTFIX] Missing Text Generation**: Fixed a bug where the final text generated by the LLM was hidden. The `sendChunk` method was sending `chunkType: 'chunk'` instead of `chunkType: 'text'`, causing the UI renderer to ignore the payload.
    - **[HOTFIX] JSON Race Condition (Black Screen)**: Fixed a critical "Unexpected end of JSON input" error that occurred when the frontend attempted to fetch the session history immediately after a generation finished, while the backend was still asynchronously writing the file to disk. Switched to `fs.writeFileSync` to ensure atomic completion before signaling the frontend.
    - **[RESILIENCE] Corrupted Session Recovery**: Added robust `try/catch` logic and empty-file guards in `GET /api/chat/session/:id` to prevent the UI from crashing if a session file is corrupted or truncated.
- **Detailed Diagnostics**: Instrumentated the entire chat pipeline with high-signal `logger.info` calls (Turn tracking, Tool execution, Chunk delivery) to facilitate rapid debugging in edge environments.
- **Core Logic Touched**: `core/websocketManager.js`, `interfaces/web/chatApi.js`, `interfaces/web/router.js`, `public/view.chat.js`.
- **Pitfalls & Solutions**:
    - *Message Type Conflict*: The WebSocket server uses `type` for its own routing (e.g. `chat-stream`), while the frontend component used `type` for stream state (e.g. `start`). Solution: Introduced `streamState` in the backend payload and mapped it back to `type` in the `view.chat.js` bridge.
    - *Stateless WebSockets*: Since WebSocket upgrades bypass standard Express middleware, user authentication was missing for AI tool authorization. Added a fallback to 'viewer' role for anonymous WebSocket sessions and a hook to attach `req.user` if available during the handshake.

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

## 2026-04-05 - Granular RBAC Implementation
- **Role Hierarchy**: Replaced the binary [User, Admin] model with a granular hierarchy: **Viewer** (Read-only), **Operator** (Publish/Ack), **Engineer** (Mappers/Rules), and **Admin** (System/Users).
- **Access Control Middleware**: Enhanced `interfaces/web/middlewares/auth.js` with a `requireRole(minRole)` utility that enforces permissions across all REST endpoints.
- **API Protection**: Updated `alertApi`, `mapperApi`, and the Publish router to use specific role-based guards.
- **User Management**: Redesigned the Admin User Panel to allow dynamic role assignment via a new dropdown interface, backed by `UserManager.updateUserRole` in DuckDB.
- **Frontend Visibility**: Implemented reactive tab and button visibility in `app.js` and route-guarding in `router.js` to ensure users only see and access actions permitted by their role.

## 2026-04-05 - RBAC Unit Testing
- **Security Validation**: Added exhaustive unit tests (`tests/authMiddleware.test.js`) covering the `requireRole` middleware to ensure privilege escalation is strictly blocked (e.g. Viewer attempting to reach Admin routes).
- **Database Role Assertions**: Added `tests/userManager.test.js` to guarantee that all new users (Local or Google) fallback to the 'viewer' role by default, and that the Admin API successfully delegates to the `updateUserRole` database schema.

## 2026-04-05 - Fix AI Chat Widget Initialization
- **Race Condition Resolved**: Fixed a bug where `ai-chat-widget.js` would fail to load its subcomponents and event listeners because `app.js` called `init()` before the asynchronous HTML template fetch completed. Moved DOM hydration logic into an `async init(basePath)` method.
