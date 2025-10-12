# Real-Time MQTT Unified Namespace (UNS) Web Visualizer

A lightweight, real-time web application to visualize an MQTT topic tree and a SVG graphic (possibly a 2D floor plan) based on Unified Namespace (UNS) messages. Inspired by tools like MQTT Explorer, this project provides a fully web-based interface using a Node.js backend and a pure JavaScript frontend.
This project uses the standard `mqtt.js` library to connect to any MQTT broker, including AWS IoT Core with certificate-based authentication.

![Application Screenshot1](./assets/screenshot1.png)

http://github.com/slalaure/mqtt_uns_viewer/blob/main/assets/mqtt_uns_viewer.mp4

---

## Features

* **Real-Time Topic Tree:** Automatically builds and displays a hierarchical tree of all received MQTT topics under a wildcard subscription.
* **SVG View:** Dynamically updates a 2D plan (SVG) based on incoming MQTT data. Maps topics to specific zones and updates text fields from the message payload.
* **Built-in UNS Simulator:** Generates a realistic manufacturing data stream based on a predefined scenario. The simulator can be started and stopped via a REST API or the user interface.
* **Data Persistence:** Automatically saves all received MQTT messages into a local **DuckDB** time-series database for later analysis and querying.
* **Dynamic Animations:**
    * Cascading "pulse" animation in the tree view to visualize the data flow for each new message.
    * Highlight animation on the 2D plan to show which zone was just updated.
* **Live Data Display:** View the latest payload for any topic in the tree view and see live data updates on the SVG plan.
* **Real-Time Clock & Timestamps:** The UI includes a live clock and displays the last message timestamp for every branch in the topic tree.
* **Lightweight & Secure:** Built with a minimal tech stack and connects securely to MQTT brokers using MQTTS with client certificates.

---

## Tech Stack

* **Backend:** Node.js, Express, `ws` (WebSocket), `mqtt`, `dotenv`, **DuckDB**
* **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3

---

## Architecture

The application uses a Node.js backend to securely connect to an MQTT broker and broadcast messages to the web frontend via WebSockets.

**Data Flow:**
**Any MQTT Broker** `--(MQTTS/MQTT)-->` **Node.js Backend** `--(WebSocket)-->` **Frontend (Browser)**

The Node.js backend also persists every message into a local DuckDB file (`mqtt_events.duckdb`).

* **Node.js Backend (`server.js`):** Connects to an MQTT broker, subscribes to topics, broadcasts messages to the frontend via WebSockets, and saves each message to a local DuckDB database.
* **Frontend (`public/` directory):** Connects to the backend via a WebSocket and dynamically renders the two views (Tree and SVG).

---

## Setup and Installation

### Prerequisites

* **Node.js and npm:** [Download & Install Node.js](https://nodejs.org/) (v16 or higher recommended).
* An MQTT Broker (e.g., local Mosquitto, AWS IoT Core, etc.).
* (Optional) Security credentials if your broker requires them (certificates or username/password).

### Installation Steps

1.  **Clone the Repository:**
    ```bash
    git clone [https://github.com/slalaure/mqtt_uns_viewer.git](https://github.com/slalaure/mqtt_uns_viewer.git)
    cd mqtt_uns_viewer
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **(If using certificates) Add Your Credentials:**
    * Create a `certs` folder in the root of the project.
    * Place your credential files (e.g., `certificate.pem.crt`, `private.pem.key`, `ca.pem`) inside this `certs` folder.

4.  **Configure Environment Variables:**
    * In the project root, copy the `.env.example` file to a new file named `.env`.
    * Open `.env` and fill in the values according to your broker's requirements.

    **Example 1: Connecting to AWS IoT Core (with certificates)**
    ```
    # --- General MQTT Broker Configuration ---
    MQTT_BROKER_HOST=your-endpoint.iot.aws-region.amazonaws.com
    MQTT_PORT=8883
    CLIENT_ID=my-aws-client-id
    MQTT_TOPIC="stark_industries/#"

    # --- Authentication ---
    MQTT_USERNAME=
    MQTT_PASSWORD=
    CERT_FILENAME=certificate.pem.crt
    KEY_FILENAME=private.pem.key
    CA_FILENAME=AmazonRootCA1.pem

    # --- Advanced TLS/ALPN ---
    MQTT_ALPN_PROTOCOL=x-amzn-mqtt-ca
    ```

    **Example 2: Connecting to a Standard Broker (with username/password)**
    ```
    # --- General MQTT Broker Configuration ---
    MQTT_BROKER_HOST=my-broker.domain.com
    MQTT_PORT=8883
    CLIENT_ID=my-standard-client-id-123
    MQTT_TOPIC="stark_industries/#"

    # --- Authentication ---
    MQTT_USERNAME=myuser
    MQTT_PASSWORD=mypassword
    CERT_FILENAME=
    KEY_FILENAME=
    CA_FILENAME=

    # --- Advanced TLS/ALPN ---
    MQTT_ALPN_PROTOCOL=
    ```
    
    # Enables the UNS simulator and its API endpoints. Set to "true" or "false".
    SIMULATOR_ENABLED=true
    ```
5. **Note on Data File:** Upon the first run, the server will create a **`mqtt_events.duckdb`** file in the project root to store event data. It is recommended to add this file to your `.gitignore`.

---

## Running the Application

1.  **Start the Server:**
    ```bash
    node server.js
    ```
    You should see console output indicating that the server has started, connected to DuckDB, and connected to your MQTT Broker.

2.  **Open the Application:**
    * Open your web browser and navigate to **http://localhost:8080**.

---

## Data Persistence with DuckDB

All incoming MQTT messages are automatically saved to a local DuckDB database file (`mqtt_events.duckdb`). DuckDB is a fast, in-process analytical database that is perfect for this use case.

The data is stored in a table named `mqtt_events` with the following schema:
* `timestamp` (TIMESTAMPTZ): The time the message was received by the server.
* `topic` (VARCHAR): The full MQTT topic.
* `payload` (JSON): The message payload, stored as a JSON type.

### Querying the Data

You can query the database directly from your command line using the DuckDB CLI.

1.  **Install the CLI (if you don't have it):**
    ```bash
    curl https://install.duckdb.org | sh
    ```

2.  **Connect to the database file:**
    ```bash
    duckdb mqtt_events.duckdb
    ```

3.  **Run SQL queries:**
    ```sql
    -- See the 10 most recent events
    SELECT * FROM mqtt_events ORDER BY timestamp DESC LIMIT 10;

    -- Count events per topic
    SELECT topic, COUNT(*) AS event_count
    FROM mqtt_events
    GROUP BY topic
    ORDER BY event_count DESC;

    -- Find all high-priority maintenance requests
    SELECT timestamp, payload->>'description' AS description
    FROM mqtt_events
    WHERE payload->>'priority' = 'HIGH';
    ```

---

## Simulator API

If the simulator is enabled (`SIMULATOR_ENABLED=true`), the following REST API endpoints are available to control it. The UI uses these endpoints, but they can also be called from tools like `curl` or Postman.

* ### Start Simulator
    `POST /api/simulator/start`
    Starts the simulation loop.

* ### Stop Simulator
    `POST /api/simulator/stop`
    Stops the simulation loop.

* ### Get Status
    `GET /api/simulator/status`
    Returns the current status of the simulator.
    **Response:** `{"status": "running"}` or `{"status": "stopped"}`

---

## Customization: The SVG Plan

The SVG View is designed to be easily customized by editing the SVG file.

1.  **Edit the SVG File:**
    * The plan is located at **`public/view.svg`**. You can edit this file in any vector graphics editor (like Inkscape) or a text editor.

2.  **Link Topics to Zones:**
    * To link an MQTT topic to an area on your plan, create a group `<g>` element.
    * The `id` of the `<g>` element **must** match the MQTT topic, with all slashes (`/`) replaced by dashes (`-`).
    * **Example:** For topic `stark_industries/malibu_facility/assembly_line_01`, the SVG group must be `<g id="stark_industries-malibu_facility-assembly_line_01">`.

3.  **Link Payload Data to Text Fields:**
    * To display a value from a JSON payload, add a `data-key` attribute to any `<tspan>` or `<text>` element inside the corresponding group.
    * The value of `data-key` **must** match a key in your JSON payload.
    * **Example:** Given a payload `{"status": "Running", "temperature": 45.5}`, this SVG code will be updated automatically:
        ```xml
        <g id="stark_industries-malibu_facility-assembly_line_01">
            <text>Status: <tspan data-key="status">N/A</tspan></text>
            <text>Temp: <tspan data-key="temperature">--</tspan> °C</text>
        </g>
        ```

---

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.