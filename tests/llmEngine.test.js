/**
 * @license Apache License, Version 2.0
 * @author Sebastien Lalaurette
 * * Unit tests for the LLM Engine.
 * Verifies prompt generation, agent loop execution, and tool integration.
 */

const axios = require('axios');
const llmEngine = require('../core/engine/llmEngine');

// Mock axios to simulate LLM API responses
jest.mock('axios');

// Helper to create a simple mock logger
const createMockLogger = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
});

describe('LLM Engine', () => {
    let mockLogger;
    let mockConfig;

    beforeEach(() => {
        jest.clearAllMocks();
        mockLogger = createMockLogger();
        mockConfig = {
            LLM_API_KEY: 'fake-api-key',
            LLM_API_URL: 'https://api.fake-llm.com/v1',
            LLM_MODEL: 'fake-model-flash'
        };
    });

    describe('Prompt Generation', () => {
        test('generateAlertAnalysisPrompt should correctly inject rule and message context', () => {
            const rule = {
                name: "High Temperature Warning",
                severity: "critical",
                workflow_prompt: "Check the cooling fan status."
            };
            const msgContext = {
                topic: "factory/line1/oven/temp",
                payload: { value: 120 },
                correlationId: "trace-999"
            };

            const prompt = llmEngine.generateAlertAnalysisPrompt(rule, msgContext);

            expect(prompt).toContain('High Temperature Warning');
            expect(prompt).toContain('critical');
            expect(prompt).toContain('factory/line1/oven/temp');
            expect(prompt).toContain('{"value":120}');
            expect(prompt).toContain('trace-999');
            expect(prompt).toContain('Check the cooling fan status.');
            expect(prompt).toContain('## TRIGGER'); // Ensure structured output tags are present
        });

        test('generateChatSystemPrompt should correctly replace context placeholders', () => {
            const template = "You are an AI. CONTEXT:\n{{CONNECTOR_CONTEXT}}\nTOOLS:\n{{TOOLS_CONTEXT}}";
            const connectorContext = "- Broker 'local': READ-ONLY";
            const toolsContext = "- **test_tool**: Does a test";

            const prompt = llmEngine.generateChatSystemPrompt(template, connectorContext, toolsContext);

            expect(prompt).toContain("- Broker 'local': READ-ONLY");
            expect(prompt).toContain("- **test_tool**: Does a test");
            expect(prompt).not.toContain('{{CONNECTOR_CONTEXT}}');
        });
    });

    describe('Autonomous Agent Execution', () => {
        test('runAutonomousAgent should execute a tool and loop back for final response', async () => {
            // Mock a tool implementation
            const mockTool = jest.fn().mockResolvedValue({ status: "success", data: "Data from tool" });
            const toolImplementations = { my_custom_tool: mockTool };
            
            const enabledTools = [{
                type: "function",
                function: { name: "my_custom_tool", description: "A test tool" }
            }];
            
            const systemUser = { id: 'system', username: 'TestUser' };

            // Setup Axios Mock to simulate the agent loop
            // Turn 1: The LLM decides to call the tool
            axios.post.mockResolvedValueOnce({
                data: {
                    choices: [{
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [{
                                id: 'call_abc123',
                                type: 'function',
                                function: {
                                    name: 'my_custom_tool',
                                    arguments: '{"param1": "test"}'
                                }
                            }]
                        }
                    }]
                }
            });

            // Turn 2: The LLM receives the tool output and provides a final text response
            axios.post.mockResolvedValueOnce({
                data: {
                    choices: [{
                        message: {
                            role: 'assistant',
                            content: 'The tool executed successfully and returned the data.'
                        }
                    }]
                }
            });

            const finalResponse = await llmEngine.runAutonomousAgent(
                "System Prompt",
                "User Prompt",
                mockConfig,
                enabledTools,
                toolImplementations,
                systemUser,
                mockLogger
            );

            // Assertions
            expect(axios.post).toHaveBeenCalledTimes(2);
            expect(mockTool).toHaveBeenCalledTimes(1);
            expect(mockTool).toHaveBeenCalledWith({ param1: "test" }, systemUser);
            expect(finalResponse).toBe('The tool executed successfully and returned the data.');
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Turn 1'));
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Turn 2'));
        });

        test('runAutonomousAgent should throw if LLM_API_KEY is missing', async () => {
            mockConfig.LLM_API_KEY = null;
            
            await expect(llmEngine.runAutonomousAgent(
                "Sys", "User", mockConfig, [], {}, {}, mockLogger
            )).rejects.toThrow("LLM_API_KEY not configured.");
        });

        test('runAutonomousAgent should handle tool execution errors gracefully', async () => {
            // Tool throws an error
            const mockTool = jest.fn().mockRejectedValue(new Error("Simulated tool crash"));
            const toolImplementations = { failing_tool: mockTool };
            
            const enabledTools = [{ type: "function", function: { name: "failing_tool" } }];

            axios.post.mockResolvedValueOnce({
                data: {
                    choices: [{
                        message: {
                            role: 'assistant',
                            tool_calls: [{
                                id: 'call_err',
                                function: { name: 'failing_tool', arguments: '{}' }
                            }]
                        }
                    }]
                }
            }).mockResolvedValueOnce({
                data: {
                    choices: [{
                        message: { role: 'assistant', content: 'I encountered an error.' }
                    }]
                }
            });

            const finalResponse = await llmEngine.runAutonomousAgent(
                "Sys", "User", mockConfig, enabledTools, toolImplementations, {}, mockLogger
            );

            expect(mockTool).toHaveBeenCalledTimes(1);
            expect(finalResponse).toBe('I encountered an error.');
            
            // Verify the error was passed back in the conversation history
            const secondApiCallPayload = axios.post.mock.calls[1][1];
            const lastMessageSent = secondApiCallPayload.messages[secondApiCallPayload.messages.length - 1];
            
            expect(lastMessageSent.role).toBe('tool');
            expect(lastMessageSent.name).toBe('failing_tool');
            expect(lastMessageSent.content).toContain('Simulated tool crash');
        });
    });

    describe('Streamed Fetch Execution', () => {
        test('fetchChatCompletion should return the message object directly', async () => {
            const expectedMessage = {
                role: 'assistant',
                content: 'Direct response from LLM'
            };

            axios.post.mockResolvedValueOnce({
                data: {
                    choices: [{ message: expectedMessage }]
                }
            });

            const conversation = [{ role: 'user', content: 'Hello' }];
            const abortController = new AbortController();

            const result = await llmEngine.fetchChatCompletion(
                conversation,
                mockConfig,
                [],
                abortController.signal
            );

            expect(axios.post).toHaveBeenCalledTimes(1);
            
            // Check that the URL formatting logic works
            const callUrl = axios.post.mock.calls[0][0];
            expect(callUrl).toBe('https://api.fake-llm.com/v1/chat/completions');
            
            expect(result).toEqual(expectedMessage);
        });
    });
});