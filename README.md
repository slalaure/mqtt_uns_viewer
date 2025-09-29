# Real-Time MQTT Unified Namespace (UNS) Web Visualizer

A lightweight, real-time web application to visualize an MQTT topic tree and a SVG  graphic (possibly a 2D floor plan) based on Unified Namespace (UNS) messages. Inspired by tools like MQTT Explorer, this project provides a fully web-based interface using a Node.js backend and a pure JavaScript frontend.
This project uses the standard `mqtt.js` library to connect to any MQTT broker, including AWS IoT Core with certificate-based authentication.

![Application Screenshot1](./assets/screenshot1.png)

---

## ## Features

* **Real-Time Topic Tree:** Automatically builds and displays a hierarchical tree of all received MQTT topics under a wildcard subscription.
* **SVG View:** Dynamically updates a 2D plan (SVG) based on incoming MQTT data. Maps topics to specific zones and updates text fields from the message payload.
* **Built-in UNS Simulator:** Generates a realistic manufacturing data stream based on a predefined scenario. The simulator can be started and stopped via a REST API or the user interface.
* **Dynamic Animations:**
    * Cascading "pulse" animation in the tree view to visualize the data flow for each new message.
    * Highlight animation on the 2D plan to show which zone was just updated.
* **Live Data Display:** View the latest payload for any topic in the tree view and see live data updates on the SVG plan.
* **Real-Time Clock & Timestamps:** The UI includes a live clock and displays the last message timestamp for every branch in the topic tree.
* **Lightweight & Secure:** Built with a minimal tech stack and connects securely to AWS IoT Core using MQTTS over port 443 with client certificates.

---

## ## Tech Stack

* **Backend:** Node.js, Express, `ws` (WebSocket), `mqtt`, `dotenv`
* **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3

---

## ## Architecture

The application uses a Node.js backend to securely connect to an MQTT broker and broadcast messages to the web frontend via WebSockets.

**Data Flow:**
**Any MQTT Broker** `--(MQTTS/MQTT)-->` **Node.js Backend** `--(WebSocket)-->` **Frontend (Browser)**

* **Node.js Backend (`server.js`):** Connects to AWS IoT, subscribes to topics, and broadcasts messages to the frontend via WebSockets.
* **Frontend (`public/` directory):** Connects to the backend via a WebSocket and dynamically renders the two views (Tree and SVG).

---

## ## Setup and Installation

### ### Prerequisites

* **Node.js and npm:** [Download & Install Node.js](https://nodejs.org/) (v16 or higher recommended).
* **AWS IoT Core Account:** A configured "Thing" in AWS IoT Core.
* **Security Credentials:** Your client certificate, private key, and a Root CA certificate from AWS.
* **AWS IoT Endpoint:** Your unique endpoint URL.

### ### Installation Steps

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/slalaure/mqtt_uns_viewer.git
    cd mqtt_uns_viewer
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Add Your Credentials:**
    * Create a `certs` folder in the root of the project.
    * Place your three credential files (e.g., `certificate.pem.crt`, `private.pem.key`, `AmazonRootCA1.pem`) inside this `certs` folder.

4.  **Configure Environment Variables:**
    * In the project root, copy the `.env.example` file to a new file named `.env`.
    * Open `.env` and fill in the values according to your broker's requirements.

    **Example 1: Connecting to AWS IoT Core (with certificates)**
    ```
    # --- General MQTT Broker Configuration ---
    MQTT_HOST=your-endpoint.iot.aws-region.amazonaws.com
    MQTT_PORT=443
    CLIENT_ID=my-aws-client-id
    MQTT_TOPIC="uns/#"

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
    MQTT_HOST=my-broker.domain.com
    MQTT_PORT=8883
    CLIENT_ID=my-standard-client-id-123
    MQTT_TOPIC="uns/#"

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
5. **(If using certificates) Add Your Credential Files:**
    * Create a `certs` folder in the root of the project.
    * Place your certificate files (e.g., `certificate.pem.crt`, etc.) inside this folder.

---

## ## Running the Application

1.  **Start the Server:**
    ```bash
    node server.js
    ```
    You should see console output indicating that the server has started and successfully connected to AWS IoT Core.
    If the simulator is enabled, you will see a confirmation message.

2.  **Open the Application:**
    * Open your web browser and navigate to **http://localhost:8080**.

---

## ## Simulator API

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

## ## Customization: The SVG Plan

The SVG View is designed to be easily customized by editing the SVG file.

1.  **Edit the SVG File:**
    * The plan is located at **`public/view.svg`**. You can edit this file in any vector graphics editor (like Inkscape) or a text editor.

2.  **Link Topics to Zones:**
    * To link an MQTT topic to an area on your plan, create a group `<g>` element.
    * The `id` of the `<g>` element **must** match the MQTT topic, with all slashes (`/`) replaced by dashes (`-`).
    * **Example:** For topic `uns/site/area/machine/data_object`, the SVG group must be `<g id="uns-site-area-machine-data_object">`.

3.  **Link Payload Data to Text Fields:**
    * To display a value from a JSON payload, add a `data-key` attribute to any `<tspan>` or `<text>` element inside the corresponding group.
    * The value of `data-key` **must** match a key in your JSON payload.
    * **Example:** Given a payload `{"status": "Running", "temperature": 45.5}`, this SVG code will be updated automatically:
        ```xml
        <g id="uns-site-area-machine-data_object">
            <text>Status: <tspan data-key="status">N/A</tspan></text>
            <text>Temp: <tspan data-key="temperature">--</tspan> °C</text>
        </g>
        ```

---

## ## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
