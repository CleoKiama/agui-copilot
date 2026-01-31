import {
	AbstractAgent,
	RunAgentInput,
	EventType,
	BaseEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";

// type RunAgent = () => Observable<BaseEvent>;

export class SimpleAgent extends AbstractAgent {
	// The base class expects: (input: RunAgentInput) => Observable<BaseEvent>
	run(input: RunAgentInput): Observable<BaseEvent> {
		const { threadId, runId } = input;

		// REMOVE: "return () =>"
		return new Observable<BaseEvent>((observer) => {
			observer.next({
				type: EventType.RUN_STARTED,
				threadId,
				runId,
			});

			const messageId = Date.now().toString();

			observer.next({
				type: EventType.TEXT_MESSAGE_START,
				messageId,
				role: "assistant",
			});

			observer.next({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId,
				delta: "Hello, world!",
			});

			observer.next({
				type: EventType.TEXT_MESSAGE_END,
				messageId,
			});

			observer.next({
				type: EventType.RUN_FINISHED,
				threadId,
				runId,
			});

			observer.complete();
		});
	}
}
