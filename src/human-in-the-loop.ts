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
import { client } from "./copilot-sdk.js";
import { compare } from "fast-json-patch";
import {
	defineTool,
	type CopilotClient,
	type CopilotSession,
} from "@github/copilot-sdk";

type RunAgent = Observable<BaseEvent>;

export class HumanInTheLoopAgent extends AbstractAgent {
	client: CopilotClient;
	private session: CopilotSession | null = null;

	constructor() {
		super();
		this.client = client;
	}

	run(input: RunAgentInput): RunAgent {
		const { threadId, runId, messages, tools, state } = input;

		// Handle generic content or multimodal content array
		const lastUserMsg = messages.findLast(
			(msg) => msg.role === "user" || msg.role === "tool",
		);
		let userPrompt = "";

		if (lastUserMsg?.role === "tool") {
			// append latest tool result as context
			userPrompt = `Tool results with toolCallId  ${lastUserMsg.toolCallId} with result : ${lastUserMsg.content}`;
		} else if (lastUserMsg?.role === "user") {
			//todo: handle other message.content types like images
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
			//required
			observer.next({
				type: EventType.RUN_STARTED,
				threadId,
				runId,
			});

			let currentSession: CopilotSession | null = null;
			let cleanup: () => void;

			const onIdle = () => {
				// required
				observer.next({
					type: EventType.RUN_FINISHED,
					threadId,
					runId,
				});
				observer.complete();
			};

			const execute = async () => {
				try {
					// Pass tools to getSession
					currentSession = await this.getSession({
						threadId,
						systemMessage,
						tools,
						observer,
						initialState: state,
					});

					const unsubDeltaEvent = currentSession.on(
						"assistant.message_delta",
						(event) => {
							const message = {
								type: EventType.TEXT_MESSAGE_CHUNK,
								messageId: event.data.messageId,
								delta: event.data.deltaContent,
								role: "assistant",
							} satisfies TextMessageChunkEvent;
							observer.next(message);
						},
					);

					const unsubIdleListener = currentSession.on("session.idle", onIdle);

					cleanup = () => {
						unsubDeltaEvent();
						unsubIdleListener();
					};

					await currentSession.send({
						prompt: userPrompt || "user prompt missing.using default",
					});
				} catch (error: unknown) {
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
			};

			execute();
			return () => {
				cleanup?.();
				this.destroySession().catch(console.error);
			};
		});
	}

	private async getSession({
		threadId,
		model,
		systemMessage = "You are a helpful assistant",
		tools = [],
		observer,
		initialState,
	}: {
		threadId: string;
		model?: string;
		systemMessage?: string;
		tools?: Tool[];
		observer: Observer<BaseEvent>;
		initialState?: RunAgentInput["state"];
	}): Promise<CopilotSession> {
		if (this.session?.sessionId === threadId) {
			return this.session;
		}

		// Maintain a local reference to state for this run
		let localState = initialState || {};

		if (client.getState() === "disconnected") await client.start();

		// Map AG-UI tools to Copilot SDK tools
		// defineTool accepts raw JSON Schema in 'parameters'
		const sdkTools = tools.map((tool) =>
			defineTool(tool.name, {
				description: tool.description,
				parameters: tool.parameters,
				handler: async (args, invocation) => {
					observer.next({
						type: EventType.TOOL_CALL_CHUNK,
						toolCallId: invocation.toolCallId,
						toolCallName: invocation.toolName,
						delta: JSON.stringify(args),
					} as ToolCallChunkEvent);

					return {
						__agui_tool_call_id: "224335_32234",
						__agui_status: "PENDING_CLIENT_EXECUTION",
						message: "Tool call dispatched to client for execution",
					};
				},
			}),
		);

		const sessions = await this.client.listSessions();
		const existingSession = sessions.find((s) => s.sessionId === threadId);

		// resume existing session if found

		const stateToolDefinition = {
			name: "update_state",
			description:
				"Update the application state. Provide only the keys you want to change.",
			parameters: {
				type: "object",
				properties: {
					updates: {
						type: "object",
						description: "The partial state object containing updated values.",
					},
				},
				required: ["updates"],
			},
		};
		const stateTool = defineTool("update_state", {
			description: "Updates shared state",
			parameters: stateToolDefinition.parameters, // standard JSON schema
			handler: async ({ updates }: { updates: Record<string, unknown> }) => {
				console.log("State updates", updates);
				try {
					// 1. Compute new state (Merge strategy)
					// This handles simple top-level merges. For deep merges, use lodash.merge or similar.
					const newState = { ...localState, ...updates };

					// 2. Compute the RFC 6902 Patch
					// 'compare' generates: [{ op: "replace", path: "/key", value: "newVal" }]
					const delta = compare(localState, newState);
					console.log("New delta after path delta", delta);

					// 3. Emit the AG-UI Standard Event
					if (delta.length > 0) {
						observer.next({
							type: EventType.STATE_DELTA,
							delta: delta,
							timestamp: Date.now(),
						});

						// 4. Update local reference for subsequent tool calls in this same run
						localState = newState;
					}

					return { success: true, message: "State updated" };
				} catch (err) {
					console.error("Error computing state patch:", err);
					return { success: false, error: "Failed to calculate state patch" };
				}
			},
		});

		if (existingSession) {
			this.session = await this.client.resumeSession(threadId, {
				streaming: true,
				tools: [...sdkTools, stateTool],
				hooks: {
					onPreToolUse: async (input) => {
						return {
							permissionDecision: "allow",
							modifiedArgs: input.toolArgs,
							additionalContext:
								"Tool results will be executed on the frontend and results returned as part of your context conversation in the later messages.",
							suppressOutput: true,
						};
					},
					onUserPromptSubmitted: async () => {
						console.log("User input submited injecting application context");
						return {
							additionalContext: `\n\n<ApplicationCurrentStateSnapshot>:\n${JSON.stringify(localState, null, 2)}\n</ApplicationCurrentStateSnapshot>\n\n`,
							suppressOutput: true,
						};
					},
				},
				workingDirectory: "/tmp/copilot/session-state",
			});
			return this.session;
		}

		this.session = await this.client.createSession({
			model: model,
			sessionId: threadId,
			streaming: true,
			tools: [...sdkTools, stateTool],
			availableTools: [
				...sdkTools.map((t) => t.name),
				"web_fetch",
				"ask_user",
				"update_state",
			],
			hooks: {
				onPreToolUse: async (input) => {
					console.log("tool invocation");

					return {
						permissionDecision: "allow",
						modifiedArgs: input.toolArgs,
						additionalContext:
							"Tool results will be executed on the frontend and results returned as part of your context conversation in the later messages.",
						suppressOutput: true,
					};
				},
				onUserPromptSubmitted: async () => {
					console.log("User input submited injecting application context");
					return {
						additionalContext: `\n\n<ApplicationCurrentStateSnapshot>:\n${JSON.stringify(localState, null, 2)}\n</ApplicationCurrentStateSnapshot>\n\n`,
						suppressOutput: true,
					};
				},
			},
			systemMessage: {
				mode: "replace",
				content: systemMessage,
			},
			workingDirectory: "/tmp/copilot/session-state",
		});

		return this.session;
	}

	private async destroySession() {
		if (this.session) {
			this.session.destroy();
			this.session = null;
		}
	}
}
