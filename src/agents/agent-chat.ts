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
import { Observable, Observer } from "rxjs";
import { client } from "../copilot-sdk.js";
import {
	defineTool,
	SessionConfig,
	type CopilotClient,
	type CopilotSession,
} from "@github/copilot-sdk";

type RunAgent = Observable<BaseEvent>;

/**
 * Module-level map of pending tool calls.
 * Key: toolCallId
 * Value: { resolve } to unblock the Copilot SDK tool handler when the client
 *        sends back the tool result in a subsequent HTTP request.
 */
const pendingToolCalls = new Map<
	string,
	{ resolve: (result: string) => void }
>();

/**
 * Module-level session cache keyed by threadId.
 * Keeps the CopilotSession alive across requests so the blocked tool handler
 * Promise can be resolved by a later request.
 */
const sessionCache = new Map<string, CopilotSession>();

/**
 * Module-level mutable reference to the current observer + runId for each thread.
 * Updated on every request so that tool handlers (which are created once per session
 * but may fire across multiple requests) always emit events on the correct,
 * currently-active SSE stream.
 */
const activeObservers = new Map<
	string,
	{ observer: Observer<BaseEvent>; runId: string }
>();

export class CopilotAgent extends AbstractAgent {
	client: CopilotClient;

	constructor() {
		super();
		this.client = client;
	}

	run(input: RunAgentInput): RunAgent {
		const { threadId, runId, messages, tools } = input;

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
			// Register this observer as the active one for this thread.
			// Tool handlers (created once per session) read from this map
			// so they always emit on the current SSE stream.
			activeObservers.set(threadId, { observer, runId });

			observer.next({
				type: EventType.RUN_STARTED,
				threadId,
				runId,
			});

			let cleanup: (() => void) | undefined;

			if (isToolResultRequest) {
				const toolCallId = lastUserMsg.toolCallId;
				const toolResult = lastUserMsg.content;
				const pending = pendingToolCalls.get(toolCallId);
				const cachedSession = sessionCache.get(threadId);

				if (!pending || !cachedSession) {
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
							});
							this.subscribeToSession(
								session,
								observer,
								threadId,
								runId,
								(fn) => {
									cleanup = fn;
								},
							);
							await session.send({ prompt: fallbackPrompt });
						} catch (error: unknown) {
							this.emitError(observer, threadId, runId, error);
						}
					};
					executeFallback();
					return () => {
						cleanup?.();
					};
				}

				// IMPORTANT: Subscribe to session events BEFORE resolving the
				// pending promise to avoid a race where the SDK unblocks,
				// the LLM finishes, and session.idle fires before we listen.
				this.subscribeToSession(
					cachedSession,
					observer,
					threadId,
					runId,
					(fn) => {
						cleanup = fn;
					},
				);

				// Now resolve — unblocks the SDK tool handler
				console.log(
					`Resolving pending tool call ${toolCallId} with client result`,
				);
				pending.resolve(toolResult);
				pendingToolCalls.delete(toolCallId);

				return () => {
					cleanup?.();
				};
			}

			// Normal flow: user message — create/resume session and send prompt
			const execute = async () => {
				try {
					const currentSession = await this.getSession({
						threadId,
						systemMessage,
						tools,
					});

					this.subscribeToSession(
						currentSession,
						observer,
						threadId,
						runId,
						(fn) => {
							cleanup = fn;
						},
					);

					await currentSession.send({
						prompt: userPrompt || "user prompt missing. using default",
					});
				} catch (error: unknown) {
					this.emitError(observer, threadId, runId, error);
				}
			};

			execute();
			return () => {
				cleanup?.();
			};
		});
	}

	/**
	 * Subscribe to assistant.message_delta and session.idle on a session,
	 * forwarding events to the AG-UI observer.
	 */
	private subscribeToSession(
		session: CopilotSession,
		observer: Observer<BaseEvent>,
		threadId: string,
		runId: string,
		setCleanup: (fn: () => void) => void,
	) {
		const unsubDelta = session.on("assistant.message_delta", (event) => {
			observer.next({
				type: EventType.TEXT_MESSAGE_CHUNK,
				messageId: event.data.messageId,
				delta: event.data.deltaContent,
				role: "assistant",
			} satisfies TextMessageChunkEvent);
		});

		const unsubIdle = session.on("session.idle", () => {
			observer.next({
				type: EventType.RUN_FINISHED,
				threadId,
				runId,
			});
			observer.complete();
			// Clean up listeners after completing so they don't fire
			// on subsequent turns of the same session
			unsubDelta();
			unsubIdle();
		});

		setCleanup(() => {
			unsubDelta();
			unsubIdle();
		});
	}

	private emitError(
		observer: Observer<BaseEvent>,
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
	}: {
		threadId: string;
		model?: string;
		systemMessage?: string;
		tools?: Tool[];
	}): Promise<CopilotSession> {
		// Return cached session if it already exists for this thread
		const cached = sessionCache.get(threadId);
		if (cached) {
			return cached;
		}

		// Ensure client connection
		if (client.getState() === "disconnected") await client.start();

		// Map AG-UI tools to Copilot SDK tools with blocking handlers
		const sdkTools = tools.map((tool) =>
			defineTool(tool.name, {
				description: tool.description,
				parameters: tool.parameters,
				handler: async (args, invocation) => {
					// Read the currently-active observer for this thread.
					// This ensures we always emit on the correct SSE stream,
					// even though this handler was created during an earlier request.
					const active = activeObservers.get(threadId);
					if (!active) {
						console.warn(
							`No active observer for thread ${threadId} during tool call ${invocation.toolCallId}`,
						);
						return "Error: no active client connection";
					}

					const { observer: currentObserver, runId: currentRunId } = active;

					// 1. Emit TOOL_CALL_CHUNK to notify client of the tool call
					currentObserver.next({
						type: EventType.TOOL_CALL_CHUNK,
						toolCallId: invocation.toolCallId,
						toolCallName: invocation.toolName,
						delta: JSON.stringify(args),
					} as ToolCallChunkEvent);

					// 2. Signal to the client that this run is finished and
					//    it should execute the tool and send results back
					currentObserver.next({
						type: EventType.RUN_FINISHED,
						threadId,
						runId: currentRunId,
					});
					currentObserver.complete();

					// 3. Block the SDK by returning a Promise that won't resolve
					//    until the client sends tool results in a new request
					console.log(
						`Tool ${invocation.toolName} (${invocation.toolCallId}) dispatched to client. Waiting for result...`,
					);

					const result = await new Promise<string>((resolve) => {
						pendingToolCalls.set(invocation.toolCallId, { resolve });
					});

					console.log(
						`Tool ${invocation.toolName} (${invocation.toolCallId}) received result from client.`,
					);

					// 4. Return the real tool result to the Copilot SDK
					//    so the LLM can continue with actual data
					return result;
				},
			}),
		);

		const commonConfig = {
			model: model || "gpt-5-mini",
			streaming: true,
			sessionId: threadId,
			reasoningEffort: "medium",
			availableTools: [...sdkTools.map((t) => t.name), "web_fetch", "ask_user"],
			workingDirectory: "/tmp",
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
			},
		} satisfies Partial<SessionConfig>;

		const sessions = await this.client.listSessions();
		const existingSession = sessions.find((s) => s.sessionId === threadId);

		let session: CopilotSession;

		if (existingSession) {
			session = await this.client.resumeSession(threadId, {
				...commonConfig,
			});
		} else {
			session = await this.client.createSession({
				...commonConfig,
			});
		}

		// Cache the session at module level so it survives across requests
		sessionCache.set(threadId, session);
		return session;
	}
}

