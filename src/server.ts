import express from "express";
import { CopilotAgent } from "./agents/agent-chat.js";
import { client, graceFullShutDown } from "./copilot-sdk.js";
import { RunErrorEvent } from "@ag-ui/client";
import { HumanInTheLoopAgent } from "./agents/human-in-the-loop.js";
import { SharedStateAgent } from "./agents/shared-state.js";
import {
    destroySession,
    destroyAllSessions,
    onClientDisconnect,
    getSessionManagerStats,
} from "./agents/session-manager.js";
import {
    clearThreadLocalState,
    clearAllThreadLocalState,
} from "./agents/shared-state.js";

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

/**
 * Helper: extract threadId from request body (AG-UI protocol sends it).
 */
function getThreadId(req: express.Request): string | undefined {
    return req.body?.threadId;
}

app.post("/agent/agentic_chat", (req, res) => {
    if (!req.accepts("text/event-stream"))
        return res.status(406).end("Not Acceptable");
    console.log("processing request at /agent/agentic_chat");
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const threadId = getThreadId(req);
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
        if (threadId) onClientDisconnect(threadId);
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

app.post("/agent/human_in_the_loop", (req, res) => {
    if (!req.accepts("text/event-stream"))
        return res.status(406).end("Not Acceptable");
    console.log("request received at /agent/human_in_the_loop");
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const threadId = getThreadId(req);
    const agent = new HumanInTheLoopAgent();
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
        if (threadId) onClientDisconnect(threadId);
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

app.post("/agent/shared_state", (req, res) => {
    if (!req.accepts("text/event-stream"))
        return res.status(406).end("Not Acceptable");
    console.log("request received at /agent/shared_state");
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const threadId = getThreadId(req);
    const agent = new SharedStateAgent();
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
        if (threadId) onClientDisconnect(threadId);
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

app.delete("/agent/sessions", async (_req, res) => {
    console.log("clearing all sessions");
    try {
        // Clean up all in-memory state (pending promises, observers, session cache)
        await destroyAllSessions();
        // Clean up shared-state local state
        clearAllThreadLocalState();

        // Also delete remote sessions from SDK
        if (client.getState() === "disconnected") await client.start();
        const sessions = await client.listSessions();
        for (const { sessionId } of sessions) {
            console.log("deleting remote session", sessionId);
            await client.deleteSession(sessionId);
        }

        res.status(200).json({
            success: true,
            message: `All sessions deleted.`,
        });
    } catch (error: unknown) {
        console.log("error deleting sessions", error);
        const message =
            error instanceof Error ? error.message : "something went wrong";
        res.status(500).json({ success: false, error: message });
    }
});

app.delete("/agent/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    try {
        // Clean up in-memory state for this session
        await destroySession(sessionId);
        clearThreadLocalState(sessionId);

        // Delete from the SDK remote
        if (client.getState() === "disconnected") await client.start();
        await client.deleteSession(sessionId);

        res.status(200).json({
            success: true,
            message: `Session ${sessionId} deleted.`,
        });
    } catch (error: unknown) {
        const message =
            error instanceof Error ? error.message : "something went wrong";
        res.status(500).json({ success: false, error: message });
    }
});

/**
 * Diagnostic endpoint — returns session manager stats.
 */
app.get("/agent/stats", (_req, res) => {
    res.json(getSessionManagerStats());
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
    // Destroy all in-memory sessions (rejects pending promises, cleans observers)
    void destroyAllSessions();
    void clearAllThreadLocalState();
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
