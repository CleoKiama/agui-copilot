import express from "express";
import { CopilotAgent } from "./agent.js";
import { client, graceFullShutDown } from "./copilot-sdk.js";
import { RunErrorEvent } from "@ag-ui/client";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.post("/agent", (req, res) => {
	if (!req.accepts("text/event-stream"))
		return res.status(406).end("Not Acceptable");
	console.log("processing new /agent request with body:");
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});

	const agent = new CopilotAgent();
	const observable = agent.run(req.body);
	const subscription = observable.subscribe({
		next(event) {
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		},
		complete() {
			res.end();
		},
		error(error: RunErrorEvent) {
			console.error(error);
			res.end(`data: ${JSON.stringify(error)}\n\n`);
		},
	});

	res.on("close", () => {
		subscription.unsubscribe();
		console.log("Client connection closed, agent subscription cancelled.");
	});

	res.on("error", () => {
		console.log("Response error, cleaning up subscription.");
		subscription.unsubscribe();
	});

	req.on("error", (err) => {
		console.error("Request error:", err);
		subscription.unsubscribe();
		res.end();
	});
});

app.delete("/agent/:sessionId", async (req, res) => {
	const { sessionId } = req.params;
	try {
		await client.start();
		const sessions = await client.listSessions();
		for (const session of sessions) {
			if (session.sessionId === sessionId) {
				await client.deleteSession(sessionId);
				res
					.status(200)
					.json({ success: true, message: `Session ${sessionId} deleted.` });
				return;
			}
		}
		res
			.status(404)
			.json({ success: false, error: `Session ${sessionId} not found.` });
	} catch (error: unknown) {
		const message =
			error instanceof Error ? error.message : "something went wrong";
		res.status(500).json({ success: false, error: message });
	}
});

const server = app.listen(
	{
		port: PORT,
		host: "0.0.0.0",
	},
	(error) => {
		if (error) {
			console.error("Error starting server:", error);
			return;
		}
		console.log("Server running on port", PORT);
	},
);

const cleanUp = () => {
	console.log("Cleaning up before shutdown...");
	void graceFullShutDown();

	server.close(() => {
		console.log("Server closed.");
	});

	setImmediate(() => {
		server.closeAllConnections();
	});
};

process.on("SIGINT", cleanUp);
process.on("SIGTERM", cleanUp);
