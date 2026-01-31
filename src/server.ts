import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.post("/agent", (req, res) => {
	if (!req.accepts("text/event-stream"))
		return res.status(406).end("Not Acceptable");

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	console.log("Received request:");
	const intervalRef = setInterval(() => {
		console.log("sending ping");
		res.write(`data: ${JSON.stringify({ message: "ping" })}\n\n`);
	}, 1000);
	setTimeout(() => {
		clearInterval(intervalRef);
		console.log("sending done");
		res.end("data: " + JSON.stringify({ message: "done" }) + "\n\n");
	}, 7000);
});

app.listen(
	{
		port: PORT,
		host: "0.0.0.0",
	},
	() => {
		console.log("Server running on port", PORT);
	},
);
