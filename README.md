# MQTT UNS Viewer
![](https://img.shields.io/badge/version-1.2.0-blue.svg) ![](https://img.shields.io/badge/license-MIT-green.svg)

**A lightweight, real-time web application to visualize MQTT topic trees and dynamic SVG graphics based on Unified Namespace (UNS) messages.**

### [**View the Live Demo at mqttunsviewer.com**](https://www.mqttunsviewer.com)

---

This tool provides a simple, broker-agnostic web UI to monitor an MQTT broker. It's built with vanilla JavaScript, Node.js, and Docker, making it lightweight and easy to deploy. It receives all messages via a single WebSocket, ensuring high performance.

![Demo Video](httpsfs://slalaure/mqtt_uns_viewer/main/assets/mqtt_uns_viewer.mp4)

## Table of Contents
1.  [✨ Key Features](#-key-features)
2.  [🚀 Installation](#-installation)
    * [Prerequisites](#prerequisites)
    * [Docker (Recommended)](#docker-recommended)
    * [Local Development](#local-development)
3.  [🔧 Configuration (`.env`)](#-configuration-env)
    * [Main Configuration Options](#main-configuration-options)
4.  [🧭 User Guide](#-user-guide)
    * [Tree View](#tree-view)
    * [SVG View](#svg-view)
    * [History View](#history-view)
    * [Mapper View](#mapper-view)
    * [Chart View](#chart-view)
    * [MCP Server (for LLMs)](#mcp-server-for-llms)
5.  [🛠️ For Developers](#-for-developers)
    * [Project Structure](#project-structure)
    * [Backend Architecture](#backend-architecture)
    * [Frontend Architecture](#frontend-architecture)
    * [Customizing the SVG](#customizing-the-svg)

---

## ✨ Key Features

* **Real-time Topic Tree:** Automatically builds a hierarchical tree of all MQTT topics as messages arrive.
* **Dynamic SVG Dashboard:** Updates text and elements in a custom SVG file (`view.svg`) in real-time based on message payloads.
* **Persistent History:** Uses an embedded **DuckDB** database to store all message history, allowing for search and time-range filtering.
* **Topic & Payload Mapper:** A powerful real-time transformation engine.
    * Create new topics from existing ones.
    * Use `async/await` JavaScript to transform payloads.
    * **Query the database** directly within your mapping logic (e.g., `await db.get(...)`).
    * Includes versioning, metrics, and live-logging.
* **Dynamic Charting:**
    * Build charts (line, bar, pie) by selecting numeric values from any topic payload.
    * Save, load, and manage multiple chart configurations.
    * Export charts to PNG or CSV.
* **Sparkplug B Support:** Natively decodes `spBv1.0` Protobuf payloads for easy viewing.
* **Built-in Data Simulator:** A "Stark Industries" demo simulator to generate complex UNS and Sparkplug data for testing.
* **MCP Server Interface:** An optional JSON-RPC server (`mcp_server.mjs`) that allows external tools (like LLMs) to query the application's status, history, and model.
* **Secure & Lightweight:** Runs in a minimal Node.js container, with security options for HTTP Basic Auth and API IP whitelisting.

---

## 🚀 Installation

### Prerequisites
* **Docker** and **Docker Compose** (for the recommended install method).
* **Node.js v20+** (for local development).
* **Git**

### Docker (Recommended)

This method runs the application in a self-contained Docker container.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/slalaure/mqtt_uns_viewer.git
    cd mqtt_uns_viewer
    ```

2.  **Create the configuration file:**
    Copy the example `.env` file into the `data` directory. This directory is mounted as a volume and persists your database and settings.
    ```bash
    # On Linux/macOS
    cp .env.example data/.env
    
    # On Windows (Command Prompt)
    copy .env.example data\.env
    ```

3.  **Edit the configuration:**
    **This is the most important step.** Open `data/.env` with a text editor and fill in your MQTT broker details (host, port, credentials, etc.).
    ```bash
    nano data/.env
    ```
    *(See the [Configuration](#-configuration-env) section below for details on all options.)*

4.  **Build and run the container:**
    ```bash
    docker compose build
    docker compose up -d
    ```

The application will be running at **`http://localhost:8080`**.

### Local Development

This method is for developers who want to modify the code.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/slalaure/mqtt_uns_viewer.git
    cd mqtt_uns_viewer
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Create and edit the configuration:**
    ```bash
    cp .env.example data/.env
    nano data/.env
    ```
    *(Fill in your broker details as described in the Docker steps.)*

4.  **Run the server:**
    ```bash
    node server.js
    ```
    
The application will be running at **`http://localhost:8080`**. The server will automatically restart if you modify any backend files (thanks to `nodemon`, which is not a dependency but you can use it).

---

## 🔧 Configuration (`.env`)

All configuration is handled in the `data/.env` file.

### Main Configuration Options

| Variable | Default | Description |
| :--- | :--- | :--- |
| **MQTT Broker** | | |
| `MQTT_BROKER_HOST` | `(required)` | The full hostname of your broker (e.Example: `a1b2c3d4.iot.aws-region.amazonaws.com`). |
| `MQTT_PORT` | `(required)` | The port for the connection (e.g., `8883` for MQTTS, `1883` for MQTT). |
| `MQTT_PROTOCOL` | `mqtts` | `mqtts` or `mqtt`. |
| `CLIENT_ID` | `(required)` | A unique client ID for this application. |
| `MQTT_TOPIC` | `(required)` | Topic(s) to subscribe to. Use commas for multiple. Example: `stark_industries/#,spBv1.0/stark_industries/#`. |
| **MQTT Auth: User/Pass** | | |
| `MQTT_USERNAME` | | Username for the broker. Leave empty if using certificates. |
| `MQTT_PASSWORD` | | Password for the broker. Leave empty if using certificates. |
| **MQTT Auth: Certificates** | | |
| `CERT_FILENAME` | | Filename of the client certificate (e.g., `certificate.pem.crt`). |
| `KEY_FILENAME` | | Filename of the client private key (e.g., `private.pem.key`). |
| `CA_FILENAME` | | Filename of the root CA (e.g., `AmazonRootCA1.pem`). |
| **Application** | | |
| `PORT` | `8080` | The port the web server will run on inside the container. |
| `BASE_PATH` | `/` | The base path if serving behind a reverse proxy (e.g., `/myapp`). **Must start with `/`**, **must NOT end with `/`** (unless it's just `/`). |
| `SIMULATOR_ENABLED`| `true` | `true` or `false`. Enables the built-in "Stark Industries" data simulator. |
| `SPARKPLUG_ENABLED`| `false` | `true` or `false`. Enables decoding of `spBv1.0/` Protobuf payloads. |
| **Database (DuckDB)** | | |
| `DUCKDB_MAX_SIZE_MB` | `100` | Max database size in MB. If exceeded, old data is pruned. Leave empty to disable. |
| `DUCKDB_PRUNE_CHUNK_SIZE` | `500` | Number of old messages to delete when the limit is reached. |
| `DB_BATCH_INSERT_ENABLED` | `true` | `true` or `false`. Improves performance by batching DB writes. |
| `DB_BATCH_INTERVAL_MS` | `2000` | How often (in ms) to run the batch insert. |
| **Security** | | |
| `HTTP_USER` | | Username for HTTP Basic Auth to protect the *entire* application. Leave empty to disable. |
| `HTTP_PASSWORD` | | Password for HTTP Basic Auth. |
| `API_ALLOWED_IPS` | `127.0.0.1,::1` | **(Optional)** Comma-separated list of IPs allowed to use the APIs (Mapper, Chart, Config). If empty, filtering is disabled. |
| `VIEW_CONFIG_ENABLED` | `true` | `true` or `false`. Set to `false` to disable the web-based configuration editor for security. |
| **Demo Limits** | | |
| `MAX_SAVED_CHART_CONFIGS` | `10` | Max number of charts users can save. `0` = unlimited. |
| `MAX_SAVED_MAPPER_VERSIONS`| `10` | Max number of mapper versions users can save. `0` = unlimited. |
| **UI Views** | | |
| `VIEW_TREE_ENABLED`| `true` | `true` or `false`. Show or hide the "Tree View" tab. |
| `VIEW_SVG_ENABLED` | `true` | `true` or `false`. Show or hide the "SVG View" tab. |
| `VIEW_HISTORY_ENABLED` | `true` | `true` or `false`. Show or hide the "History" tab. |
| `VIEW_MAPPER_ENABLED` | `true` | `true` or `false`. Show or hide the "Mapper" tab. |
| `VIEW_CHART_ENABLED` | `true` | `true` or `false`. Show or hide the "Chart" tab. |
| `SVG_FILE_PATH` | `view.svg` | Path to the SVG file to load, relative to the `data` directory. |

---

## 🧭 User Guide

### Tree View
This is the main view, showing all topics in a hierarchical structure.
* **Live Update:** Topics appear and update in real-time. Folders and topics will pulse green on new messages.
* **Payload:** Click a topic (file icon) to view its latest payload and recent history in the right-hand panel.
* **Filtering:** Use the filter box to show only topics that match your search.
* **Checkboxes:** Use the checkboxes to filter which topics are processed by the other views (like the History View).

### SVG View
This view loads a custom SVG file from your `data` directory (specified by `SVG_FILE_PATH` in `.env`). It links MQTT data directly to elements in your SVG.

* **How it Works:** The application looks for elements in your SVG with a `data-key` attribute. When a message arrives, it finds elements whose `id` matches the topic (with `/` replaced by `-`) and updates the element with the matching `data-key`.
* **Example:** See [Customizing the SVG](#customizing-the-svg) for details.
* **History Slider:** Check the "History Mode" box to activate the timeline slider. Drag the handle to see the state of the SVG at any point in time.

### History View
This view shows the raw, filterable log of all messages stored in the database.
* **Search:** The filter box searches both topics and payload content.
* **Time Range:** Drag the dual handles on the time slider to narrow the visible time window. This affects the log display *and* the exported data.

### Mapper View
This is the most powerful feature. It allows you to create new, virtual topics by transforming existing ones.

1.  **Select a Source:** Click a topic in the Mapper tree.
2.  **Create a Rule:** The editor on the right will show. If no rule exists, click "Add Target".
3.  **Define a Target Topic:** In the "Target Topic" box, define the new topic you want to create. You can use variables from the payload with Mustache syntax (e.g., `UNS/Site/Area/{{id}}`).
4.  **Write Transform Code:** In the JavaScript editor, you write code to transform the message.
    * You have an `msg` object (with `msg.topic` and `msg.payload`).
    * Return the modified `msg` object to publish it.
    * Return `null` to skip publishing.
    * You can use `await`, as the code runs in an async context.

**Basic Example: Convert Fahrenheit to Celsius**
* **Source Topic:** `stark_industries/lab/sensor/temp_f`
* **Target Topic:** `stark_industries/lab/sensor/temp_c`
* **Code:**
    ```javascript
    // msg.payload is { "value": 77 }
    msg.payload.value = (msg.payload.value - 32) * 5 / 9;
    msg.payload.unit = "C";
    return msg;
    ```

**Advanced Example: Add 5-minute average to payload**
* **Source Topic:** `stark_industries/lab/sensor/pressure`
* **Target Topic:** `stark_industries/lab/sensor/pressure_avg`
* **Code:**
    ```javascript
    // 'db' is available to query the database
    // Note: Use SQL-native time functions for performance.
    try {
        const sql = `
            SELECT AVG(CAST(payload->>'value' AS DOUBLE)) as avg_val 
            FROM mqtt_events 
            WHERE topic = '${msg.topic}' 
            AND timestamp >= (now() - INTERVAL '5 minute')
        `;
        const result = await db.get(sql);
        
        if (result && result.avg_val) {
            msg.payload.average_5_min = result.avg_val;
        }
    } catch (e) {
        console.error("DB query failed: " + e.message);
    }
    
    return msg;
    ```

### Chart View
This view allows you to build persistent charts from any numeric data in your payloads.

1.  **Find Data:** Select a topic in the Chart tree.
2.  **Select Variables:** The "Payload & Variables" panel will show all numeric properties found in the payload (including nested ones and Sparkplug metrics). Check the boxes next to the variables you want to plot.
3.  **Repeat:** Select other topics and add more variables.
4.  **Time Range:** Use the time slider to select the window for your data.
5.  **Refresh:** Click the "Refresh" button (green checkmark) to generate the chart.
6.  **Save:** Click "Save" or "Save As..." to store this chart configuration for later. Use the dropdown to load saved charts.

### MCP Server (for LLMs)
This project includes an optional **MCP (Model Context Protocol) Server** (`mcp_server.mjs`). This server runs as a separate process and exposes a JSON-RPC API that allows external tools (like Large Language Models) to interact with your application.

It provides tools to:
* Search history (`search_data_fulltext`)
* Query the UNS model (`get_model_definition`, `search_uns_concept`)
* Get application status (`get_application_status`)
* Control the simulator (`start_simulator`, `stop_simulator`)
* Modify mapper rules (`update_mapper_rule`)

**How to Run It:**
The MCP server is *not* started by default. To run it alongside the web app, you must use a Docker Compose configuration that starts both services.

1.  Create/edit `docker-compose.yml` with the following content:
    ```yml
    version: '3.8'

    services:
      app:
        image: slalaure/mqtt_uns_viewer:latest # Or build locally
        # build: .
        container_name: mqtt_viewer_app
        restart: always
        ports:
          - "8080:8080" 
        volumes:
          - ./data:/usr/src/app/data
        environment:
          - NODE_ENV=production
          - PORT=8080
          - BASE_PATH=/

      mcp:
        image: slalaure/mqtt_uns_viewer:latest # Or build locally
        # build: .
        container_name: mqtt_viewer_mcp
        restart: always
        ports:
          - "3000:3000"
        volumes:
          - ./data:/usr/src/app/data
        environment:
          - NODE_ENV=production
          - MCP_TRANSPORT=http
          - MCP_PORT=3000
          - MAIN_APP_HOST=app # Tells MCP to find the API at the 'app' service name
          - PORT=8080 
          - BASE_PATH=/
        command: node mcp_server.mjs # Overrides the default command
        depends_on:
          - app
    ```
2.  Run `docker compose up -d`.
3.  The MCP server will be available at `http://localhost:3000/mcp`.

---

## 🛠️ For Developers

### Project Structure
```
📦 mqtt_uns_viewer
 ├── 📂 data/                # Persistent data (DB, config, SVGs). Mounted as volume.
 │   ├── 📄 .env              # User configuration (SECRET)
 │   ├── 📄 charts.json        # Saved chart configurations
 │   ├── 📄 mappings.json      # Saved mapper configurations
 │   ├── 📄 mqtt_events.duckdb # DuckDB database file
 │   └── 📄 view.svg           # User's custom SVG file
 ├── 📂 public/              # Static frontend (HTML, CSS, JS)
 │   ├── 📂 css/              # Stylesheets per view
 │   ├── 📂 libs/             # Minified third-party libs (Chart.js, Ace) to run the app without public internet access
 │   ├── 📄 app.js            # Main frontend logic (WebSocket, state)
 │   ├── 📄 index.html         # Main SPA shell
 │   ├── 📄 tree-manager.js    # Reusable tree view component
 │   ├── 📄 payload-viewer.js  # Reusable payload component
 │   ├── 📄 view.chart.js      # Logic for the Chart view
 │   ├── 📄 view.mapper.js     # Logic for the Mapper view
 │   └── ... (other view logic files)
 ├── 📂 routes/              # Backend API routes (Express)
 │   ├── 📄 chartApi.js        # API for /api/chart
 │   ├── 📄 mapperApi.js       # API for /api/mapper
 │   └── ... (other API files)
 ├── 📄 .env.example        # Template for configuration
 ├── 📄 Dockerfile           # Builds the production Docker image
 ├── 📄 docker-compose.yml   # Simple Docker run config
 ├── 📄 server.js            # Main Node.js backend server
 ├── 📄 mcp_server.mjs       # Optional MCP/JSON-RPC server
 ├── 📄 mqtt_client.js       # Logic for connecting to the MQTT broker
 ├── 📄 mqtt-handler.js      # Core logic for processing each message
 ├── 📄 mapper_engine.js     # Backend logic for the Mapper
 ├── 📄 simulator.js         # Built-in data simulator
 └── 📄 package.json         # Dependencies
```

### Backend Architecture
* **`server.js`:** The main entry point. It starts an Express server, connects to DuckDB, and initializes the MQTT connection.
* **`mqtt_client.js`:** Handles the complex logic of connecting to the MQTT broker (handles MQTTS, ALPN, certificates, etc.).
* **`mqtt-handler.js`:** Receives *every* message from the broker. It decodes Sparkplug (if enabled), broadcasts the message to all WebSocket clients, and queues it for database insertion.
* **`websocket-manager.js`:** Manages all connected browser clients. On new connection, it sends the full topic tree state and recent history.
* **`mapper_engine.js`:** Subscribes to message events. When a message matches a 'source' rule, it executes the user's JS code (with DB access) and publishes the result.
* **`routes/`:** A standard Express API for saving/loading charts and mapper configs.

### Frontend Architecture
The frontend is vanilla JavaScript (ES6 Modules) with no framework.
* **`app.js`:** The main entry point. It establishes the WebSocket connection and holds the central data store (`allHistoryEntries`). It receives all messages and *delegates* updates to the different views and managers.
* **`tree-manager.js`:** A reusable class to manage a `<ul>`-based tree. `app.js` creates three instances (one for Tree, Mapper, and Chart views).
* **`payload-viewer.js`:** A reusable class to manage a payload display panel.
* **`view.*.js` files:** Each file manages the specific logic for its own tab (e.g., `view.chart.js` handles chart generation, saving, loading, etc.).

### Customizing the SVG
The **SVG View** is a powerful way to create a custom dashboard.

1.  Open `data/view.svg` in a text editor (like VS Code) or a vector editor (like Inkscape or Figma).
2.  Find or create a `<text>` element you want to update.
3.  To link it to a simple payload (e.g., `{"value": 123}`), add a `data-key` attribute:
    ```xml
    <text data-key="value">0.0</text>
    ```
4.  To link to a nested JSON payload (e.g., `{"metrics": {"temp": 25}}`), use dot notation:
    ```xml
    <text data-key="metrics.temp">0.0</text>
    ```
5.  To link to a Sparkplug payload, use the metric name (e.g., `metrics: [{ "name": "Level", "value": 80 }]`):
    ```xml
    <text data-key="metrics.Level">0.0</text>
    ```
6.  Finally, give the *parent group* (`<g>`) of your text element an `id` that matches the **full MQTT topic**, replacing `/` with `-`:
    ```xml
    <g id="stark_industries-lab-sensor-temp_c">
        <text data-key="value">0.0</text>
        <text>°C</text>
    </g>
    ```
When a message arrives on `stark_industries/lab/sensor/temp_c`, the application will find the group `#stark_industries-lab-sensor-temp_c`, then find the element `[data-key="value"]` inside it, and update its content.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.