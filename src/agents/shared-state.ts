import {
    AbstractAgent,
    RunAgentInput,
    EventType,
    BaseEvent,
    RunErrorEvent,
    TextMessageChunkEvent,
    ToolCallChunkEvent,
    Tool,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { client } from "../copilot-sdk.js";
import jsonpatch from "fast-json-patch";
import {
    defineTool,
    SessionConfig,
    type CopilotClient,
    type CopilotSession,
} from "@github/copilot-sdk";
import {
    setActiveObserver,
    getActiveObserver,
    getCachedSession,
    getOrCreateSession,
    subscribeToSession,
    mapToolsToSdk,
    resolvePendingToolCall,
    hasPendingToolCall,
} from "./session-manager.js";

type RunAgent = Observable<BaseEvent>;

/**
 * Per-thread local state map.
 * Replaces the old closure-captured `localState` that was only set once on session
 * creation and never refreshed with subsequent request state.
 * Now updated on EVERY request so the LLM hooks always see fresh state.
 */
const threadLocalState = new Map<string, Record<string, unknown>>();

/**
 * Clean up local state for a specific thread.
 * Called when a session is destroyed.
 */
export function clearThreadLocalState(threadId: string): void {
    threadLocalState.delete(threadId);
}

/**
 * Clean up all local state. Called on shutdown or bulk session clear.
 */
export function clearAllThreadLocalState(): void {
    threadLocalState.clear();
}

export class SharedStateAgent extends AbstractAgent {
    client: CopilotClient;

    constructor() {
        super();
        this.client = client;
    }

    run(input: RunAgentInput): RunAgent {
        const { threadId, runId, messages, tools, state, context } = input;
        console.log("Ai shared state", state);
        console.log("Ai shared app context", context);

        if (state && typeof state === "object") {
            threadLocalState.set(threadId, state as Record<string, unknown>);
        } else if (!threadLocalState.has(threadId)) {
            threadLocalState.set(threadId, {});
        }

        const lastUserMsg = messages.findLast(
            (msg) => msg.role === "user" || msg.role === "tool",
        );

        // Check if this request is delivering tool results
        const isToolResultRequest = lastUserMsg?.role === "tool";

        let userPrompt = "";

        if (!isToolResultRequest && lastUserMsg?.role === "user") {
            userPrompt = Array.isArray(lastUserMsg?.content)
                ? lastUserMsg.content
                      .map((c) => (c.type === "text" ? c.text : ""))
                      .join("")
                : lastUserMsg?.content || "";
        }

        const systemMessage = messages.find(
            (msg) => msg.role === "system",
        )?.content;
        console.log("systemMessage", systemMessage);

        return new Observable<BaseEvent>((observer) => {
            // Register this observer, completing the previous one if it exists
            setActiveObserver(threadId, observer, runId);

            observer.next({
                type: EventType.RUN_STARTED,
                threadId,
                runId,
            });

            if (isToolResultRequest) {
                const toolCallId = lastUserMsg.toolCallId;
                const toolResult = lastUserMsg.content;
                const cachedSession = getCachedSession(threadId);

                if (!hasPendingToolCall(toolCallId) || !cachedSession) {
                    // Fallback: no pending call or no session — send as prompt
                    console.warn(
                        `No pending tool call or session for toolCallId: ${toolCallId}. ` +
                            `Falling back to sending result as prompt.`,
                    );
                    const fallbackPrompt = `Tool results with toolCallId ${toolCallId} with result: ${toolResult}`;
                    const executeFallback = async () => {
                        try {
                            const session = await this.getSession({
                                threadId,
                                systemMessage,
                                tools,
                                initialState: state,
                                context,
                            });
                            subscribeToSession(
                                session,
                                threadId,
                                runId,
                                observer,
                            );
                            await session.send({ prompt: fallbackPrompt });
                        } catch (error: unknown) {
                            this.emitError(observer, threadId, runId, error);
                        }
                    };
                    executeFallback();
                    return;
                }

                // Subscribe BEFORE resolving to avoid race with session.idle
                subscribeToSession(cachedSession, threadId, runId, observer);

                // Resolve — unblocks the SDK tool handler
                console.log(
                    `Resolving pending tool call ${toolCallId} with client result`,
                );
                resolvePendingToolCall(toolCallId, toolResult);
                return;
            }

            // Normal flow: user message — create/resume session and send prompt
            const execute = async () => {
                try {
                    const currentSession = await this.getSession({
                        threadId,
                        systemMessage,
                        tools,
                        initialState: state,
                        context,
                    });

                    subscribeToSession(
                        currentSession,
                        threadId,
                        runId,
                        observer,
                    );

                    await currentSession.send({
                        prompt:
                            userPrompt || "user prompt missing. using default",
                    });
                } catch (error: unknown) {
                    this.emitError(observer, threadId, runId, error);
                }
            };

            execute();
        });
    }

    private emitError(
        observer: import("rxjs").Observer<BaseEvent>,
        threadId: string,
        runId: string,
        error: unknown,
    ) {
        console.log("Error during agent run execution:", error);
        const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
        observer.error({
            type: EventType.RUN_ERROR,
            threadId,
            runId,
            message: errorMessage,
        } as RunErrorEvent);
    }

    private async getSession({
        threadId,
        model,
        systemMessage = "You are a helpful assistant",
        tools = [],
        initialState,
        context = [],
    }: {
        threadId: string;
        model?: string;
        systemMessage?: string;
        tools?: Tool[];
        initialState?: RunAgentInput["state"];
        context?: { value: string; description: string }[];
    }) {
        // Map AG-UI tools to Copilot SDK tools with blocking handlers
        const sdkTools = mapToolsToSdk(tools || [], threadId);

        // Define state tool with JSON Patch (RFC 6902) format
        const stateToolDefinition = {
            name: "update_state",
            description:
                "Apply changes to the shared application state using JSON Patch operations (RFC 6902). Only send the specific operations needed - never the full state.",
            parameters: {
                type: "object",
                properties: {
                    operations: {
                        type: "array",
                        description: "JSON Patch operations to apply",
                        items: {
                            type: "object",
                            properties: {
                                op: {
                                    type: "string",
                                    enum: ["add", "remove", "replace"],
                                    description: "The operation type",
                                },
                                path: {
                                    type: "string",
                                    description:
                                        "JSON Pointer path to the target location (e.g., '/recipe/title', '/recipe/ingredients/0/amount')",
                                },
                                value: {
                                    description:
                                        "The value to add or replace (required for 'add' and 'replace' operations)",
                                },
                            },
                            required: ["op", "path"],
                        },
                    },
                },
                required: ["operations"],
            },
        };

        const stateTool = defineTool("update_state", {
            description: stateToolDefinition.description,
            parameters: stateToolDefinition.parameters,
            handler: async (args: { operations?: jsonpatch.Operation[] }) => {
                console.log(
                    "Raw Tool Arguments:",
                    JSON.stringify(args, null, 2),
                );

                // The update_state tool is server-side only (doesn't go to client),
                // so we handle it synchronously and return the result immediately.
                // We still need to get the active observer to emit STATE_DELTA events.
                const active = getActiveObserver(threadId);
                if (!active) {
                    console.warn(
                        `No active observer for thread ${threadId} during update_state`,
                    );
                    return {
                        success: false,
                        error: "No active client connection",
                    };
                }

                const { observer: currentObserver } = active;

                try {
                    const operations = args.operations;
                    console.log("operations", operations);

                    if (
                        !operations ||
                        !Array.isArray(operations) ||
                        operations.length === 0
                    ) {
                        console.warn(
                            "No valid operations provided to update_state",
                        );
                        return {
                            success: false,
                            error: "No valid operations provided. Expected an array of JSON Patch operations.",
                        };
                    }

                    // Validate operations have required fields
                    for (const op of operations) {
                        if (!op.op || !op.path) {
                            console.warn("Invalid operation:", op);
                            return {
                                success: false,
                                error: `Invalid operation: each operation must have 'op' and 'path' fields`,
                            };
                        }
                        if (
                            (op.op === "add" || op.op === "replace") &&
                            op.value === undefined
                        ) {
                            console.warn(
                                "Missing value for add/replace operation:",
                                op,
                            );
                            return {
                                success: false,
                                error: `Operation '${op.op}' requires a 'value' field`,
                            };
                        }
                    }

                    console.log("Applying JSON Patch operations:", operations);

                    // Read the current state from threadLocalState (always fresh)
                    let localState = threadLocalState.get(threadId) || {};

                    // Apply patches directly to local state
                    const result = jsonpatch.applyPatch(
                        localState,
                        operations,
                        true,
                        false,
                    );
                    localState = result.newDocument;

                    // Write back to the thread-local state map
                    threadLocalState.set(threadId, localState);

                    // Forward the operations as the delta to the frontend
                    currentObserver.next({
                        type: EventType.STATE_DELTA,
                        delta: operations,
                        timestamp: Date.now(),
                    });

                    return {
                        success: true,
                        message: `Applied ${operations.length} operation(s)`,
                    };
                } catch (err) {
                    console.error("Error applying state patch:", err);
                    const errorMessage =
                        err instanceof Error ? err.message : "Unknown error";
                    return {
                        success: false,
                        error: `Failed to apply state patch: ${errorMessage}`,
                    };
                }
            },
        });

        const stateDirectives = `
SYSTEM INSTRUCTIONS FOR STATE MANAGEMENT:
- The Front-end is the SOURCE OF TRUTH for the application state.
- After using update_state, respond with a brief summary only.
- The <ApplicationContext> provided is for your reference only.
- When changing state, use the "update_state" tool with JSON Patch operations (RFC 6902).
- Aways keep the state in sync with the frontend after sending updates.
- ONLY send the minimal operations needed. NEVER reconstruct or send the full state.

CORRECT EXAMPLES:
- Change title: update_state({ "operations": [{ "op": "replace", "path": "/recipe/title", "value": "New Title" }] })
- Change ingredient amount: update_state({ "operations": [{ "op": "replace", "path": "/recipe/ingredients/0/amount", "value": "3 cups" }] })
- Add new ingredient: update_state({ "operations": [{ "op": "add", "path": "/recipe/ingredients/-", "value": { "name": "Salt", "amount": "1 tsp" } }] })
- Remove an item: update_state({ "operations": [{ "op": "remove", "path": "/recipe/ingredients/2" }] })
- Multiple changes: update_state({ "operations": [{ "op": "replace", "path": "/recipe/title", "value": "New" }, { "op": "replace", "path": "/recipe/cooking_time", "value": "30 min" }] })

INCORRECT (wastes tokens - DO NOT DO THIS):
- Sending the entire recipe object when only the title changed
- Including unchanged fields in your operations
`;

        const commonConfig = {
            model: model || "gpt-5-mini",
            // model: model || "gpt-4o",
            streaming: true,
            sessionId: threadId,
            reasoningEffort: "low",
            availableTools: [
                ...sdkTools.map((t) => t.name),
                "web_fetch",
                "ask_user",
                "update_state",
            ],
            workingDirectory: "/tmp",
            tools: [...sdkTools, stateTool],
            systemMessage: {
                mode: "replace",
                content: systemMessage + stateDirectives,
            },
            hooks: {
                onPreToolUse: async () => {
                    console.log("tool invocation");
                    return {
                        permissionDecision: "allow",
                        additionalContext:
                            "Tool results will be executed on the frontend and results returned as part of your context conversation in the later messages.",
                        suppressOutput: true,
                    };
                },
                onUserPromptSubmitted: async (input: { prompt: string }) => {
                    // Read from threadLocalState (always up-to-date)
                    const localState = threadLocalState.get(threadId) || {};
                    const appContext = `\n\n<ApplicationContext>:\n${JSON.stringify(localState, null, 2)}\n</ApplicationContext>  \n\n`;

                    const contextSection =
                        context && context.length > 0
                            ? `\n\n<Context>:\n${context.map((c) => `${c.description}: ${c.value}`).join("\n")}\n</Context>\n\n`
                            : "";

                    return {
                        modifiedPrompt: `${input.prompt}${appContext}${contextSection}`,
                        suppressOutput: false,
                    };
                },
            },
        } satisfies Partial<SessionConfig>;

        return getOrCreateSession({ threadId, config: commonConfig });
    }
}
