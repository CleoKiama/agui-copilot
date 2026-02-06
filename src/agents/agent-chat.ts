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

		// Extract common session config for deduplication
		const commonConfig = {
			// model: model || "gpt-4.1",
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

		// resume existing session if found

		if (existingSession) {
			this.session = await this.client.resumeSession(threadId, {
				...commonConfig,
			});
			return this.session;
		}

		this.session = await this.client.createSession({
			...commonConfig,
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
