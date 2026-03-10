import {
    EventType,
    BaseEvent,
    TextMessageChunkEvent,
    ToolCallChunkEvent,
    Tool,
} from "@ag-ui/client";
import { Observer } from "rxjs";
import { client } from "../copilot-sdk.js";
import {
    approveAll,
    defineTool,
    SessionConfig,
    type CopilotSession,
} from "@github/copilot-sdk";

/** Default timeout for pending tool calls (5 minutes) */
const TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Module-level state — shared across all agent instances and requests
// ---------------------------------------------------------------------------

interface PendingToolCall {
    resolve: (result: string) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    threadId: string; // back-reference for cleanup by thread
}

/**
 * Pending tool calls keyed by toolCallId.
 * Stores resolve/reject + a timeout timer so promises can't leak.
 */
const pendingToolCalls = new Map<string, PendingToolCall>();

/**
 * Session cache keyed by threadId.
 * Each entry holds the CopilotSession and any active subscriptions.
 */
const sessionCache = new Map<string, CopilotSession>();

/**
 * Per-thread creation lock. Prevents concurrent getSession() calls from
 * creating duplicate sessions for the same threadId.
 */
const sessionCreationLocks = new Map<string, Promise<CopilotSession>>();

interface ActiveObserverEntry {
    observer: Observer<BaseEvent>;
    runId: string;
    /** Unsubscribe functions for the current session event listeners */
    cleanup: (() => void) | null;
}

/**
 * Currently-active observer per threadId. Tool handlers read from here
 * so they always emit on the correct SSE stream.
 */
const activeObservers = new Map<string, ActiveObserverEntry>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register (or replace) the active observer for a thread.
 * Completes the previous observer if one existed so its SSE stream closes.
 */
export function setActiveObserver(
    threadId: string,
    observer: Observer<BaseEvent>,
    runId: string,
): void {
    const prev = activeObservers.get(threadId);
    if (prev) {
        // Clean up old session event listeners
        prev.cleanup?.();
        // Complete old observer so the SSE response ends cleanly
        try {
            prev.observer.complete();
        } catch {
            // Observer may already be closed — ignore
        }
    }
    activeObservers.set(threadId, { observer, runId, cleanup: null });
}

/**
 * Get the currently-active observer for a thread (if any).
 */
export function getActiveObserver(
    threadId: string,
): { observer: Observer<BaseEvent>; runId: string } | undefined {
    return activeObservers.get(threadId);
}

// ---------------------------------------------------------------------------
// Pending tool calls
// ---------------------------------------------------------------------------

/**
 * Store a pending tool call with a timeout.
 * Returns a Promise that resolves with the tool result or rejects on timeout.
 */
export function createPendingToolCall(
    toolCallId: string,
    threadId: string,
    timeoutMs: number = TOOL_CALL_TIMEOUT_MS,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingToolCalls.delete(toolCallId);
            reject(
                new Error(
                    `Tool call ${toolCallId} timed out after ${timeoutMs}ms`,
                ),
            );
        }, timeoutMs);

        pendingToolCalls.set(toolCallId, {
            resolve: (val: string) => {
                clearTimeout(timer);
                resolve(val);
            },
            reject: (err: Error) => {
                clearTimeout(timer);
                reject(err);
            },
            timer,
            threadId,
        });
    });
}

/**
 * Resolve a pending tool call (called when client sends back results).
 * Returns true if the tool call was found and resolved.
 */
export function resolvePendingToolCall(
    toolCallId: string,
    result: string,
): boolean {
    const pending = pendingToolCalls.get(toolCallId);
    if (!pending) return false;
    pending.resolve(result);
    pendingToolCalls.delete(toolCallId);
    return true;
}

/**
 * Check whether a pending tool call exists.
 */
export function hasPendingToolCall(toolCallId: string): boolean {
    return pendingToolCalls.has(toolCallId);
}

/**
 * Reject and clean up all pending tool calls for a given thread.
 * Called on client disconnect or session destruction.
 */
export function rejectPendingToolCallsForThread(threadId: string): void {
    for (const [toolCallId, pending] of pendingToolCalls) {
        if (pending.threadId === threadId) {
            pending.reject(
                new Error(
                    `Tool call ${toolCallId} cancelled: thread ${threadId} disconnected`,
                ),
            );
            pendingToolCalls.delete(toolCallId);
        }
    }
}

// ---------------------------------------------------------------------------
// Session cache + creation with lock
// ---------------------------------------------------------------------------

/**
 * Get a cached session for a threadId, or return undefined.
 */
export function getCachedSession(threadId: string): CopilotSession | undefined {
    return sessionCache.get(threadId);
}

export interface CreateSessionOptions {
    threadId: string;
    config: Partial<SessionConfig>;
}

/**
 * Get or create a session for a threadId.
 * Uses a per-thread lock to prevent duplicate creation from concurrent requests.
 */
export async function getOrCreateSession({
    threadId,
    config,
}: CreateSessionOptions): Promise<CopilotSession> {
    // Fast path: already cached
    const cached = sessionCache.get(threadId);
    if (cached) return cached;

    // Check if another request is already creating a session for this thread
    const existing = sessionCreationLocks.get(threadId);
    if (existing) return existing;

    // Create with lock
    const creation = _createSessionLocked(threadId, config);
    sessionCreationLocks.set(threadId, creation);

    try {
        return await creation;
    } finally {
        sessionCreationLocks.delete(threadId);
    }
}

async function _createSessionLocked(
    threadId: string,
    config: Partial<SessionConfig>,
): Promise<CopilotSession> {
    // Re-check cache inside the lock (another request may have created it
    // between our initial check and acquiring the lock)
    const cached = sessionCache.get(threadId);
    if (cached) return cached;

    // Ensure client connection
    if (client.getState() === "disconnected") await client.start();

    // Try to resume existing session on the SDK side, otherwise create new.
    // This avoids the expensive listSessions() call on every cache miss.
    let session: CopilotSession;
    try {
        session = await client.resumeSession(threadId, {
            ...config,
            onPermissionRequest: approveAll,
        });
    } catch {
        // resumeSession throws if session doesn't exist — create fresh
        session = await client.createSession({
            ...config,
            onPermissionRequest: approveAll,
            sessionId: threadId,
        });
    }

    sessionCache.set(threadId, session);
    return session;
}

// ---------------------------------------------------------------------------
// Session subscription helpers
// ---------------------------------------------------------------------------

/**
 * Subscribe to session events (message_delta, idle) and forward to the
 * active observer. Stores cleanup function in activeObservers so it can
 * be torn down on next request or session destruction.
 *
 * Guards against duplicate subscriptions by cleaning up any previous
 * listeners for this thread first.
 */
export function subscribeToSession(
    session: CopilotSession,
    threadId: string,
    runId: string,
    observer: Observer<BaseEvent>,
): void {
    const entry = activeObservers.get(threadId);

    // Clean up any previous subscription for this thread
    if (entry?.cleanup) {
        entry.cleanup();
        entry.cleanup = null;
    }

    const unsubDelta = session.on("assistant.message_delta", (event) => {
        observer.next({
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: event.data.messageId,
            delta: event.data.deltaContent,
            role: "assistant",
        } satisfies TextMessageChunkEvent);
    });

    const unsubIdle = session.on("session.idle", () => {
        observer.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
        });
        observer.complete();
        // Self-cleanup after idle
        cleanupFn();
    });

    const cleanupFn = () => {
        unsubDelta();
        unsubIdle();
    };

    // Store cleanup so it can be called externally
    if (entry) {
        entry.cleanup = cleanupFn;
    }
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

/**
 * Map AG-UI tools to Copilot SDK tools with blocking handlers that
 * dispatch tool calls to the client and wait for results.
 */
export function mapToolsToSdk(tools: Tool[], threadId: string) {
    return tools.map((tool) =>
        defineTool(tool.name, {
            description: tool.description,
            parameters: tool.parameters,
            handler: async (args, invocation) => {
                const active = getActiveObserver(threadId);
                if (!active) {
                    console.warn(
                        `No active observer for thread ${threadId} during tool call ${invocation.toolCallId}`,
                    );
                    return "Error: no active client connection";
                }

                const { observer: currentObserver, runId: currentRunId } =
                    active;

                // Emit TOOL_CALL_CHUNK to notify client
                console.log("invoked tool call with args", args);
                currentObserver.next({
                    type: EventType.TOOL_CALL_CHUNK,
                    toolCallId: invocation.toolCallId,
                    toolCallName: invocation.toolName,
                    delta: JSON.stringify(args),
                } as ToolCallChunkEvent);

                // Signal run finished so client executes the tool
                currentObserver.next({
                    type: EventType.RUN_FINISHED,
                    threadId,
                    runId: currentRunId,
                });
                currentObserver.complete();

                // Block until client sends results (with timeout)
                console.log(
                    `Tool ${invocation.toolName} (${invocation.toolCallId}) dispatched to client. Waiting for result...`,
                );

                const result = await createPendingToolCall(
                    invocation.toolCallId,
                    threadId,
                );

                console.log(
                    `Tool ${invocation.toolName} (${invocation.toolCallId}) received result from client.`,
                );

                return result;
            },
        }),
    );
}

// ---------------------------------------------------------------------------
// Cleanup / Destruction
// ---------------------------------------------------------------------------

/**
 * Destroy a single session and clean up all associated state.
 */
export async function destroySession(threadId: string): Promise<void> {
    // 1. Reject any pending tool calls for this thread
    rejectPendingToolCallsForThread(threadId);

    // 2. Clean up observer + listeners
    const entry = activeObservers.get(threadId);
    if (entry) {
        entry.cleanup?.();
        try {
            entry.observer.complete();
        } catch {
            // Already closed
        }
        activeObservers.delete(threadId);
    }

    // 3. Destroy the SDK session
    const session = sessionCache.get(threadId);
    if (session) {
        try {
            await session.destroy();
        } catch (err) {
            console.warn(`Failed to destroy SDK session ${threadId}:`, err);
        }
        sessionCache.delete(threadId);
    }
}

/**
 * Destroy all sessions. Called from DELETE /agent/sessions endpoint
 * or during graceful shutdown.
 */
export async function destroyAllSessions(): Promise<void> {
    const threadIds = [...sessionCache.keys()];
    await Promise.allSettled(threadIds.map((id) => destroySession(id)));
}

/**
 * Clean up observer/listener state for a thread when client disconnects.
 * Does NOT reject pending tool calls — they must survive across SSE connections
 * because the human-in-the-loop flow intentionally closes the stream between
 * dispatching a tool call and receiving its result.
 * Does NOT destroy the session (it may still be needed if client reconnects).
 */
export function onClientDisconnect(threadId: string): void {
    // NOTE: Do NOT reject pending tool calls here. The SSE connection closing
    // is expected during the human-in-the-loop tool call flow: the agent
    // completes the observer (closing SSE) so the client can execute the tool,
    // then the client sends the result in a new HTTP request. Rejecting pending
    // tool calls here would destroy the bridge and cause an infinite loop.
    const entry = activeObservers.get(threadId);
    if (entry) {
        entry.cleanup?.();
        entry.cleanup = null;
    }
    // Don't delete the observer entry — the session may still be alive
    // and a new request may come in with a new observer
}

/**
 * Get diagnostic info about current state (for debugging).
 */
export function getSessionManagerStats() {
    return {
        cachedSessions: sessionCache.size,
        pendingToolCalls: pendingToolCalls.size,
        activeObservers: activeObservers.size,
        creationLocks: sessionCreationLocks.size,
    };
}
