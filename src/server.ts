import express from "express";
import { CopilotAgent } from "./agent.js";
import { graceFullShutDown } from "./copilot-sdk.js";
import { RunErrorEvent } from "@ag-ui/client";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.post("/agent", (req, res) => {
	if (!req.accepts("text/event-stream"))
		return res.status(406).end("Not Acceptable");

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
			res.end(`data: ${JSON.stringify(event)}\n\n`);
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
