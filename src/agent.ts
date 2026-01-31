import {
	AbstractAgent,
	RunAgentInput,
	EventType,
	BaseEvent,
	RunErrorEvent,
	TextMessageChunkEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { client } from "./copilot-sdk.js";
import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";

type RunAgent = Observable<BaseEvent>;

export class CopilotAgent extends AbstractAgent {
	client: CopilotClient;
	private session: CopilotSession | null = null;

	constructor() {
		super();
		this.client = client;
	}

	run(input: RunAgentInput): RunAgent {
		const { threadId, runId, messages } = input;
		const userPrompt = messages[messages.length - 1].content as string;
		console.log("userPrompt", userPrompt);

		return new Observable<BaseEvent>((observer) => {
			observer.next({
				type: EventType.RUN_STARTED,
				threadId,
				runId,
			});

			let currentSession: CopilotSession | null = null;
			let cleanup: () => void;

			const onIdle = () => {
				console.log(`[${runId}] Session idle. Stream complete.`);
				observer.complete();
			};

			// 2. Async Execution Logic
			const execute = async () => {
				try {
					currentSession = await this.getSession(threadId);

					// Attach Listeners
					const cleanDeltaEvent = currentSession.on(
						"assistant.message_delta",
						(event) => {
							const deltaEvent: TextMessageChunkEvent = {
								type: EventType.TEXT_MESSAGE_CHUNK,
								messageId: event.data.messageId,
								deltaContent: event.data.deltaContent,
								role: "assistant",
							};
							observer.next(deltaEvent);
						},
					);

					const offIdleListener = currentSession.on("session.idle", onIdle);

					cleanup = () => {
						console.log(`[${runId}] Cleaning up session listeners.`);
						cleanDeltaEvent();
						offIdleListener();
					};

					console.log(`[${runId}] Sending prompt to Copilot...`);
					// Send the message to trigger events
					await currentSession.send({
						prompt: userPrompt,
					});
				} catch (error: unknown) {
					console.error("Error during Copilot run:", error);
					const errorMessage =
						error instanceof Error ? error.message : "Unknown error";
					observer.next({
						type: EventType.RUN_ERROR,
						threadId,
						runId,
						message: errorMessage,
					} as RunErrorEvent);

					cleanup?.();
					void this.destroySession();
				}
			};

			execute();

			return () => {
				console.log(`[${runId}] Observer torn down.`);
				cleanup();
				void this.destroySession();
			};
		});
	}

	private async getSession(
		threadId: string,
		model: string = "gpt-4o",
	): Promise<CopilotSession> {
		if (this.session) return this.session;

		this.session = await this.client.createSession({
			model: model,
			sessionId: threadId,
			streaming: true, // Ensure streaming is enabled!
			systemMessage: {
				mode: "replace",
				content: "You are a helpful assistant.",
			},
			workingDirectory: "/tmp/copilot/session-state",
		});

		return this.session;
	}

	private async destroySession() {
		if (this.session) {
			console.log("Destroying session...");
			this.session.destroy();
			this.session = null;
		}
	}
}
