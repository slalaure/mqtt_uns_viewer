/**
 * @license Apache License, Version 2.0 (the "License")
 * @author Sebastien Lalaurette
 *
 * Chat API (LLM Agent Endpoint)
 * [UPDATED] Extracted LLM API calls and Prompt generation to llmEngine.
 * [UPDATED] Implemented exponential backoff for 429 Rate Limit errors.
 * [UPDATED] Extracted Tool Implementations to core/engine/aiTools.js.
 * [NEW] Added WebSocket support for real-time bi-directional chat.
 * [NEW] Added detailed diagnostic logging for troubleshooting.
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

module.exports = (db, logger, config, getConnectorConnection, simulatorManager, wsManager, mapperEngine) => {
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
        db, logger, config, getConnectorConnection, simulatorManager, wsManager, mapperEngine, dataManager, alertManager, aiActionManager, ROOT_PATH, DATA_PATH, SESSIONS_DIR, MODEL_MANIFEST_PATH
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
    const sendChunk = (res, streamState, content, clientId, chunkType = null) => {
        if (clientId && !activeStreams.has(clientId)) return;

        const chunkId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        const finalChunkType = chunkType || streamState;
        const chunkData = { type: streamState, chunkType: finalChunkType, content, id: chunkId };

        if (res && !res.writableEnded && res.writable) {
            const jsonStr = JSON.stringify(chunkData);
            res.write(jsonStr + '\n');
            if (res.flush) res.flush();
        }
        
        if (clientId) {
            const streamInfo = activeStreams.get(clientId);
            logger.debug({ clientId, streamState, chunkType: finalChunkType, chunkId }, "[ChatAPI] Sending chunk to WebSocket");
            wsManager.sendToClient(clientId, {
                type: 'chat-stream',
                sessionId: streamInfo?.sessionId, 
                streamState: streamState, 
                chunkType: finalChunkType, 
                content: content,
                chunkId: chunkId 
            });
        }
    };

    // --- User Scoped Session Directory Helper ---
    const getUserChatsDir = (req) => {
        let basePath;
        if (req && req.user && req.user.id) {
            basePath = path.join(SESSIONS_DIR, req.user.id, 'chats');
        } else {
            basePath = path.join(DATA_PATH, 'sessions', 'global', 'chats');
        }
        if (!fs.existsSync(basePath)) {
            try { fs.mkdirSync(basePath, { recursive: true }); } catch (e) {}
        }
        return basePath;
    };

    /**
     * Core Completion Handler
     * Used by both HTTP POST and WebSocket messages.
     */
    const handleCompletion = async (payload, user, res = null, clientId = null) => {
        const { messages, sessionId, autoApproveSession, approvedToolCallIds, model } = payload;

        logger.info({ clientId, sessionId, messageCount: messages?.length, model }, "[ChatAPI] Handling completion request");

        if (!messages || !Array.isArray(messages)) {
            const err = new Error("Missing or invalid messages.");
            if (res) res.status(400).json({ error: err.message });
            else if (clientId) sendChunk(null, 'error', err.message, clientId);
            return;
        }

        if (!config.LLM_API_KEY) {
            const err = new Error("LLM_API_KEY is not configured.");
            logger.error(err.message);
            if (res) res.status(500).json({ error: err.message });
            else if (clientId) sendChunk(null, 'error', err.message, clientId);
            return;
        }

        // Setup Abort Controller for this request
        const abortController = new AbortController();
        if (clientId) {
            activeStreams.set(clientId, { abortController, res, sessionId });
        } else {
            // Internal temporary ID for HTTP if no clientId
            const tempId = `http_${Date.now()}`;
            activeStreams.set(tempId, { abortController, res, sessionId });
        }

        // --- HTTP Streaming Setup ---
        if (res) {
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
        }

        sendChunk(res, 'start', 'Processing request...', clientId);

        try {
            // --- SECURITY: Build Broker Context ---
            const allProviders = config.DATA_PROVIDERS || [];
            const connectorContext = allProviders.map(b => {
                let pubRules = (b.publish && b.publish.length > 0) ? JSON.stringify(b.publish) : "READ-ONLY";
                if ((b.type === 'file' || b.type === 'dynamic') && (!b.publish || b.publish.length === 0)) pubRules = '["#"]';
                return `- Provider '${b.id}' [${b.type || 'mqtt'}]: Publish Allowed=${pubRules}`;
            }).join('\n');

            // --- PREPARE TOOLS & CONTEXT ---
            const { tools: enabledTools, context: toolsContext } = getEnabledToolsInfo();

            let contextText = "";
            if (payload.context) {
                const { currentTopic, currentSourceId } = payload.context;
                contextText = `\n\nUSER CURRENT VIEW CONTEXT:\n- Current Source: ${currentSourceId || 'None'}\n- Current Topic: ${currentTopic || 'None'}`;
            }

            const systemPromptText = llmEngine.generateChatSystemPrompt(
                toolsManifest.system_prompt_template,
                connectorContext,
                toolsContext
            ) + contextText;

            const systemMessage = { role: "system", content: systemPromptText };
            const safeUserMessages = messages.filter(m => m.role !== 'system');
            
            let conversation = [systemMessage, ...safeUserMessages];
            
            // --- AGENT LOOP ---
            let turnCount = 0;
            let finalMessageSent = false;

            while (turnCount < MAX_AGENT_TURNS && !finalMessageSent) {
                if (abortController.signal.aborted) {
                    throw new Error("Generation cancelled by user.");
                }

                turnCount++;
                logger.info({ clientId, turnCount }, "[ChatAPI] Starting Turn");
                sendChunk(res, 'status', turnCount === 1 ? 'Thinking...' : `Analyzing results (Turn ${turnCount})...`, clientId);

                let message;
                
                // Check if we are resuming an interrupted session (awaiting approval)
                if (turnCount === 1 && conversation.length > 0) {
                    const lastMsg = conversation[conversation.length - 1];
                    if (lastMsg.role === 'assistant' && lastMsg.tool_calls) {
                        message = conversation.pop(); // Pop it so it acts like it just came from the LLM
                        logger.info({ clientId }, "[ChatAPI] Resuming tool execution from history");
                        sendChunk(res, 'status', 'Resuming tool execution...', clientId);
                    }
                }

                // Wrap LLM Call in Exponential Backoff Retry Loop
                let retryCount = 0;
                while (!message) {
                    try {
                        logger.debug({ clientId, model: model || config.LLM_MODEL }, "[ChatAPI] Fetching chat completion from upstream LLM");
                        message = await llmEngine.fetchChatCompletion(
                            conversation,
                            config,
                            enabledTools,
                            abortController.signal,
                            model
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
                    logger.info({ clientId, toolCount: message.tool_calls.length }, "[ChatAPI] LLM requested tool calls");
                    
                    // --- VALIDATION / APPROVAL CHECK ---
                    let requiresApproval = false;
                    let pendingSensitiveCalls = [];
                    if (!autoApproveSession) {
                        for (const toolCall of message.tool_calls) {
                            if (SENSITIVE_TOOLS.includes(toolCall.function.name) && 
                                (!approvedToolCallIds || !approvedToolCallIds.includes(toolCall.id))) {
                                requiresApproval = true;
                                pendingSensitiveCalls.push(toolCall);
                            }
                        }
                    }

                    if (requiresApproval) {
                        logger.info({ clientId, pendingTools: pendingSensitiveCalls.map(t => t.function.name) }, "[ChatAPI] Approval required for sensitive tools");
                        sendChunk(res, 'chunk', message.content || "", clientId, 'text'); 
                        sendChunk(res, 'message', message, clientId); 
                        sendChunk(res, 'approval_required', { toolCalls: pendingSensitiveCalls }, clientId);
                        finalMessageSent = true; 
                        break; 
                    }

                    conversation.push(message); 
                    
                    for (const toolCall of message.tool_calls) {
                        if (abortController.signal.aborted) throw new Error("Generation cancelled by user.");

                        const fnName = toolCall.function.name;
                        logger.info({ clientId, tool: fnName }, "[ChatAPI] Executing tool");
                        sendChunk(res, 'chunk', fnName, clientId, 'tool_start'); 
                        
                        let result;
                        let duration = 0;
                        const startTime = Date.now();
                        
                        try {
                            if (toolImplementations[fnName]) { 
                                let args = {};
                                try { args = JSON.parse(toolCall.function.arguments); } catch(e) {}
                                result = await toolImplementations[fnName](args, user);
                                result = JSON.stringify(result);
                            } else {
                                result = JSON.stringify({ error: "Tool not implemented on server." });
                            }
                        } catch (err) {
                            logger.error({ err }, `[ChatAPI] Tool error ${fnName}`);
                            result = JSON.stringify({ error: err.message });
                        }
                        
                        duration = Date.now() - startTime;
                        logger.debug({ clientId, tool: fnName, duration }, "[ChatAPI] Tool execution completed");
                        sendChunk(res, 'chunk', { name: fnName, result: "Done", duration }, clientId, 'tool_result'); 

                        conversation.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: fnName,
                            content: result
                        });
                    }
                    
                    // We must loop again to let the LLM analyze the tool results, so we do NOT set finalMessageSent = true
                    // We clear `message` so the next loop fetches a new one based on the updated conversation
                    message = null; 
                } 
                // Case 2: The model generated a final text response
                else {
                    logger.info({ clientId }, "[ChatAPI] LLM generated final response");
                    sendChunk(res, 'chunk', message.content, clientId, 'text'); // [FIX] streamState='chunk', chunkType='text'
                    
                    // Auto-save history BEFORE sending 'done' to prevent race condition
                    if (sessionId) {
                        try {
                            const chatsDir = getUserChatsDir({ user });
                            const filePath = path.join(chatsDir, `${sessionId}.json`);
                            conversation.push(message);
                            // Ensure synchronous write so the file is complete when the frontend fetches it
                            fs.writeFileSync(filePath, JSON.stringify(conversation.filter(m => m.role !== 'system'), null, 2));
                        } catch (e) {
                            logger.error({ err: e }, "[ChatAPI] Error saving chat session to disk");
                        }
                    }
                    
                    sendChunk(res, 'done', 'Generation finished', clientId);
                    finalMessageSent = true;
                }
            }

            if (!finalMessageSent) {
                logger.warn({ clientId }, "[ChatAPI] Max agent turns reached");
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
            if (res) res.end();
        }
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
                const fileContent = fs.readFileSync(filePath, 'utf8');
                // Guard against empty files from previous crash
                if (!fileContent.trim()) {
                    return res.json({ id: req.params.id, messages: [] });
                }
                const history = JSON.parse(fileContent);
                res.json({ id: req.params.id, messages: history });
            } catch (e) {
                logger.error({ err: e, path: filePath }, "[ChatAPI] Failed to parse session file, returning empty array.");
                res.json({ id: req.params.id, messages: [] });
            }
        } else {
            res.json({ id: req.params.id, messages: [] });
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

    const getEnabledToolsInfo = () => {
        const enabledTools = [];
        const descriptions = [];
        toolsManifest.tools.forEach(toolDef => {
            const flagKey = toolDef.category; 
            
            // --- STRICT FEATURE GATING ---
            // 1. Check module-specific toggle in AI_TOOLS config
            if (flagKey && config.AI_TOOLS && config.AI_TOOLS[flagKey] === false) return; 
            
            // 2. Check global feature flags (prevent AI from using features disabled on server)
            if (flagKey === 'mapper' && config.VIEW_MAPPER_ENABLED === false) return;
            if (flagKey === 'alerts' && config.VIEW_ALERTS_ENABLED === false) return;
            if (flagKey === 'simulator' && config.IS_SIMULATOR_ENABLED === false) return;
            if (flagKey === 'publish' && config.VIEW_PUBLISH_ENABLED === false) return;

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
        const allProviders = config.DATA_PROVIDERS || [];
        const connectorContext = allProviders.map(b => {
            let pubRules = (b.publish && b.publish.length > 0) ? JSON.stringify(b.publish) : "READ-ONLY";
            if ((b.type === 'file' || b.type === 'dynamic') && (!b.publish || b.publish.length === 0)) pubRules = '["#"]';
            return `- Provider '${b.id}' [${b.type || 'mqtt'}]: Publish Allowed=${pubRules}`;
        }).join('\n');

        const { tools: enabledTools, context: toolsContext } = getEnabledToolsInfo();

        const systemPromptText = llmEngine.generateChatSystemPrompt(
            toolsManifest.system_prompt_template,
            connectorContext,
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
    router.post('/completion', async (req, res) => {
        await handleCompletion(req.body, req.user, res, req.body.clientId);
    });

    // --- WebSocket Handlers ---
    const handleWsMessage = async (data, clientId, ws) => {
        logger.info({ clientId, hasDataUser: !!data.user }, "[ChatAPI] Received chat_message via WebSocket");
        // Fallback user if not authenticated via upgrade, use the one sent by the frontend
        const user = ws.user || data.user || { id: 'anonymous', role: 'viewer', username: 'Anonymous' };
        await handleCompletion(data, user, null, clientId);
    };

    const handleWsStop = (data, clientId) => {
        logger.info({ clientId }, "[ChatAPI] Received chat_stop via WebSocket");
        if (clientId && activeStreams.has(clientId)) {
            const stream = activeStreams.get(clientId);
            if (stream.abortController) {
                stream.abortController.abort();
            }
            activeStreams.delete(clientId);
        }
    };

    return {
        router,
        handleWsMessage,
        handleWsStop
    };
};