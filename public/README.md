# Real-Time MQTT Unified Namespace (UNS) Web Visualizer

A lightweight, real-time web application to visualize an MQTT topic tree and a SVG  graphic (possibly a 2D floor plan) based on Unified Namespace (UNS) messages. Inspired by tools like MQTT Explorer, this project provides a fully web-based interface using a Node.js backend and a pure JavaScript frontend.

![Application Screenshot1](./assets/screenshot1.png)
![Application Screenshot2](./assets/screenshot1.png)

---

## ## Features

* **Real-Time Topic Tree:** Automatically builds and displays a hierarchical tree of all received MQTT topics under a wildcard subscription.
* **SVG View:** Dynamically updates a 2D plan (SVG) based on incoming MQTT data. Maps topics to specific zones and updates text fields from the message payload.
* **Dynamic Animations:**
    * Cascading "pulse" animation in the tree view to visualize the data flow for each new message.
    * Highlight animation on the 2D plan to show which zone was just updated.
* **Live Data Display:** View the latest payload for any topic in the tree view and see live data updates on the SVG plan.
* **Real-Time Clock & Timestamps:** The UI includes a live clock and displays the last message timestamp for every branch in the topic tree.
* **Lightweight & Secure:** Built with a minimal tech stack and connects securely to AWS IoT Core using MQTTS over port 443 with client certificates.

---

## ## Tech Stack

* **Backend:** Node.js, Express, `ws` (WebSocket), `aws-iot-device-sdk-v2`, `dotenv`
* **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3

---

## ## Architecture

This application uses a client-server architecture to securely bridge the gap between a web browser and AWS IoT Core.

The data flow is as follows:
**AWS IoT Core** `--(MQTTS:443)-->` **Node.js Backend** `--(WebSocket)-->` **Frontend (Browser)**

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
    git clone [https://github.com/your-username/your-repo-name.git](https://github.com/your-username/your-repo-name.git)
    cd your-repo-name
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Add Your Credentials:**
    * Create a `certs` folder in the root of the project.
    * Place your three credential files (e.g., `certificate.pem.crt`, `private.pem.key`, `AmazonRootCA1.pem`) inside this `certs` folder.

4.  **Configure Environment Variables:**
    * In the project root, find the `.env.example` file.
    * Create a copy of it and name it `.env`.
    * Open the new `.env` file and fill in the values with your specific AWS IoT details:

    ```bash
    # AWS IoT Core Configuration
    AWS_ENDPOINT=your-endpoint.iot.your-region.amazonaws.com
    CLIENT_ID=my-unique-client-id
    MQTT_TOPIC=uns/#

    # Certificate Filenames (must be placed in the /certs folder)
    AWS_CERT_FILENAME=certificate.pem.crt
    AWS_KEY_FILENAME=private.pem.key
    AWS_CA_FILENAME=AmazonRootCA1.pem
    ```

---

## ## Running the Application

1.  **Start the Server:**
    ```bash
    node server.js
    ```
    You should see console output indicating that the server has started and successfully connected to AWS IoT Core.

2.  **Open the Application:**
    * Open your web browser and navigate to **http://localhost:8080**.

---

## ## Customization: The SVG Plan

The SVG View is designed to be easily customized by editing the SVG file.

1.  **Edit the SVG File:**
    * The plan is located at **`public/view.svg`**. You can edit this file in any vector graphics editor (like Inkscape) or a text editor.

2.  **Link Topics to Zones:**
    * To link an MQTT topic to an area on your plan, create a group `<g>` element.
    * The `id` of the `<g>` element **must** match the MQTT topic, with all slashes (`/`) replaced by dashes (`-`).
    * **Example:** For topic `uns/site/area/machine`, the SVG group must be `<g id="uns-site-area-machine">`.

3.  **Link Payload Data to Text Fields:**
    * To display a value from a JSON payload, add a `data-key` attribute to any `<tspan>` or `<text>` element inside the corresponding group.
    * The value of `data-key` **must** match a key in your JSON payload.
    * **Example:** Given a payload `{"status": "Running", "temperature": 45.5}`, this SVG code will be updated automatically:
        ```xml
        <g id="uns-site-area-machine">
            <text>Status: <tspan data-key="status">N/A</tspan></text>
            <text>Temp: <tspan data-key="temperature">--</tspan> °C</text>
        </g>
        ```

---

## ## License

This project is licensed under the MIT License. See the `LICENSE` file for details.