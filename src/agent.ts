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
import {
	defineTool,
	type CopilotClient,
	type CopilotSession,
} from "@github/copilot-sdk";

type RunAgent = Observable<BaseEvent>;

export class CopilotAgent extends AbstractAgent {
	client: CopilotClient;
	private session: CopilotSession | null = null;

	constructor() {
		super();
		this.client = client;
	}

	run(input: RunAgentInput): RunAgent {
		const { threadId, runId, messages, tools } = input;

		// Handle generic content or multimodal content array
		const lastUserMsg = messages.findLast((msg) => msg.role === "user");
		const userPrompt = Array.isArray(lastUserMsg?.content)
			? lastUserMsg.content
					.map((c) => (c.type === "text" ? c.text : ""))
					.join("") // Simple text extraction
			: lastUserMsg?.content || "";

		const lastToolMsg = messages.findLast((msg) => msg.role === "tool");

		const systemMessage = messages.find(
			(msg) => msg.role === "system",
		)?.content;

		return new Observable<BaseEvent>((observer) => {
			observer.next({
				type: EventType.RUN_STARTED,
				threadId,
				runId,
			});

			let currentSession: CopilotSession | null = null;
			let cleanup: () => void;

			const onIdle = () => {
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

					let prompt = userPrompt;
					if (lastToolMsg) {
						prompt += `Last tool result received ${lastToolMsg.content}`;
					}

					await currentSession.send({
						prompt,
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
	}: {
		threadId: string;
		model?: string;
		systemMessage?: string;
		tools?: Tool[];
		observer: Observer<BaseEvent>;
	}): Promise<CopilotSession> {
		if (this.session?.sessionId === threadId) {
			return this.session;
		}

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

		if (client.getState() === "disconnected") await client.start();

		const sessions = await this.client.listSessions();
		const existingSession = sessions.find((s) => s.sessionId === threadId);

		// resume existing session if found

		if (existingSession) {
			this.session = await this.client.resumeSession(threadId, {
				streaming: true,
				tools: sdkTools,
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
				},

				workingDirectory: "/tmp/copilot/session-state",
			});
			return this.session;
		}

		this.session = await this.client.createSession({
			model: model,
			sessionId: threadId,
			streaming: true,
			tools: sdkTools, // Inject mapped tools
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
