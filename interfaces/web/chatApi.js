/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 *
 * Chat API (LLM Agent Endpoint)
 * [UPDATED] Extracted LLM API calls and Prompt generation to llmEngine.
 * [UPDATED] Implemented exponential backoff for 429 Rate Limit errors.
 * [UPDATED] Extracted Tool Implementations to core/engine/aiTools.js.
 * [NEW] Added /tool/execute POST endpoint for external MCP integration.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const alertManager = require('../../core/engine/alertManager');
const llmEngine = require('../../core/engine/llmEngine');
const dataManager = require('../../storage/dataManager');
const AiActionManager = require('../mcp/aiActionManager');
const AiTools = require('../../core/engine/aiTools'); // [NEW] Centralized Tools

// --- Constants ---
const MAX_AGENT_TURNS = 30; // Limit recursion to 30 turns
const MAX_RETRIES_429 = 5;  // Max retries for rate limits

// --- State for Abort Control ---
// Map<clientId, { abortController: AbortController, res: Response }>
const activeStreams = new Map();

// Helper for Exponential Backoff delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = (db, logger, config, getBrokerConnection, simulatorManager, wsManager, mapperEngine) => {
    const router = express.Router();
    const ROOT_PATH = path.join(__dirname, '..', '..');
    const DATA_PATH = path.join(ROOT_PATH, 'data');
    const PUBLIC_PATH = path.join(ROOT_PATH, 'public');
    const MANIFEST_PATH = path.join(PUBLIC_PATH, 'ai_tools_manifest.json');
    const MODEL_MANIFEST_PATH = path.join(DATA_PATH, 'uns_model.json');
    const SESSIONS_DIR = path.join(DATA_PATH, 'sessions');

    // --- Load Tools Manifest ---
    let toolsManifest = { system_prompt_template: "", tools: [] };
    const loadManifest = () => {
        try {
            if (fs.existsSync(MANIFEST_PATH)) {
                const data = fs.readFileSync(MANIFEST_PATH, 'utf8');
                toolsManifest = JSON.parse(data);
                logger.info(`✅ [ChatAPI] Loaded AI Tools Manifest (${toolsManifest.tools.length} tools).`);
            } else {
                logger.error("❌ [ChatAPI] ai_tools_manifest.json not found.");
            }
        } catch (e) {
            logger.error({ err: e }, "❌ [ChatAPI] Error loading AI Tools Manifest.");
        }
    };
    loadManifest(); // Initial load

    const aiActionManager = new AiActionManager(DATA_PATH);

    // --- Initialize Centralized AI Tools ---
    const aiToolsInstance = new AiTools({
        db, logger, config, getBrokerConnection, simulatorManager, wsManager, mapperEngine, dataManager, alertManager, aiActionManager, ROOT_PATH, DATA_PATH, SESSIONS_DIR, MODEL_MANIFEST_PATH
    });
    
    const toolImplementations = aiToolsInstance.getImplementations();

    const SENSITIVE_TOOLS = [
        'update_uns_model', 
        'save_file_to_data_directory', 
        'create_hmi_view', 
        'update_mapper_rule', 
        'prune_topic_history', 
        'create_alert_rule',
        'update_alert_rule',
        'delete_alert_rule'
    ];

    // --- Helper to send chunks via HTTP AND WebSocket ---
    const sendChunk = (res, type, content, clientId) => {
        if (clientId && !activeStreams.has(clientId)) return;

        const chunkId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        const chunkData = { type, content, id: chunkId };

        if (res && !res.writableEnded && res.writable) {
            const jsonStr = JSON.stringify(chunkData);
            res.write(jsonStr + '\n');
            if (res.flush) res.flush();
        }
        
        if (clientId) {
            wsManager.sendToClient(clientId, {
                type: 'chat-stream',
                chunkType: type,
                content: content,
                id: chunkId 
            });
        }
    };

    // --- User Scoped Session Directory Helper ---
    const getUserChatsDir = (req) => {
        let basePath;
        if (req.user && req.user.id) {
            basePath = path.join(SESSIONS_DIR, req.user.id, 'chats');
        } else {
            basePath = path.join(DATA_PATH, 'sessions', 'global', 'chats');
        }
        if (!fs.existsSync(basePath)) {
            try { fs.mkdirSync(basePath, { recursive: true }); } catch (e) {}
        }
        return basePath;
    };

    // --- Session Management Routes ---
    
    router.get('/sessions', (req, res, next) => {
        const chatsDir = getUserChatsDir(req);
        try {
            const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
            const sessions = files.map(file => {
                const filePath = path.join(chatsDir, file);
                const stats = fs.statSync(filePath);
                let title = "New Chat";
                try {
                    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const firstUserMsg = content.find(m => m.role === 'user');
                    if (firstUserMsg) {
                        const txt = Array.isArray(firstUserMsg.content) 
                            ? firstUserMsg.content.find(c => c.type === 'text')?.text 
                            : firstUserMsg.content;
                        if (txt) title = txt.substring(0, 30) + (txt.length > 30 ? "..." : "");
                    }
                } catch(e) {}
                return {
                    id: file.replace('.json', ''),
                    title: title,
                    updatedAt: stats.mtime
                };
            });
            sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            res.json(sessions);
        } catch (e) {
            next(e);
        }
    });

    router.get('/session/:id', (req, res, next) => {
        const chatsDir = getUserChatsDir(req);
        const filePath = path.join(chatsDir, `${req.params.id}.json`);
        if (!filePath.startsWith(chatsDir)) return res.status(403).json({error: "Invalid path"});
        if (fs.existsSync(filePath)) {
            try {
                const history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                res.json(history);
            } catch (e) {
                next(e);
            }
        } else {
            res.json([]);
        }
    });

    router.post('/session/:id', (req, res, next) => {
        const history = req.body;
        if (!Array.isArray(history)) {
            return res.status(400).json({ error: "History must be an array" });
        }
        const chatsDir = getUserChatsDir(req);
        const filePath = path.join(chatsDir, `${req.params.id}.json`);
        if (!filePath.startsWith(chatsDir)) return res.status(403).json({error: "Invalid path"});
        fs.writeFile(filePath, JSON.stringify(history, null, 2), (err) => {
            if (err) return next(err);
            res.json({ success: true });
        });
    });

    router.delete('/session/:id', (req, res, next) => {
        const chatsDir = getUserChatsDir(req);
        const filePath = path.join(chatsDir, `${req.params.id}.json`);
        if (!filePath.startsWith(chatsDir)) return res.status(403).json({error: "Invalid path"});
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            res.json({ success: true });
        } catch (e) {
            next(e);
        }
    });

    router.post('/stop', (req, res) => {
        const { clientId } = req.body;
        if (clientId && activeStreams.has(clientId)) {
            const stream = activeStreams.get(clientId);
            if (stream.abortController) {
                stream.abortController.abort();
                logger.info(`[ChatAPI] Aborted generation for client ${clientId}`);
            }
            activeStreams.delete(clientId);
            res.json({ success: true, message: "Generation stopped." });
        } else {
            res.json({ success: false, message: "No active generation found." });
        }
    });

    router.get('/history', (req, res, next) => {
        req.params.id = 'default';
        const chatsDir = getUserChatsDir(req);
        const filePath = path.join(chatsDir, `default.json`);
        if (fs.existsSync(filePath)) {
            try { res.json(JSON.parse(fs.readFileSync(filePath, 'utf8'))); } 
            catch (e) { next(e); }
        } else { res.json([]); }
    });

    const getEnabledToolsInfo = () => {
        const enabledTools = [];
        const descriptions = [];
        toolsManifest.tools.forEach(toolDef => {
            const flagKey = toolDef.category; 
            if (flagKey && config.AI_TOOLS && config.AI_TOOLS[flagKey] === false) return; 
            enabledTools.push({
                type: "function",
                function: {
                    name: toolDef.name,
                    description: toolDef.description,
                    parameters: toolDef.inputSchema
                }
            });
            descriptions.push(`- **${toolDef.name}**: ${toolDef.description}`);
        });
        return { tools: enabledTools, context: descriptions.join('\n') };
    };


    //  INTERNAL AGENT RUNNER 
    // Executes the agent loop autonomously (no HTTP res needed)
    // Returns Promise<String> with the final response
    const runInternalAgent = async (systemPrompt, userPrompt, correlationId = null) => {
        const allProviders = [...(config.BROKER_CONFIGS || []), ...(config.DATA_PROVIDERS || [])];
        const brokerContext = allProviders.map(b => {
            let pubRules = (b.publish && b.publish.length > 0) ? JSON.stringify(b.publish) : "READ-ONLY";
            if ((b.type === 'file' || b.type === 'dynamic') && (!b.publish || b.publish.length === 0)) pubRules = '["#"]';
            return `- Provider '${b.id}' [${b.type || 'mqtt'}]: Publish Allowed=${pubRules}`;
        }).join('\n');

        const { tools: enabledTools, context: toolsContext } = getEnabledToolsInfo();

        const systemPromptText = llmEngine.generateChatSystemPrompt(
            toolsManifest.system_prompt_template,
            brokerContext,
            toolsContext
        ) + `\n\nSYSTEM INSTRUCTION: ${systemPrompt}`;

        const systemUser = { id: 'system', role: 'admin', username: 'AlertSystem' };

        return await llmEngine.runAutonomousAgent(
            systemPromptText,
            userPrompt,
            config,
            enabledTools,
            toolImplementations,
            systemUser,
            logger,
            correlationId
        );
    };

    // --- Inject the Runner into Alert Manager ---
    if (alertManager && alertManager.registerAgentRunner) {
        alertManager.registerAgentRunner(runInternalAgent);
        logger.info("✅ [ChatAPI] Registered Internal Agent Runner with Alert Manager.");
    }

    // --- [NEW] External Execution Endpoint for MCP ---
    router.post('/tool/execute', async (req, res) => {
        const { toolName, args } = req.body;
        if (!toolName || !toolImplementations[toolName]) {
            return res.status(404).json({ error: `Tool '${toolName}' not found.` });
        }
        try {
            // req.user will be populated by authMiddleware (Basic Auth or Session) ensuring identical Access Control
            const result = await toolImplementations[toolName](args || {}, req.user);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- HTTP POST Endpoint (Standard Chat) ---
    router.post('/completion', async (req, res, next) => {
        const { messages, clientId } = req.body; 

        if (!messages) return res.status(400).json({ error: "Missing messages." });
        if (!config.LLM_API_KEY) {
            const err = new Error("LLM_API_KEY is not configured.");
            err.status = 500;
            return next(err);
        }
        
        // Setup Abort Controller for this request
        const abortController = new AbortController();
        if (clientId) {
            activeStreams.set(clientId, { abortController, res });
        }

        // Set Headers for Streaming Response
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (res.flushHeaders) res.flushHeaders();

        // Padding to force Proxy buffer flush
        const padding = " ".repeat(4096); 
        res.write(`{"type":"ping","content":"padding_ignored"}${padding}\n`);
        if (res.flush) res.flush();

        sendChunk(res, 'status', 'Processing request...', clientId);

        // --- SECURITY: Build Broker Context ---
        const allProviders = [...(config.BROKER_CONFIGS || []), ...(config.DATA_PROVIDERS || [])];
        const brokerContext = allProviders.map(b => {
            let pubRules = (b.publish && b.publish.length > 0) ? JSON.stringify(b.publish) : "READ-ONLY";
            if ((b.type === 'file' || b.type === 'dynamic') && (!b.publish || b.publish.length === 0)) pubRules = '["#"]';
            return `- Provider '${b.id}' [${b.type || 'mqtt'}]: Publish Allowed=${pubRules}`;
        }).join('\n');

        // --- PREPARE TOOLS & CONTEXT ---
        const { tools: enabledTools, context: toolsContext } = getEnabledToolsInfo();

        const systemPromptText = llmEngine.generateChatSystemPrompt(
            toolsManifest.system_prompt_template,
            brokerContext,
            toolsContext
        );

        const systemMessage = { role: "system", content: systemPromptText };
        const safeUserMessages = messages.filter(m => m.role !== 'system');
        
        let conversation = [systemMessage, ...safeUserMessages];
        
        // --- AGENT LOOP ---
        let turnCount = 0;
        let finalMessageSent = false;

        try {
            while (turnCount < MAX_AGENT_TURNS && !finalMessageSent) {
                if (abortController.signal.aborted) {
                    throw new Error("Generation cancelled by user.");
                }

                turnCount++;
                sendChunk(res, 'status', turnCount === 1 ? 'Thinking...' : `Analyzing results (Turn ${turnCount})...`, clientId);

                let message;
                
                // Check if we are resuming an interrupted session (awaiting approval)
                if (turnCount === 1 && conversation.length > 0) {
                    const lastMsg = conversation[conversation.length - 1];
                    if (lastMsg.role === 'assistant' && lastMsg.tool_calls) {
                        message = conversation.pop(); // Pop it so it acts like it just came from the LLM
                        sendChunk(res, 'status', 'Resuming tool execution...', clientId);
                    }
                }

                // Wrap LLM Call in Exponential Backoff Retry Loop
                let retryCount = 0;
                while (!message) {
                    try {
                        message = await llmEngine.fetchChatCompletion(
                            conversation,
                            config,
                            enabledTools,
                            abortController.signal
                        );
                    } catch (err) {
                        if (err.response && err.response.status === 429 && retryCount < MAX_RETRIES_429) {
                            retryCount++;
                            const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 500;
                            logger.warn(`[ChatAPI] 429 Rate Limit hit. Retrying in ${(delay/1000).toFixed(1)}s...`);
                            sendChunk(res, 'status', `Rate limit hit. Retrying in ${(delay/1000).toFixed(1)}s...`, clientId);
                            await sleep(delay);
                        } else {
                            throw err; // Re-throw if not 429 or max retries exceeded
                        }
                    }
                }

                // Case 1: The model wants to call tools
                if (message.tool_calls && message.tool_calls.length > 0) {
                    // --- VALIDATION / APPROVAL CHECK ---
                    let requiresApproval = false;
                    let pendingSensitiveCalls = [];
                    if (!req.body.autoApproveSession) {
                        for (const toolCall of message.tool_calls) {
                            if (SENSITIVE_TOOLS.includes(toolCall.function.name) && 
                                (!req.body.approvedToolCallIds || !req.body.approvedToolCallIds.includes(toolCall.id))) {
                                requiresApproval = true;
                                pendingSensitiveCalls.push(toolCall);
                            }
                        }
                    }

                    if (requiresApproval) {
                        sendChunk(res, 'message', message, clientId); 
                        sendChunk(res, 'approval_required', { toolCalls: pendingSensitiveCalls }, clientId);
                        finalMessageSent = true; 
                        break; 
                    }

                    conversation.push(message); 
                    
                    for (const toolCall of message.tool_calls) {
                        if (abortController.signal.aborted) throw new Error("Generation cancelled by user.");

                        const fnName = toolCall.function.name;
                        sendChunk(res, 'tool_start', { name: fnName }, clientId);
                        
                        let result;
                        let duration = 0;
                        const startTime = Date.now();
                        
                        try {
                            if (toolImplementations[fnName]) { 
                                let args = {};
                                try { args = JSON.parse(toolCall.function.arguments); } catch(e) {}
                                result = await toolImplementations[fnName](args, req.user);
                                result = JSON.stringify(result);
                            } else {
                                result = JSON.stringify({ error: "Tool not implemented on server." });
                            }
                        } catch (err) {
                            logger.error({ err }, `[ChatAPI] Tool error ${fnName}`);
                            result = JSON.stringify({ error: err.message });
                        }
                        
                        duration = Date.now() - startTime;
                        sendChunk(res, 'tool_result', { name: fnName, result: "Done", duration }, clientId);

                        conversation.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: fnName,
                            content: result
                        });
                    }
                } 
                // Case 2: The model generated a final text response
                else {
                    sendChunk(res, 'message', message, clientId);
                    finalMessageSent = true;
                }
            }

            if (!finalMessageSent) {
                sendChunk(res, 'error', "Max agent turns reached. Stopping execution.", clientId);
            }

        } catch (error) {
            if (error.message !== "Generation cancelled by user." && error.code !== 'ERR_CANCELED') {
                logger.error({ 
                    err: error.message, 
                    status: error.response?.status, 
                    data: error.response?.data 
                }, "❌ [ChatAPI] Upstream LLM Error");
            }

            if (error.message === "Generation cancelled by user." || error.code === 'ERR_CANCELED') {
                sendChunk(res, 'status', '⛔ Generation Stopped by User', clientId);
            } else if (error.response) {
                 const apiMsg = error.response.data?.error?.message || "Unknown Upstream Error";
                 sendChunk(res, 'error', `API Error ${error.response.status}: ${apiMsg}`, clientId);
            } else {
                 const msg = error.message;
                 if (msg.includes("timeout")) {
                    sendChunk(res, 'error', "The AI took too long to respond (Timeout).", clientId);
                } else {
                    sendChunk(res, 'error', msg, clientId);
                }
            }
        } finally {
            if (clientId) activeStreams.delete(clientId);
            res.end();
        }
    });

    return router;
};