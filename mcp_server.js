import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";

// --- Configuration ---
const API_BASE_URL = "http://localhost:8080/api";

const server = new McpServer({
  name: "MQTT UNS Viewer Controller",
  version: "1.0.0",
  description: "A server to control and query the MQTT Unified Namespace web visualizer application.",
});

// --- Outils de contrôle du simulateur ---

server.tool(
  "start_simulator",
  "Starts the MQTT data simulator.",
  {},
  async () => {
    try {
      const response = await axios.post(`${API_BASE_URL}/simulator/start`);
      return { content: [{ type: "text", text: "Simulator started successfully. Status: " + JSON.stringify(response.data) }] };
    } catch (error) {
      return { content: [{ type: "text", text: "Error starting simulator: " + error.message }] };
    }
  }
);

server.tool(
  "stop_simulator",
  "Stops the MQTT data simulator.",
  {},
  async () => {
    try {
      const response = await axios.post(`${API_BASE_URL}/simulator/stop`);
      return { content: [{ type: "text", text: "Simulator stopped successfully. Status: " + JSON.stringify(response.data) }] };
    } catch (error) {
      return { content: [{ type: "text", text: "Error stopping simulator: " + error.message }] };
    }
  }
);

server.tool(
  "get_simulator_status",
  "Gets the current status of the MQTT data simulator (running or stopped).",
  {},
  async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/simulator/status`);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: "Error getting simulator status: " + error.message }] };
    }
  }
);


// --- Outils de lecture des données ---

server.tool(
  "get_application_status",
  "Provides a high-level overview of the application's status, including MQTT connection and database stats.",
  {},
  async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/context/status`);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: "Error getting application status: " + error.message }] };
    }
  }
);

server.tool(
  "list_all_topics",
  "Returns a flat list of all unique MQTT topics currently known to the application.",
  {},
  async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/context/topics`);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: "Error listing topics: " + error.message }] };
    }
  }
);

server.tool(
  "get_latest_message",
  "Retrieves the most recent message for a single, specified MQTT topic.",
  {
    topic: z.string().describe("The full MQTT topic name (e.g., 'stark_industries/malibu_facility/erp/workorder')"),
  },
  async ({ topic }) => {
    try {
      const encodedTopic = encodeURIComponent(topic);
      const response = await axios.get(`${API_BASE_URL}/context/topic/${encodedTopic}`);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        return { content: [{ type: "text", text: `Error getting latest message for topic '${topic}': ${errorMessage}` }] };
    }
  }
);

server.tool(
  "get_topic_history",
  "Retrieves recent historical messages for a specified MQTT topic.",
  {
    topic: z.string().describe("The full MQTT topic name to get history for."),
    limit: z.number().optional().describe("The maximum number of messages to return. Defaults to 20."),
  },
  async ({ topic, limit }) => {
    try {
      const encodedTopic = encodeURIComponent(topic);
      const url = limit 
        ? `${API_BASE_URL}/context/history/${encodedTopic}?limit=${limit}`
        : `${API_BASE_URL}/context/history/${encodedTopic}`;
      const response = await axios.get(url);
      return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        return { content: [{ type: "text", text: `Error getting history for topic '${topic}': ${errorMessage}` }] };
    }
  }
);


// --- Lancement du serveur MCP ---
async function main() {
  console.log("🤖 Starting MCP server...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("✅ MCP server connected and listening via StdioTransport.");
}
// Maintient le processus en vie pour qu'il ne se termine pas
setInterval(() => {}, 1 << 30);
main();