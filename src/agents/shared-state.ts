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
import jsonpatch from "fast-json-patch";
import {
	defineTool,
	SessionConfig,
	type CopilotClient,
	type CopilotSession,
} from "@github/copilot-sdk";

type RunAgent = Observable<BaseEvent>;

export class SharedStateAgent extends AbstractAgent {
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
		console.log("systemMessage", systemMessage);

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

		// ensure client connection
		if (client.getState() === "disconnected") await client.start();

		// Map AG-UI tools to Copilot SDK tools
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
						__agui_tool_call_id: invocation.toolCallId,
						__agui_status: "PENDING_CLIENT_EXECUTION",
						message: "Tool call dispatched to client for execution",
					};
				},
			}),
		);

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
				console.log("Raw Tool Arguments:", JSON.stringify(args, null, 2));

				try {
					const operations = args.operations;
					console.log("operations", operations);

					if (
						!operations ||
						!Array.isArray(operations) ||
						operations.length === 0
					) {
						console.warn("No valid operations provided to update_state");
						return {
							success: false,
							error:
								"No valid operations provided. Expected an array of JSON Patch operations.",
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
							console.warn("Missing value for add/replace operation:", op);
							return {
								success: false,
								error: `Operation '${op.op}' requires a 'value' field`,
							};
						}
					}

					console.log("Applying JSON Patch operations:", operations);

					// Apply patches directly to local state
					const result = jsonpatch.applyPatch(
						localState,
						operations,
						true,
						false,
					);
					localState = result.newDocument;

					// Forward the operations as the delta to the frontend
					observer.next({
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

		const commonConfig = {
			streaming: true,
			workingDirectory: "/tmp",
			tools: [...sdkTools, stateTool],
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
				onUserPromptSubmitted: async (input) => {
					const appContext = `\n\n<ApplicationContext>:\n${JSON.stringify(localState, null, 2)}\n</ApplicationContext>  \n\n`;

					return {
						modifiedPrompt: `${input.prompt}\n${appContext}`,
						// additionalContext: appContext,
						suppressOutput: true,
					};
				},
			},
		} satisfies Partial<SessionConfig>;

		const sessions = await this.client.listSessions();
		const existingSession = sessions.find((s) => s.sessionId === threadId);

		if (existingSession) {
			this.session = await this.client.resumeSession(threadId, {
				...commonConfig,
			});
			return this.session;
		}

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
		this.session = await this.client.createSession({
			...commonConfig,
			model: model || "gpt-4.1",
			// model: model || "gpt-5-mini",
			sessionId: threadId,
			availableTools: [
				...commonConfig.tools.map((t) => t.name),
				"web_fetch",
				"ask_user",
			],
			systemMessage: {
				mode: "replace",
				content: systemMessage + stateDirectives,
			},
		});

		return this.session;
	}

	private async destroySession() {
		if (this.session) {
			await this.session.abort();
			this.session.destroy();
			this.session = null;
		}
	}
}
