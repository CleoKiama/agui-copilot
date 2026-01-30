import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
const session = await client.createSession({ model: "gpt-4.1" });

const response = await session.sendAndWait({
	prompt:
		"in detail how does the tokio runtime in rust work and how does it compare to libuv ? ",
});
console.log(response?.data.content);

await client.stop();
process.exit(0);
