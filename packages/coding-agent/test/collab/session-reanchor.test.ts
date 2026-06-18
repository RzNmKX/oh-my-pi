/**
 * Contract: when the active session changes underneath a live host (a /resume
 * or branch switch), collab does NOT end. The host re-anchors to the new
 * session and re-welcomes every connected guest with the resumed transcript,
 * so guests follow along in place. Runs over the same in-memory relay + fake
 * WebSocket transport as the read-only suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry as StoredSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { FakeWebSocket, InMemoryRelay, joinAsGuest, setActiveRelay } from "./relay-harness";

/** Mutable session backing the context double, so a test can simulate /resume. */
interface FakeSession {
	id: string;
	entries: StoredSessionEntry[];
	onEntryAppended?: (entry: StoredSessionEntry) => void;
}

function messageEntry(id: string, text: string): StoredSessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	} as unknown as StoredSessionEntry;
}

function makeHostContext(state: FakeSession): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => state.id,
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: state.id, timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: state.entries.map(entry => structuredClone(entry)),
			}),
			get onEntryAppended() {
				return state.onEntryAppended;
			},
			set onEntryAppended(handler: ((entry: StoredSessionEntry) => void) | undefined) {
				state.onEntryAppended = handler;
			},
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

const RealWebSocket = globalThis.WebSocket;
let state: FakeSession;
let host: CollabHost;

beforeAll(async () => {
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	setActiveRelay(new InMemoryRelay());
	state = { id: "sess-1", entries: [messageEntry("a1", "first session")] };
	host = new CollabHost(makeHostContext(state));
	await host.start("ws://localhost:8787");
});

afterAll(async () => {
	globalThis.WebSocket = RealWebSocket;
	setActiveRelay(null);
	await host.stop("test done");
});

describe("collab re-anchors on session switch", () => {
	it("re-welcomes connected guests onto the resumed session instead of ending", async () => {
		const guest = await joinAsGuest(host.link, "phone");

		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		expect(welcome.header.id).toBe("sess-1");
		expect(welcome.entries).toHaveLength(1);
		expect(host.participants.find(p => p.name === "phone")).toBeDefined();

		// Simulate /resume: swap the active session, then let the host observe an
		// entry on it (the same hook setSessionFile/append drives in production).
		state.id = "sess-2";
		state.entries = [messageEntry("b1", "resumed session"), messageEntry("b2", "more")];
		const appended = state.onEntryAppended;
		if (!appended) throw new Error("host did not register onEntryAppended");
		appended(messageEntry("b2", "more"));

		// The guest is re-welcomed onto sess-2 rather than dropped.
		const rewelcome = await guest.nextFrame();
		if (rewelcome.t !== "welcome") throw new Error(`expected re-welcome, got ${rewelcome.t}`);
		expect(rewelcome.header.id).toBe("sess-2");
		expect(rewelcome.entries).toHaveLength(2);

		// Collab is still live: the host kept the guest, did not tear down.
		expect(host.participants.find(p => p.name === "phone")).toBeDefined();

		guest.socket.close();
	});
});
