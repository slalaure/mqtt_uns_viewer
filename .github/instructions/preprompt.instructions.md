---
description: Preprompt before coding
# applyTo: 'Preprompt before coding' # when provided, instructions will automatically be added to the request context when the pattern matches an attached file
---

<!-- Tip: Use /create-instructions in chat to generate content with agent assistance -->

Provide project context and coding guidelines that AI should follow when generating code, answering questions, or reviewing changes.

## Current State of the Application 

Project Overview

The "korelate" application is a lightweight, real-time, broker-agnostic web visualizer for MQTT topics, primarily designed for Unified Namespace (UNS) architectures. It features a topic tree view and a dynamic 2D SVG plan view that updates based on incoming messages. It also includes an optional, controllable data simulator, historical recording in a database and search filters. Application is now containerized.

Architecture

Backend: A Node.js server that connects to an MQTT broker, or OPC UA server. It serves the static frontend files and acts as a bridge, broadcasting all received MQTT/OPCUA/File messages to web clients via WebSockets. It also provides a REST API to control the simulator.

Frontend: A vanilla JavaScript single-page application that connects to the backend via a WebSocket. It receives data in real-time and updates the DOM to render the topic tree and the SVG plan.

Technology Stack

Backend: Node.js, express, ws, mqtt, , opcua, dotenv

Frontend: Vanilla JavaScript (ES6+), HTML5, CSS3 (no frameworks)





## Guidelines for Your Response

Do not provide partial code or diffs. Do not change code unless necessary, keep all existing functionalities and indentation to ease reviewing your changes with diff tools and avoid loosing capabilities and details. 



Specify File Names: Clearly indicate which file each code block belongs to (e.g., ### File: public/app.js).

Explain Your Changes: Briefly explain the logic behind your modifications.

Maintain the Style: Adhere to the existing architecture and coding style (vanilla JS, no external frontend libraries unless specified).

Important , even if I speak in french with you : All comments, examples, filenames, documentation shall be in english. All commit message shall be in english.

List New Dependencies: If your solution requires any new npm packages, specify the command to install them (e.g., npm install new-package). 

When I ask for a commit message don't forget to update app version accordingly, the README file keeping the same level of details.





## libs 

As the application is intended to run in OT area potentially without internet access, dependencies are embedded into the public/libs directory. As libs are in a dedicated directory, stored locally to allow app work offline, download the required dependencies in this public/libs/ directory.