# MQTT UNS Viewer

A lightweight, real-time web application to visualize MQTT topic trees and dynamic SVG graphics based on Unified Namespace (UNS) messages. This project is fully containerized with Docker and includes a powerful, event-driven data simulator that generates correlated **Unified Namespace (UNS)** and **Sparkplug B** data streams.

![Application Screenshot1](./assets/mqtt_uns_viewer1.png)
![Application Screenshot2](./assets/mqtt_uns_viewer2.png)
![Application Screenshot3](./assets/mqtt_uns_viewer3.png)

---

## Core Features

-   **Dual-Stream Simulation:** Features an advanced simulator that generates two distinct, correlated data streams:
    -   **OT Layer (Sparkplug B):** Publishes `NBIRTH` and `DDATA` messages (Protobuf) for a fleet of industrial assets (robots, CNCs, power meters, gas tanks).
    -   **IT/UNS Layer (JSON):** Publishes structured JSON events from simulated IT systems (ERP, MES, WMS, CMMS, FMS, Safety) that are temporally correlated with the OT data.
-   **Realistic Scenarios:** The simulator models complex, event-driven scenarios like machine faults (triggering CMMS alerts and abnormal sensor data), fire alarms (triggering FMS events and machine stops), and gas leaks (triggering safety alerts and rapid pressure drops).
-   **Real-Time Topic Tree (Tree View):** Automatically builds and updates a hierarchical tree of all received MQTT topics with live animations. Includes live filtering and expand/collapse controls. Displays payload and recent history upon selection.
-   **Dynamic SVG View:** Updates a custom 2D plan in real-time based on message payloads. Includes a "History Mode" to replay the visual state of the system using a timeline slider.
-   **Advanced Visual Mapper (Mapper Tab):**
    * Dedicated tab featuring a static topic tree of all received topics for configuration.
    * Select specific topics/objects (file nodes) to define real-time transformation rules.
    * Define multiple output targets per source topic.
    * Use **JavaScript functions** (`(msg) => { ... return msg; }`) to modify the message payload before republication.
    * Specify target topics using **Mustache templating** (e.g., `my/uns/{{payload.deviceId}}`) based on the *transformed* payload.
    * Includes **Rule Versioning** allowing users to "Save" changes or "Save as New Version" and switch between configurations.
    * Tracks **Execution Metrics** (count) and **Logs** for each transformation rule target, displayed in the UI.
    * Provides **Visual Feedback** in the mapper tree: highlights mapped source topics (purple) and locally generated target topics (green).
    * Offers **Deletion with Purge**: Option to remove associated historical data from the database when deleting a mapping rule target.
    * Handles **Sparkplug B** correctly: Re-encodes to Protobuf for SPB->SPB mappings, stringifies to JSON (with BigInt handling) for SPB->UNS mappings, and prevents invalid JSON->SPB mappings.
-   **AI Agent Integration:** A dedicated MCP Server exposes application controls and data as structured tools for Large Language Model (LLM) agents.
-   **Web-Based Configuration:** A built-in configuration page allows for easy updates to all server settings (`.env` file).
-   **Persistent Message History:** Stores all MQTT messages in a local **DuckDB** database that persists across restarts.
-   **Advanced History Filtering:** The history view features keyword search (with highlighting) and a dual-handle time-range slider.
-   **Secure Access:** Optional HTTP Basic Authentication to protect the entire application.
-   **Customizable UI**: Includes a user-selectable dark mode for visual comfort, enable or disable specific view tabs (Tree, SVG, History, Mapper).
    *
-   **Containerized:** Runs in a Docker container for simple, one-command deployment.

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

### `.env` File Variables

The following variables can be set in your `data/.env` file:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `MQTT_BROKER_HOST` | The full hostname of your MQTT broker. | `a1b2c3d4e5f6.iot.us-east-1.amazonaws.com` |
| `MQTT_PORT` | The connection port for the broker. | `8883` |
| `MQTT_PROTOCOL` | The protocol to use. | `mqtts` |
| `CLIENT_ID` | A unique client ID for the application. | `mqtt-web-viewer` |
| `MQTT_TOPIC` | Comma-separated list of topics to subscribe to. | `stark_industries/#,spBv1.0/#` |
| `MQTT_USERNAME` | Username for authentication (if not using certs). | `myuser` |
| `MQTT_PASSWORD` | Password for authentication (if not using certs). | `my-secret-password` |
| `CERT_FILENAME` | Certificate file for MTLS (in `data/certs`). | `certificate.pem.crt` |
| `KEY_FILENAME` | Private key file for MTLS (in `data/certs`). | `private.pem.key` |
| `CA_FILENAME` | CA certificate file for MTLS (in `data/certs`). | `AmazonRootCA1.pem` |
| `MQTT_ALPN_PROTOCOL` | ALPN protocol, required for some brokers like AWS IoT on port 443. | `x-amzn-mqtt-ca` |
| `SIMULATOR_ENABLED` | Enable the built-in data simulator. | `true` |
| `PORT` | The port on which the web server will run. | `8080` |
| `SPARKPLUG_ENABLED` | Enables Sparkplug B decoding *and* enables the simulator to generate a parallel Sparkplug B (Protobuf) data stream in addition to the JSON/UNS stream. | `true` |
| `DUCKDB_MAX_SIZE_MB` | Max DB size in MB before old data is pruned. | `100` |
| `DUCKDB_PRUNE_CHUNK_SIZE`| Number of old records to delete when pruning. | `500` |
| `HTTP_USER` | **[Security]** Username for HTTP Basic Auth. Leave empty to disable. | `admin` |
| `HTTP_PASSWORD` | **[Security]** Password for HTTP Basic Auth. Leave empty to disable. | `super-secure-password` |
| `VIEW_TREE_ENABLED` | [cite_start]**[UI]** Enable or disable the 'Tree View' tab. [cite: 17] | `true` |
| `VIEW_SVG_ENABLED` | **[UI]** Enable or disable the 'SVG View' tab. | `true` |
| `VIEW_HISTORY_ENABLED` | **[UI]** Enable or disable the 'History' tab. | `true` |
| `VIEW_MAPPER_ENABLED` | **[UI]** Enable or disable the 'Mapper' tab. | `true` |
| `SVG_FILE_PATH` | **[UI]** The path to the SVG file to load, relative to the 'data' directory. | `view.svg` |

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

---

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.