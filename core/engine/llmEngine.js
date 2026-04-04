/**
 * @license Apache License, Version 2.0 (the "License")
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * @author Sebastien Lalaurette
 * @copyright (c) 2025 Sebastien Lalaurette
 *
 * LLM Engine
 * Centralizes prompt engineering and LLM API interactions within the Core.
 */
const axios = require('axios');

const MAX_AGENT_TURNS = 30;
const LLM_TIMEOUT_MS = 180000;

class LlmEngine {
    
    /**
     * Generates the system prompt for the Autonomous Industrial Alert Analyst.
     */
    generateAlertAnalysisPrompt(rule, msgContext) {
        return `
            You are an Autonomous Industrial Alert Analyst.
            An alert triggered with the following context:
            - Rule: "${rule.name}" (${rule.severity})
            - Topic: ${msgContext.topic}
            - Trigger Payload: ${JSON.stringify(msgContext.payload)}
            - Correlation ID: ${msgContext.correlationId || 'N/A'}
            
            USER INSTRUCTION: ${rule.workflow_prompt}
            
            Investigate using available tools to find the root cause.
            
            CRITICAL: You MUST end your response with the following structured sections exactly:

            ## TRIGGER
            [One short sentence explaining exactly WHY the alert triggered. Example: "Temp 75C > Threshold 70C" or "Sensor X reported Fault code 99"]

            ## ACTION
            [One short, imperative sentence for the operator. Example: "Inspect cooling fan motor" or "Evacuate area immediately"]

            ## REPORT
            [Your full detailed analysis in Markdown, including findings, history analysis, and reasoning.]
        `;
    }

    /**
     * Generates the base system prompt for the UNS Architect Chat Assistant.
     */
    generateChatSystemPrompt(template, brokerContext, toolsContext) {
        let prompt = template || "You are an expert UNS Architect. CONTEXT:\n{{BROKER_CONTEXT}}\n\nTOOLS:\n{{TOOLS_CONTEXT}}";
        prompt = prompt.replace('{{BROKER_CONTEXT}}', brokerContext);
        prompt = prompt.replace('{{TOOLS_CONTEXT}}', toolsContext);
        return prompt;
    }

    /**
     * Executes an autonomous agent loop without streaming.
     */
    async runAutonomousAgent(systemPromptText, userPromptText, config, enabledTools, toolImplementations, systemUser, logger, correlationId = null) {
        if (!config.LLM_API_KEY) throw new Error("LLM_API_KEY not configured.");
        
        const agentLogger = correlationId && logger ? logger.child({ correlationId }) : logger;

        let apiUrl = config.LLM_API_URL;
        if (!apiUrl.endsWith('/')) apiUrl += '/';
        apiUrl += 'chat/completions';

        let conversation = [
            { role: "system", content: systemPromptText },
            { role: "user", content: userPromptText }
        ];

        const headers = { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LLM_API_KEY}`
        };

        let turnCount = 0;
        let finalResponse = "";

        while (turnCount < MAX_AGENT_TURNS && !finalResponse) {
            turnCount++;
            if (agentLogger) agentLogger.info(`[LlmEngine] Turn ${turnCount}...`);

            const requestPayload = {
                model: config.LLM_MODEL,
                messages: conversation,
                stream: false, 
                temperature: 0.1,
                tools: enabledTools.length > 0 ? enabledTools : undefined,
                tool_choice: enabledTools.length > 0 ? "auto" : undefined
            };

            const response = await axios.post(apiUrl, requestPayload, { headers, timeout: LLM_TIMEOUT_MS });
            const message = response.data.choices[0].message;

            if (message.tool_calls && message.tool_calls.length > 0) {
                conversation.push(message);
                for (const toolCall of message.tool_calls) {
                    const fnName = toolCall.function.name;
                    let result;
                    try {
                        if (toolImplementations[fnName]) {
                            let args = {};
                            try { args = JSON.parse(toolCall.function.arguments); } catch(e) {}
                            if (agentLogger) agentLogger.info(`[LlmEngine] Executing tool: ${fnName}`);
                            result = await toolImplementations[fnName](args, systemUser);
                            result = JSON.stringify(result);
                        } else {
                            result = JSON.stringify({ error: "Tool not implemented." });
                        }
                    } catch (err) {
                        result = JSON.stringify({ error: err.message });
                    }
                    conversation.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: fnName,
                        content: result
                    });
                }
            } else {
                finalResponse = message.content;
            }
        }
        return finalResponse || "No response generated.";
    }

    /**
     * Sends a request to the LLM (Used by streaming endpoints).
     */
    async fetchChatCompletion(conversation, config, enabledTools, abortSignal) {
        let apiUrl = config.LLM_API_URL;
        if (!apiUrl.endsWith('/')) apiUrl += '/';
        apiUrl += 'chat/completions';

        const headers = { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LLM_API_KEY}`
        };

        const requestPayload = {
            model: config.LLM_MODEL,
            messages: conversation,
            stream: false, 
            temperature: 0.1,
            tools: enabledTools.length > 0 ? enabledTools : undefined,
            tool_choice: enabledTools.length > 0 ? "auto" : undefined
        };

        const response = await axios.post(apiUrl, requestPayload, { 
            headers, 
            timeout: LLM_TIMEOUT_MS,
            signal: abortSignal 
        });

        return response.data.choices[0].message;
    }
}

module.exports = new LlmEngine();