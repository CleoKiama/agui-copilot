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

		// Define state tool
		const stateToolDefinition = {
			name: "update_state",
			description:
				"REQUIRED: Update the shared state. ONLY provide the properties that have changed. Do not send back the full state.",
			parameters: {
				type: "object",
				properties: {
					updates: {
						type: "object",
						description:
							"Map of paths to new values. For deep changes, use dot-notation (e.g., {'recipe.title': 'New Name'} or {'recipe.ingredients.0.amount': '2 cups'}).",
					},
				},
				required: ["updates"],
			},
		};

		const stateTool = defineTool("update_state", {
			description:
				"Updates shared state.You must Use this to update the shared state for the application and keep it in sync as the user expects.",
			parameters: stateToolDefinition.parameters,
			handler: async (args: Record<string, unknown>) => {
				console.log("Raw Tool Arguments:", JSON.stringify(args, null, 2));
				const updates = args.updates || args;

				try {
					const { compare } = jsonpatch;
					const newState = { ...localState, ...updates };
					const delta = compare(localState, newState);
					console.log("New delta after path delta", delta);

					if (delta.length > 0) {
						observer.next({
							type: EventType.STATE_DELTA,
							delta: delta,
							timestamp: Date.now(),
						});
						localState = newState;
					}
					return { success: true, message: "State updated" };
				} catch (err) {
					console.error("Error computing state patch:", err);
					return { success: false, error: "Failed to calculate state patch" };
				}
			},
		});

		// 1. EXTRACT COMMON CONFIGURATION
		// We use Pick<SessionConfig, ...> to ensure type safety for the properties we are extracting.
		// This ensures these properties are valid for both createSession and resumeSession.

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
                   SYSTEM INSTRUCTIONS:
                   - The Front-end is the SOURCE OF TRUTH for the application state.
                   - The <ApplicationContext> provided is for your reference only.
                   - When changing the state via "update_state", you MUST ONLY include the specific keys/properties that are being modified or added.
                   - DO NOT reconstruct the entire state object. 
                   - DO NOT include unchanged fields from the <ApplicationContext>.
                   - Example: If the user only wants to change the title, your "updates" object should ONLY contain the "title" key, not the ingredients or instructions.
                   - If adding an item to a list, send the updated list with the new item included, but keep all other top-level keys out of the call.
                   `;
		this.session = await this.client.createSession({
			...commonConfig,
			model: model || "gpt-5-mini",
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
