# MQTT UNS Viewer

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Version: 1.1.0](https://img.shields.io/badge/version-1.1.0-blue.svg)

A lightweight, real-time web application to visualize MQTT topic trees, dynamic SVG graphics, and historical data, designed for Unified Namespace (UNS) and Sparkplug B architectures.

## 🌟 Key Features

* **Real-time Topic Tree:** Automatically builds a collapsible tree of all MQTT topics as they arrive.
* **Live Payload Viewer:** Inspect any topic's payload in real-time or pause to view its recent history.
* **Dynamic SVG View:** Binds MQTT data to any SVG element (`<text>`, `<tspan>`) by adding a `data-key` attribute. Includes a time-scrubbing "History Mode".
* **Persistent History:** Automatically records all messages into an embedded **DuckDB** database for historical analysis.
* **History View:** A dedicated tab to search the entire message history with time-range sliders and full-text search.
* **Topic Mapper Engine:** A powerful UI to create real-time data transformations.
    * Create rules to map/transform data from a source topic (e.g., raw sensor data) to a new destination topic (e.g., a clean UNS topic).
    * Use **JavaScript** for complex transformations.
    * Rule-sets are versioned, allowing you to activate, edit, and save new versions.
* **Charting View:**
    * Dynamically plot data from *any* numeric variable in *any* topic.
    * Supports multi-topic and multi-variable charting on the same timeline.
    * Time-range selection, PNG/CSV export, and chart type selection (line, bar).
* **Sparkplug B Support:** Natively decodes `spBv1.0` Protobuf payloads (NBIRTH, DDATA) into JSON for visualization and mapping.
* **Built-in Simulator:** Includes a data simulator that generates realistic JSON UNS data (ERP, MES, WMS) *and* Sparkplug B data (DDATA).
* **MCP Server (AI Agent):** Includes a **Model-Context Protocol** server (`mcp_server.mjs`) that allows an AI agent (like a GPT) to interact with the application to perform:
    * Semantic search (e.g., "Find all high-priority maintenance requests").
    * Schema inference for unknown topics.
    * Administrative tasks (e.g., "Prune all data from the R&D lab").
* **Admin & Security:**
    * Web-based configuration editor for the `.env` file.
    * Optional HTTP Basic Authentication.

---

## Architecture

The application runs as a single Docker container that internally manages two Node.js processes:

1.  **Web Server (`server.js`):** The core application.
    -   Connects to the MQTT broker.
    -   Serves the frontend web application and the configuration API.
    -   Broadcasts MQTT messages to the UI via WebSockets.
    -   Manages the DuckDB database.
    -   Runs the advanced, dual-loop data simulator.
    -   Launches and manages the MCP Server as a child process.

2.  **MCP Server (`mcp_server.mjs`):** The AI Agent interface.
    -   Defines structured tools for an LLM to interact with the application.
    -   Communicates with the Web Server via its internal REST API.

**Data Persistence** is achieved by mounting a local `data` directory as a Docker volume. This ensures that your configuration, SVG plan, and database are saved on your host machine.

---

## Advanced Data Simulator

The built-in simulator is a sophisticated, event-driven engine designed for realistic UNS and IIoT demonstrations.

### Key Simulation Concepts

-   **Dual-Loop Engine:**
    -   **Fast Loop (Sensor Telemetry):** Every 5 seconds, all OT assets (robots, CNCs, power meters, gas tanks) publish their telemetry.
    -   **Slow Loop (Narrative Events):** Every 40 seconds, a new "story" event occurs, simulating the IT/business layer (ERP, MES, WMS, etc.).

-   **Data Correlation:** The two loops are linked via a shared state. A narrative event (e.g., MES `status: 'running'`) will cause the sensor loop to start publishing "running" data (high temperature, high power draw). An injected fault (e.g., `status: 'error'`) will instantly cause the sensor loop to publish abnormal data (high vibration), which is then followed by a correlated CMMS maintenance request.

-   **Sparkplug B + UNS Twinning:** When `SPARKPLUG_ENABLED` is true, the simulator models a complete edge-to-enterprise data flow:
    1.  **OT (Sparkplug B):** It publishes `spBv1.0/.../DDATA` (Protobuf) messages as if from the machine itself. `NBIRTH` messages are sent on startup, correctly using `seq=0`.
    2.  **UNS (JSON):** It *also* publishes the same data as a structured JSON message (e.g., `stark_industries/.../vibration`) to simulate an IIoT Gateway "twinning" the data into the Unified Namespace.

-   **Simulated Systems & Events:**
    -   **ERP:** `workorder` (Start/Complete)
    -   **MES:** `operation` (Start/Stop/Pause)
    -   **WMS:** `stock_movement` (Pick, Putaway, Receipt)
    -   **CMMS:** `maintenance_request` (Triggered by faults)
    -   **FMS:** `fire_alarm` (Alarm/Clear)
    -   **Safety:** `atmosphere_alert` (Anoxia/Gas leak)
    -   **OT/Assets (Sparkplug):** Robots, CNCs, Power Meters, Gas Tanks (Argon, Nitrogen, Oxygen)

---

## Getting Started

### Prerequisites

-   [Docker](https://www.docker.com/get-started) must be installed.
-   [Docker Compose](https://docs.docker.com/compose/install/) is required for Method 1.
-   [Git](https://git-scm.com/) for cloning the repository.

### First-Time Setup (Required for both methods)

1.  **Clone the Repository:**
    ```bash
    git clone [https://github.com/slalaure/mqtt_uns_viewer.git](https://github.com/slalaure/mqtt_uns_viewer.git)
    cd mqtt_uns_viewer
    ```

2.  **Prepare the Data Directory:**
    The application reads all user-specific files from a `data` directory.
    -   **Configuration:** Copy the example config file into the `data` directory: `cp .env.example data/.env`.
    -   **SVG Plan:** Place your custom `view.svg` file inside the `data` directory. An example is already there.
    -   **(Optional) Certificates:** If using MTLS, place your `certs` folder inside the `data` directory.

3.  **Edit Your Configuration:**
    Open `data/.env` with a text editor and fill in your MQTT broker details. See the **Configuration** section below for all available options. **To see the full simulation, set `SIMULATOR_ENABLED=true` and `SPARKPLUG_ENABLED=true`.**

### Method 1: Using Docker Compose (Recommended)

This is the simplest way to run the application.

1.  **Build and Run:**
    From the project's root directory, run the following command. This will build the image and start the container in the background.
    ```bash
    docker-compose up --build -d
    ```

2.  **Access the Application:**
    The application will now be available at http://localhost:8080.

3.  **To Stop the Application:**
    ```bash
    docker-compose down
    ```

### Method 2: Using Docker CLI Commands

This method gives you more granular control without using Docker Compose.

1.  **Build the Docker Image:**
    From the project's root directory, build the image and give it a name (e.g., `mqtt-uns-viewer`).
    ```bash
    docker build -t mqtt-uns-viewer .
    ```

2.  **Run the Docker Container:**
    This command starts a container from the image you just built. It maps the port, mounts the `data` directory for persistence, names the container, and sets it to restart automatically.
    ```bash
    docker run \
      -d \
      -p 8080:8080 \
      -v "$(pwd)/data":/usr/src/app/data \
      --name mqtt-viewer-container \
      --restart always \
      mqtt-uns-viewer
    ```
    > **Note for Windows Users:** Use `"%cd%/data"` instead of `"$(pwd)/data"` for the volume mount.

3.  **Access the Application:**
    The application will now be available at http://localhost:8080.

4.  **Managing the Container:**
    -   **To stop the container:**
        ```bash
        docker stop mqtt-viewer-container
        ```
    -   **To start it again:**
        ```bash
        docker start mqtt-viewer-container
        ```
    -   **To view logs:**
        ```bash
        docker logs -f mqtt-viewer-container
        ```
    -   **To stop and remove the container completely:**
        ```bash
        docker stop mqtt-viewer-container
        docker rm mqtt-viewer-container
        ```

---

## Configuration & Customization

### Web Configuration

Navigate to **http://localhost:8080/config.html** to access the web-based configuration editor.

-   All settings from your `data/.env` file are displayed here.
-   After saving, you will be prompted to restart the server. If you confirm, the Docker container will gracefully restart to apply the new settings.

## 🔧 Configuration (`data/.env`)

The application is configured using the `.env` file located in the `data/` directory.

| Variable | Description |
| :--- | :--- |
| **Broker Settings** | |
| `MQTT_BROKER_HOST` | Full URL of your broker (e.g., `mqtts://your-broker.com`). |
| `MQTT_PORT` | The port for your broker (e.g., `8883`). |
| `MQTT_TOPIC` | The topic(s) to subscribe to. Use commas for multiple (e.g., `stark_industries/#,spBv1.0/#`). |
| `MQTT_USERNAME` | Username for the broker. |
| `MQTT_PASSWORD` | Password for the broker. |
| **Certificates (for MTLS)** | |
| `CERT_FILENAME` | Filename of your certificate (`.crt`) located in `data/certs/`. |
| `KEY_FILENAME` | Filename of your private key (`.key`) located in `data/certs/`. |
| `CA_FILENAME` | Filename of your CA cert (`.pem`) located in `data/certs/`. |
| **Application Settings** | |
| `PORT` | The port for the web server to run on (e.g., `8080`). |
| `SPARKPLUG_ENABLED`| Set to `true` to enable Sparkplug B decoding. |
| `SIMULATOR_ENABLED`| Set to `true` to enable the built-in data simulator and its API endpoints. |
| `HTTP_USER` | Set a username to enable HTTP Basic Auth for the website. |
| `HTTP_PASSWORD` | Set a password to enable HTTP Basic Auth. |
| `BASE_PATH` | The base path for reverse proxy (e.g., `/myapp`). Defaults to `/`. |
| **Database Settings** | |
| `DUCKDB_MAX_SIZE_MB`| Max size of the DB file before old data is pruned (e.g., `100`). |
| `DB_BATCH_INSERT_ENABLED` | Set to `true` for high-performance batch inserts into the database. |
| **View Settings** | |
| `VIEW_TREE_ENABLED` | `true`/`false` to show or hide the Tree View tab. |
| `VIEW_SVG_ENABLED` | `true`/`false` to show or hide the SVG View tab. |
| `VIEW_HISTORY_ENABLED`| `true`/`false` to show or hide the History View tab. |
| `VIEW_MAPPER_ENABLED`| `true`/`false` to show or hide the Mapper View tab. |
| `VIEW_CHART_ENABLED` | `true`/`false` to show or hide the Chart View tab. |
| `SVG_FILE_PATH` | Path to your SVG file, relative to the `data` directory (e.g., `my_plant_layout.svg`). |

### Customizing the SVG Plan

1.  **Edit the SVG File:** Modify the `data/view.svg` file in a vector editor (like Inkscape) or a text editor.
2.  **Link Topics to Zones:** To link an MQTT topic to an area, create a group `<g>` element. The `id` of the group **must** match the MQTT topic, with slashes (`/`) replaced by dashes (`-`).
    -   **Topic:** `stark_industries/malibu_facility/lab/zone-a`
    -   **SVG Group ID:** `<g id="stark_industries-malibu_facility-lab-zone-a">`
3.  **Link Payload to Text:** To display a value from a JSON payload, add a `data-key` attribute to any `<tspan>` or `<text>` element inside the corresponding group.
    -   **Payload:** `{"value": 21.5, "unit": "°C"}`
    -   **SVG Code:**
        ```xml
        <g id="stark_industries-malibu_facility-lab-zone-a">
            <text>Temp: <tspan data-key="value">--</tspan> °C</text>
        </g>
        ```
### Advanced: Adding Client-Side Alarm Logic

You can make your SVG view smarter by adding client-side alarm logic. This allows you to show or hide elements (like an alarm warning) based on a value comparison, rather than just displaying the value.

1.  **Create a Parent Group:** In your SVG, create a parent group (`<g>`) for the entire alarm line. Give it a class like `alarm-line` and hide it by default.
    ```xml
    <g class="alarm-line" style="display: none;">
        </g>
    ```

2.  **Add Alarm Attributes:** Find the `<tspan>` element that displays your value (the one with the `data-key`). Add two new attributes to it:
    * `data-alarm-type`: The comparison type. Can be `H` (High), `HH` (High-High), `L` (Low), or `LL` (Low-Low).
    * `data-alarm-value`: The numerical threshold for the alarm.

3.  **Example:**
    This example will only show the text "P. Aspiration Biogaz (HH: 450)" if the value from `variables.AI_PT0101` is **greater than 450**.

    ```xml
    <g class="alarm-line" style="display: none;">
        <text x="860" y="420" class="alarm-label">P. Aspiration Biogaz (HH: 450):</text>
        <text x="1080" y="420" class="alarm-label">
            <tspan 
                class="alarm-value" 
                data-key="variables.AI_PT0101" 
                data-alarm-type="HH" 
                data-alarm-value="450"
            >0.00</tspan>
            <tspan class="unit-label"> mbar</tspan>
        </text>
    </g>
    ```

4.  **Add a Placeholder (Optional):**
    If you have a list of alarms, you can add a placeholder text that will be shown when no alarms are active. Simply add an element with the `id="no-alarms-text"`.

    ```xml
    <text id="no-alarms-text" x="1010" y="490" text-anchor="middle" class="instrument-label">
        (Aucune alarme active)
    </text>
    ```

### 📊 Chart View

The Chart View allows you to plot time-series data from one or more MQTT topics on a single graph.

* **Multi-Topic Plotting:** Select numeric variables (including numbers sent as strings) from different topics. The chart will display them all at once.
* **Dynamic Multi-Axis:** To compare data of different scales (e.g., temperature and pressure), the chart automatically generates a new, independent Y-axis for each variable.
* **Smart Axis Display:** Axes are automatically positioned on the left and right sides to prevent clutter, and their color matches the data line for easy identification.
* **Chart Types:** Supports **Line**, **Bar**, and **Pie** charts.
* **Time Slider:** Uses the same time-range slider as the History view to select your desired data window.
* **Export:** Export the chart view as a **PNG** or the raw dataset as a **CSV**.
---

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.