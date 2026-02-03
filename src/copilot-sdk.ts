import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({
	logLevel: "info",
	cliUrl: "localhost:4321",
});

const graceFullShutDown = async () => {
	console.log("Shutting Copilot client...");

	const errors = await client.stop();
	if (errors.length > 0) {
		console.error("Cleanup errors:", errors);
	}
	console.log("Copilot client shut down complete");
};

export { client, graceFullShutDown };
