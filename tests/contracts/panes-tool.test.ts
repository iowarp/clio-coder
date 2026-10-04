import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import type { MuxContract } from "../../src/domains/mux/contract.js";
import { deliverPeerPrompt, PEER_INBOX_TOKEN } from "../../src/domains/mux/peer-inbox.js";
import type { MuxPaneRecord } from "../../src/domains/mux/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createPanesRuntime } from "../../src/interactive/panes-runtime.js";
import { createPeerInbox } from "../../src/interactive/peer-inbox.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { createRegistry } from "../../src/tools/registry.js";

/**
 * The panes tool through the session registry over the real pane runtime the
 * `/panes` slash command drives. The pane host is the only stand-in: a mux
 * that records every request, so a refusal can be proven to reach no host.
 */

function fakeMux(available = true) {
	const calls: string[] = [];
	const records: MuxPaneRecord[] = [];
	let next = 0;
	const mux = {
		mode: available ? "guest" : "none",
		available: () => available,
		detection: () => ({
			mode: available ? "guest" : "none",
			socketPath: null,
			server: null,
			self: { workspaceId: null, tabId: null, paneId: "self" },
			candidates: [],
			reason: "HERDR_ENV is not 1, so Clio is not running inside a pane host",
			refused: false,
		}),
		list: () => records,
		async openUtilityPane(request: { argv: ReadonlyArray<string>; cwd: string; label: string }) {
			next += 1;
			const ref = { paneId: `p${next}`, tabId: "t1", workspaceId: "w1" };
			records.push({ ref, purpose: "utility", label: request.label, openedAt: next });
			calls.push(`open:${request.label}:${request.argv.join(" ")}:${request.cwd}`);
			return ref;
		},
		async closePane(paneId: string) {
			const at = records.findIndex((record) => record.ref.paneId === paneId);
			if (at < 0) return false;
			records.splice(at, 1);
			calls.push(`close:${paneId}`);
			return true;
		},
		async focusPane(paneId: string) {
			calls.push(`focus:${paneId}`);
			return true;
		},
		async focusSelf() {
			return true;
		},
		async unzoomSelf() {
			return false;
		},
		docks: () => [],
		dockVisibility: () => "closed",
	};
	return { mux: mux as unknown as MuxContract, calls };
}

function snapshot(running: Array<{ runId: string; agentId: string }> = []): DispatchSnapshot {
	return {
		generatedAt: "2026-09-22T00:00:00.000Z",
		running,
		retrying: [],
		totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
	} as unknown as DispatchSnapshot;
}

function fixture(
	options: { available?: boolean; bash?: string | null; running?: Array<{ runId: string; agentId: string }> } = {},
) {
	const { mux, calls } = fakeMux(options.available ?? true);
	const panes = createPanesRuntime({
		mux,
		getSettings: () => DEFAULT_SETTINGS,
		getDispatchSnapshot: () => snapshot(options.running),
		getCwd: () => "/workspace",
		resolveBinaryPath: () => (options.bash === undefined ? "/bin/bash" : options.bash),
		newestJournalRunId: () => null,
	});
	const registry = createRegistry({ safety: createWorkerSafety() });
	registerAllTools(registry, { mcpCapabilities: false, panes });
	return {
		panes,
		calls,
		async call(args: Record<string, unknown>): Promise<ToolResult> {
			const verdict = await registry.invoke({ tool: ToolNames.Panes, args });
			if (verdict.kind !== "ok") throw new Error(`panes was not admitted: ${JSON.stringify(verdict)}`);
			return verdict.result;
		},
	};
}

function output(result: ToolResult): string {
	if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	return result.output;
}

function errorMessage(result: ToolResult): string {
	if (result.kind !== "error") throw new Error(`expected error, got ${JSON.stringify(result)}`);
	return result.message;
}

describe("panes tool", () => {
	it("opens one pane per preset, focuses it on a second open, lists it, and closes it by label", async () => {
		const f = fixture();
		match(
			output(await f.call({ action: "list" })),
			/^panes mode=guest available; notifications=\S+\ndocks: files closed[^\n]*; workers closed; music closed[^\n]*\n- no Clio-owned panes$/,
		);
		strictEqual(output(await f.call({ action: "open", preset: "shell" })), "opened the shell pane (p1).");
		strictEqual(
			output(await f.call({ action: "open", preset: "shell" })),
			"the shell pane was already open and is now focused (p1).",
		);
		match(output(await f.call({ action: "list" })), /\n- p1 utility shell$/);
		const closed = await f.call({ action: "close", target: "shell" });
		strictEqual(output(closed), "closed 1 pane(s): shell.");
		match(errorMessage(await f.call({ action: "close", target: "shell" })), /no Clio-owned pane matches 'shell'/);
		deepStrictEqual(f.calls, ["open:shell:/bin/bash -l:/workspace", "focus:p1", "close:p1"]);
	});

	it("refuses argv, unknown presets, missing fields, and unknown actions before the pane host sees them", async () => {
		const f = fixture();
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ action: "open", preset: "shell", argv: ["rm", "-rf", "/"] }, /argv panes are operator-only/],
			[{ action: "list", argv: [] }, /argv panes are operator-only/],
			[{ action: "open", preset: "vim" }, /action=open requires preset, one of files, logs, shell/],
			[{ action: "open" }, /action=open requires preset/],
			[{ action: "show" }, /action=show requires target/],
			[{ action: "close", target: "  " }, /action=close requires target/],
			[
				{ action: "zoom", target: "p1" },
				/action must be show, open, handoff, send, wait, read, close, or list; got 'zoom'/,
			],
		];
		for (const [args, expected] of cases) match(errorMessage(await f.call(args)), expected, JSON.stringify(args));
		deepStrictEqual(f.calls, []);
	});

	it("names the missing binary and the empty journal instead of opening a broken pane", async () => {
		const f = fixture({ bash: null });
		match(
			errorMessage(await f.call({ action: "open", preset: "shell" })),
			/bash was not found \(install with `install bash/,
		);
		match(
			errorMessage(await fixture().call({ action: "open", preset: "logs" })),
			/no dispatched run has written a journal under .* yet/,
		);
		deepStrictEqual(f.calls, []);
	});

	it("says why the pane layer is missing and what starts it", async () => {
		const f = fixture({ available: false });
		match(output(await f.call({ action: "list" })), /^panes mode=none unavailable;/);
		for (const args of [
			{ action: "open", preset: "shell" },
			{ action: "show", target: "tester" },
			{ action: "close", target: "all" },
		]) {
			const message = errorMessage(await f.call(args));
			match(message, /HERDR_ENV is not 1/, JSON.stringify(args));
			match(message, /clio-coder --with-panes/, JSON.stringify(args));
		}
		deepStrictEqual(f.calls, []);
	});

	it("points the watch pane at a live run by agent id and lists live runs on a miss", async () => {
		const f = fixture({ running: [{ runId: "run-abc123", agentId: "tester" }] });
		match(
			errorMessage(await f.call({ action: "show", target: "tester" })),
			/the watch pane is not wired in this session/,
		);
		const watched: string[] = [];
		f.panes.attachWatch({
			ensureOpen: async () => true,
			watch: async (runId) => {
				watched.push(runId);
				return { status: "watching", runId, paneId: "watch", opened: true };
			},
			follow: () => true,
			toggle: async () => ({ status: "shown" }),
			hide: async () => true,
			close: async () => true,
			visibility: () => "visible",
			isOpen: () => true,
			onDockKey: () => () => undefined,
			dispose: () => {},
		});
		const shown = await f.call({ action: "show", target: "tester" });
		strictEqual(output(shown), "the workers dock is now following tester (run run-abc123).");
		strictEqual(output(await f.call({ action: "show", target: "run-abc" })), output(shown));
		strictEqual(
			errorMessage(await f.call({ action: "show", target: "reviewer" })),
			"panes: no live run matches 'reviewer'. Live runs: tester.",
		);
		deepStrictEqual(watched, ["run-abc123", "run-abc123"]);
	});
});

/**
 * A listening peer over a real inbox directory. The chat and the bus are the
 * stand-ins: what reached a fresh turn, what reached the follow-up queue, the
 * phase the status machine last published, and the session lifecycle events.
 */
function listeningPeer(
	options: { admit?: boolean; stateDir?: string; publish?: (value: string | null) => Promise<void> } = {},
) {
	const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "clio-coder-peer-inbox-"));
	const handlers = new Map<string, Set<(payload: { phase: string }) => void>>();
	const turns: string[] = [];
	const queued: Array<{ text: string; origin: string | undefined }> = [];
	const shown: string[] = [];
	const peer = { token: null as string | null, sessionId: null as string | null, streaming: false };
	const inbox = createPeerInbox({
		bus: {
			on: (channel: string, handler: (payload: { phase: string }) => void) => {
				const set = handlers.get(channel) ?? new Set();
				handlers.set(channel, set);
				set.add(handler);
				return () => set.delete(handler);
			},
		} as never,
		mux: {
			mode: "guest",
			detection: () => ({ self: { paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1" }, socketPath: "/owned.sock" }),
			advertiseSelfToken: async (key: string, value: string | null) => {
				if (key === PEER_INBOX_TOKEN) {
					if (options.publish) await options.publish(value);
					peer.token = value;
				}
				return true;
			},
		} as never,
		chat: {
			isStreaming: () => peer.streaming,
			turnPreparation: () => ({ phase: "idle", since: 0 }),
			getSessionId: () => peer.sessionId,
			submit: async (text: string, submitOptions?: { onAdmitted?: () => void }) => {
				if (options.admit === false) return;
				turns.push(text);
				submitOptions?.onAdmitted?.();
			},
			queueFollowUp: (text: string, _display: unknown, origin?: string) => {
				queued.push({ text, origin });
				return true;
			},
		} as never,
		stateDir,
		showTurn: (text, origin) => shown.push(`${text} | ${origin}`),
	});
	const fire = (channel: string, payload: { phase: string } = { phase: "" }): void => {
		for (const handler of handlers.get(channel) ?? []) handler(payload);
	};
	const send = (text: string, extra: { requestId?: string; token?: string; timeoutMs?: number } = {}) =>
		deliverPeerPrompt({
			stateDir,
			token: extra.token ?? peer.token ?? undefined,
			paneId: "w1:p2",
			socketPath: "/owned.sock",
			fromPaneId: "w1:p1",
			text,
			timeoutMs: extra.timeoutMs ?? 2_000,
			...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
		});
	return {
		stateDir,
		peer,
		turns,
		queued,
		shown,
		send,
		inboxDir: () => join(stateDir, "peer-inbox", peer.token ?? ""),
		phase: (phase: string) => fire(BusChannels.AgentStatusChanged, { phase }),
		/** `/new`, `/resume`, a fork: the session under the peer was replaced or reopened. */
		switchSession: (sessionId: string) => {
			fire(BusChannels.SessionParked);
			peer.sessionId = sessionId;
			fire(BusChannels.SessionResumed);
		},
		close: () => {
			inbox?.dispose();
			if (options.stateDir === undefined) rmSync(stateDir, { recursive: true, force: true });
		},
	};
}

const ORIGIN = "machine prompt from Clio in pane w1:p1";

describe("peer prompt inbox", () => {
	it("serializes delayed token publications through rotation and disposal", async () => {
		const publications: Array<{ value: string | null; finish: () => void }> = [];
		const p = listeningPeer({
			publish: (value) => new Promise<void>((finish) => publications.push({ value, finish })),
		});
		const flush = async (): Promise<void> => {
			for (let index = 0; index < 12; index += 1) {
				const publication = publications[index];
				if (!publication) break;
				publication.finish();
				await nextTick();
			}
		};
		try {
			await nextTick();
			strictEqual(publications.length, 1);
			const initial = publications[0]?.value;
			p.switchSession("B");
			await nextTick();
			strictEqual(publications.length, 1, "a newer token cannot overtake an unresolved publication");
			await flush();
			strictEqual(p.peer.token === initial, false);
			strictEqual(
				(await p.send("advertised current generation")).status,
				"accepted",
				"the last advertised token belongs to the live inbox",
			);

			const beforeDispose = publications.length;
			p.switchSession("C");
			await nextTick();
			strictEqual(publications.length, beforeDispose + 1);
			p.close();
			await nextTick();
			strictEqual(publications.length, beforeDispose + 1, "clearing the token waits behind pending publication");
			await flush();
			strictEqual(publications.at(-1)?.value, null);
			strictEqual(p.peer.token, null, "a late publication cannot revive the disposed peer");
		} finally {
			p.close();
			await flush();
		}
	});

	it("admits one turn per request id, however long ago it was claimed and whether or not its receipt landed", async () => {
		const p = listeningPeer();
		try {
			const first = await p.send("review the diff");
			strictEqual(first.status, "accepted");
			deepStrictEqual(p.shown, [`review the diff | ${ORIGIN}`]);
			// More requests than any in-memory cache would hold, then the first id again.
			const fillers = await Promise.all(Array.from({ length: 300 }, (_, index) => p.send(`filler ${index}`)));
			for (const delivered of fillers) strictEqual(delivered.status, "accepted");
			strictEqual(p.turns.length, 301);
			const again = await p.send("review the diff", { requestId: first.requestId ?? "" });
			strictEqual(again.status, "accepted");
			strictEqual(p.turns.filter((text) => text === "review the diff").length, 1);

			// The receiver enqueues but cannot write its receipt: unconfirmed, never
			// "not delivered", and a retry of the id is answered without a second turn.
			chmodSync(join(p.inboxDir(), "receipts"), 0o500);
			const lost = await p.send("lost receipt", { timeoutMs: 600 });
			strictEqual(lost.status, "unconfirmed");
			chmodSync(join(p.inboxDir(), "receipts"), 0o700);
			const retried = await p.send("lost receipt", { requestId: lost.requestId ?? "" });
			strictEqual(retried.status, "accepted");
			strictEqual(p.turns.filter((text) => text === "lost receipt").length, 1);
		} finally {
			p.close();
		}
	});

	it("never delivers a prompt into a conversation other than the one its inbox was advertised for", async () => {
		const p = listeningPeer();
		// Advertised before any session exists; the first prompt creates it.
		const initial = p.peer.token ?? "";
		strictEqual((await p.send("first use")).status, "accepted");
		p.peer.sessionId = "A";
		strictEqual((await p.send("same conversation")).status, "accepted", "first-use creation is not a switch");

		// Two requests are already in the old inbox when the session is replaced.
		const pending = [p.send("for A, one", { token: initial }), p.send("for A, two", { token: initial })];
		p.switchSession("B");
		for (const result of await Promise.all(pending)) {
			strictEqual(result.status === "refused" ? result.reason : result.status, "stale-session");
		}
		// Back to A: the round trip does not revive the token that was advertised for it.
		p.switchSession("A");
		strictEqual(
			(await p.send("old token after the round trip", { token: initial, timeoutMs: 400 })).status,
			"not-delivered",
		);
		deepStrictEqual(p.turns, ["first use", "same conversation"]);
		strictEqual((await p.send("current token")).status, "accepted");

		p.close();
		strictEqual((await p.send("after quit", { token: initial })).status, "not-delivered");
	});

	it("never reaches an approval: blocked refuses, a busy peer queues a follow-up, and a declined turn is refused", async () => {
		const p = listeningPeer();
		try {
			p.phase("tool_blocked");
			const blocked = await p.send("yes");
			strictEqual(blocked.status === "refused" ? blocked.reason : blocked.status, "blocked");
			deepStrictEqual([p.turns, p.queued, p.shown], [[], [], []]);

			p.phase("waiting_model");
			p.peer.streaming = true;
			const busy = await p.send("when you are done");
			strictEqual(busy.status === "accepted" ? busy.via : busy.status, "queue");
			deepStrictEqual([p.turns, p.queued], [[], [{ text: "when you are done", origin: ORIGIN }]]);
		} finally {
			p.close();
		}
		// A submit that resolves without ever being admitted is a refusal, and nothing is painted.
		const declining = listeningPeer({ admit: false });
		try {
			const declined = await declining.send("not today");
			strictEqual(declined.status === "refused" ? declined.reason : declined.status, "not-admitted");
			deepStrictEqual(declining.shown, []);
		} finally {
			declining.close();
		}
	});

	it("survives malformed, linked and half-built entries without throwing or deleting a live peer", async () => {
		const p = listeningPeer();
		try {
			const requests = join(p.inboxDir(), "requests");
			const linked = "00000000-0000-4000-8000-000000000001";
			const garbage = "00000000-0000-4000-8000-000000000002";
			const looped = "00000000-0000-4000-8000-000000000003";
			symlinkSync("/etc/hostname", join(requests, linked));
			symlinkSync(looped, join(requests, looped));
			writeFileSync(join(requests, garbage), "{not json");
			// An inbox another Clio is still building, and one whose owner record is unreadable.
			const building = join(p.stateDir, "peer-inbox", "a".repeat(32));
			mkdirSync(join(building, "requests"), { recursive: true });
			strictEqual((await p.send("still works")).status, "accepted");
			deepStrictEqual(p.turns, ["still works"]);
			strictEqual(existsSync(building), true, "a directory with no owner record is not provably dead");
			// A second listener starting now sweeps, and must not erase the first.
			const other = listeningPeer({ stateDir: p.stateDir });
			other.close();
			strictEqual(existsSync(building), true, "startup sweep preserves an inbox with no owner record");
			strictEqual((await p.send("after a neighbour started and quit")).status, "accepted");
		} finally {
			p.close();
		}
	});
});
