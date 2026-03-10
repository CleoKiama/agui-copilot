import {
    AbstractAgent,
    RunAgentInput,
    EventType,
    BaseEvent,
    RunErrorEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { client } from "../copilot-sdk.js";
import { SessionConfig, type CopilotClient } from "@github/copilot-sdk";
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

export class HumanInTheLoopAgent extends AbstractAgent {
    client: CopilotClient;

    constructor() {
        super();
        this.client = client;
    }

    run(input: RunAgentInput): RunAgent {
        const { threadId, runId, messages, tools, context } = input;

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
        context = [],
    }: {
        threadId: string;
        model?: string;
        systemMessage?: string;
        tools?: RunAgentInput["tools"];
        context?: { value: string; description: string }[];
    }) {
        const sdkTools = mapToolsToSdk(tools || [], threadId);

        const config = {
            // model: model || "github-copilot/claude-sonnet-4",
            model: model || "gpt-4-0",
            streaming: true,
            sessionId: threadId,
            availableTools: [
                ...sdkTools.map((t) => t.name),
                "web_fetch",
                "ask_user",
            ],
            workingDirectory: "/tmp/copilot/session-state",
            tools: sdkTools,
            systemMessage: {
                mode: "replace",
                content: systemMessage,
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
                    const contextSection =
                        context && context.length > 0
                            ? `\n\n<Context>:\n${context.map((c) => `${c.description}: ${c.value}`).join("\n")}\n</Context>\n\n`
                            : "";

                    return {
                        modifiedPrompt: `${input.prompt}${contextSection}`,
                        suppressOutput: true,
                    };
                },
            },
        } satisfies Partial<SessionConfig>;

        return getOrCreateSession({ threadId, config });
    }
}
