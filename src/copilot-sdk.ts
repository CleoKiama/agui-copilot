import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({
	cliUrl: "localhost:4321",
});

const graceFullShutDown = async () => {
	console.log("Shutting down...");

	const errors = await client.stop();
	if (errors.length > 0) {
		console.error("Cleanup errors:", errors);
	}
};

// Gracefull shutdown
process.on("SIGINT", graceFullShutDown);

const session = await client.createSession({
	model: "gpt-4.1",
	systemMessage: {
		mode: "replace",
		content: "You are a helpful assitant",
	},
	tools: [],
});

const response = await session.sendAndWait({
	prompt: "What tools do you currently have access to ",
});
console.log(response?.data.content);

await client.stop();

process.exit(0);
