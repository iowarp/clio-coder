/**
 * The mux socket client and the capability ladder it sits under.
 *
 * What is pinned here is the behavior spec 4.2 and 4.3 make load-bearing: the
 * three-condition guest ladder, a `none` mode that opens no socket at all, a
 * per-request timeout that surfaces as `MuxRequestTimeout`, error codes mapped
 * to typed kinds with unknown codes passed through intact, tolerance for
 * response fields we do not know about, and a dropped event stream that
 * reconnects and re-bootstraps from `session.snapshot` rather than pretending
 * it saw the events it missed.
 *
 * The fake server's response shapes come from `herdr api schema --json`, so a
 * herdr protocol bump that changes a shape fails here instead of in a session.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { detectMux, resolveSocketCandidates } from "../../src/domains/mux/detect.js";
import { createMuxClient, type MuxClient } from "../../src/domains/mux/socket-client.js";
import { MuxError, type MuxEvent, MuxRequestTimeout } from "../../src/domains/mux/types.js";
import { type FakeHerdrServer, startFakeHerdrServer, waitForCondition } from "../harness/fake-herdr-server.js";

const servers: FakeHerdrServer[] = [];
const clients: MuxClient[] = [];
const scratchDirs: string[] = [];

async function server(options?: Parameters<typeof startFakeHerdrServer>[0]): Promise<FakeHerdrServer> {
	const created = await startFakeHerdrServer(options);
	servers.push(created);
	return created;
}

function client(socketPath: string, options: { requestTimeoutMs?: number } = {}): MuxClient {
	const created = createMuxClient({
		socketPath,
		requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
		connectTimeoutMs: 500,
		backoff: { initialDelayMs: 15, maxDelayMs: 60, factor: 2 },
	});
	clients.push(created);
	return created;
}

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-mux-detect-"));
	scratchDirs.push(dir);
	return dir;
}

/**
 * Makes every path through `node:net` throw for the duration of `run`.
 *
 * `net.connect` builds a `Socket` and calls `Socket.prototype.connect`, so
 * poisoning the prototype method catches any connection attempt regardless of
 * which entry point reaches for it.
 */
async function withNetworkPoisoned<T>(run: () => Promise<T>): Promise<T> {
	const original = net.Socket.prototype.connect;
	let attempts = 0;
	net.Socket.prototype.connect = function poisoned(): never {
		attempts += 1;
		throw new Error("socket syscall attempted");
	} as unknown as typeof original;
	try {
		const value = await run();
		strictEqual(attempts, 0, "expected zero socket connect attempts");
		return value;
	} finally {
		net.Socket.prototype.connect = original;
	}
}

after(async () => {
	for (const created of clients) await created.close().catch(() => undefined);
	for (const created of servers) await created.stop().catch(() => undefined);
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("mux detection ladder", () => {
	it("resolves socket candidates in the order spec 4.2 fixes", () => {
		deepStrictEqual(
			[
				...resolveSocketCandidates({
					HERDR_SOCKET_PATH: "/run/explicit.sock",
					HERDR_SESSION: "work",
					XDG_CONFIG_HOME: "/cfg",
				}),
			],
			["/run/explicit.sock", "/cfg/herdr/sessions/work/herdr.sock", "/cfg/herdr/herdr.sock"],
		);
		deepStrictEqual([...resolveSocketCandidates({ XDG_CONFIG_HOME: "/cfg" })], ["/cfg/herdr/herdr.sock"]);
	});

	it("resolves to none and opens no socket when HERDR_ENV is not 1", async () => {
		const opened: string[] = [];
		const result = await withNetworkPoisoned(async () =>
			detectMux({
				env: { HERDR_SOCKET_PATH: "/run/should-never-be-touched.sock" },
				openClient: (socketPath) => {
					opened.push(socketPath);
					throw new Error("detection must not open a client in none mode");
				},
			}),
		);
		strictEqual(result.detection.mode, "none");
		strictEqual(result.client, null);
		strictEqual(opened.length, 0);
		ok(result.detection.reason.includes("HERDR_ENV"));
	});

	it("resolves to none when panes are turned off, again with no socket", async () => {
		const result = await withNetworkPoisoned(async () =>
			detectMux({ enabled: "off", env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/x.sock" } }),
		);
		strictEqual(result.detection.mode, "none");
		ok(result.detection.reason.includes("turned off"));
	});

	it("degrades embedded mode to none until phase 5 lands it", async () => {
		const result = await withNetworkPoisoned(async () => detectMux({ enabled: "embedded", env: { HERDR_ENV: "1" } }));
		strictEqual(result.detection.mode, "none");
		ok(result.detection.reason.includes("phase 5"));
	});

	it("reaches guest mode through a connectable socket and records the server protocol", async () => {
		const fake = await server({ version: "0.7.5", protocol: 17 });
		const result = await detectMux({
			env: {
				HERDR_ENV: "1",
				// Pinned so the ladder can never fall through to a herdr the
				// developer running the suite happens to have open.
				XDG_CONFIG_HOME: scratchDir(),
				HERDR_SOCKET_PATH: fake.socketPath,
				HERDR_WORKSPACE_ID: "w1",
				HERDR_TAB_ID: "w1:t1",
				HERDR_PANE_ID: "w1:p1",
			},
		});
		if (result.client) clients.push(result.client);
		strictEqual(result.detection.mode, "guest");
		strictEqual(result.detection.socketPath, fake.socketPath);
		deepStrictEqual(result.detection.server, { version: "0.7.5", protocol: 17 });
		deepStrictEqual(result.detection.self, { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" });
		strictEqual(fake.requestsFor("ping").length, 1);
	});

	it("falls through a dead candidate to the next one in the ladder", async () => {
		const fake = await server();
		const dir = scratchDir();
		const result = await detectMux({
			env: {
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: join(dir, "missing.sock"),
				XDG_CONFIG_HOME: dir,
			},
			pingTimeoutMs: 300,
			openClient: (socketPath) =>
				// The last candidate resolves to the live fake server; everything before
				// it stays a real (and absent) path so the connect genuinely fails.
				client(socketPath === join(dir, "herdr", "herdr.sock") ? fake.socketPath : socketPath),
		});
		strictEqual(result.detection.mode, "guest");
		strictEqual(result.detection.socketPath, join(dir, "herdr", "herdr.sock"));
		deepStrictEqual([...result.detection.candidates], [join(dir, "missing.sock"), join(dir, "herdr", "herdr.sock")]);
	});

	it("stays in none mode when no candidate answers a ping", async () => {
		const dir = scratchDir();
		const result = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "nope.sock"), XDG_CONFIG_HOME: dir },
			pingTimeoutMs: 300,
		});
		strictEqual(result.detection.mode, "none");
		strictEqual(result.client, null);
		ok(result.detection.reason.startsWith("no herdr socket answered a ping"));
	});

	it("refuses a socket that connects but never answers the ping inside the budget", async () => {
		const fake = await server();
		fake.setHandler("ping", () => ({ hang: true }));
		const result = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, XDG_CONFIG_HOME: scratchDir() },
			pingTimeoutMs: 120,
		});
		strictEqual(result.detection.mode, "none");
		strictEqual(result.client, null);
	});
});

describe("mux socket client", () => {
	it("round-trips the phase 1 wire surface", async () => {
		const fake = await server();
		const live = client(fake.socketPath);

		deepStrictEqual(await live.ping(), { version: "0.7.5", protocol: 17 });

		const snapshot = await live.snapshot();
		strictEqual(snapshot.server.protocol, 17);
		strictEqual(snapshot.panes.length, 1);
		strictEqual(snapshot.panes[0]?.paneId, "w1:p1");
		strictEqual(snapshot.focusedPaneId, "w1:p1");

		strictEqual((await live.paneCurrent()).paneId, "w1:p1");
		strictEqual((await live.paneGet("w1:p1")).tabId, "w1:t1");
		strictEqual((await live.paneList()).length, 1);

		const created = await live.tabCreate({ label: "Fleet", focus: false });
		strictEqual(created.tab.label, "Fleet");
		strictEqual(created.rootPane.tabId, created.tab.tabId);
		ok((await live.tabList()).some((tab) => tab.label === "Fleet"));
		strictEqual((await live.tabFocus(created.tab.tabId)).tabId, created.tab.tabId);

		const split = await live.paneSplit({ direction: "down", targetPaneId: created.rootPane.paneId, focus: false });
		strictEqual(split.tabId, created.tab.tabId);
		ok((await live.paneLayout(split.paneId)).includes(split.paneId));

		await live.paneSendText(split.paneId, "echo hi\n");
		await live.paneReportAgent({ paneId: split.paneId, source: "clio:mux", agent: "tester", state: "working" });
		await live.paneReportMetadata({ paneId: split.paneId, source: "clio:mux", tokens: { clio_owner: "clio:mux" } });
		await live.paneClose(split.paneId);
		strictEqual(
			fake.panes().some((pane) => pane.paneId === split.paneId),
			false,
		);

		// A split with no focus request must not ask herdr to steal focus.
		strictEqual(fake.requestsFor("pane.split")[0]?.params.focus, false);
		strictEqual(fake.requestsFor("tab.create")[0]?.params.focus, false);
	});

	it("surfaces a request with no response as MuxRequestTimeout", async () => {
		const fake = await server();
		const live = client(fake.socketPath, { requestTimeoutMs: 80 });
		fake.setHandler("pane.list", () => ({ hang: true }));
		await rejects(
			() => live.paneList(),
			(error: unknown) => {
				ok(error instanceof MuxRequestTimeout);
				strictEqual(error.kind, "timeout");
				strictEqual(error.timeoutMs, 80);
				strictEqual(error.method, "pane.list");
				return true;
			},
		);
		// The connection survives a timeout: the next call still resolves.
		fake.setHandler("pane.list", null);
		strictEqual((await live.paneList()).length, 1);
	});

	it("maps server error codes onto typed kinds and passes unknown codes through", async () => {
		const fake = await server();
		const live = client(fake.socketPath);
		const cases: ReadonlyArray<[string, string]> = [
			["pane_not_found", "not_found"],
			["tab_not_found", "not_found"],
			["not_found", "not_found"],
			["invalid_params", "invalid_params"],
			["invalid_metadata_token", "invalid_params"],
			["agent_blocked", "agent_blocked"],
			["feature_disabled", "feature_disabled"],
			["agent_prompt_stalled", "agent_prompt_stalled"],
			["some_future_herdr_code", "unknown"],
		];
		for (const [wireCode, kind] of cases) {
			fake.setHandler("pane.get", () => ({ error: { code: wireCode, message: `boom: ${wireCode}` } }));
			await rejects(
				() => live.paneGet("w1:p1"),
				(error: unknown) => {
					ok(error instanceof MuxError, `${wireCode} should raise MuxError`);
					strictEqual(error.kind, kind, `${wireCode} should map to ${kind}`);
					strictEqual(error.wireCode, wireCode);
					strictEqual(error.method, "pane.get");
					return true;
				},
			);
		}
	});

	it("ignores response fields it does not know about", async () => {
		const fake = await server();
		const live = client(fake.socketPath);
		fake.setHandler("pane.get", () => ({
			result: {
				type: "pane_info",
				future_top_level_field: { anything: true },
				pane: {
					pane_id: "w1:p1",
					terminal_id: "term_1",
					workspace_id: "w1",
					tab_id: "w1:t1",
					focused: true,
					agent_status: "working",
					revision: 9,
					tokens: { clio_owner: "clio:mux", dropped: 12 },
					future_pane_field: ["ignored"],
				},
			},
		}));
		const pane = await live.paneGet("w1:p1");
		strictEqual(pane.paneId, "w1:p1");
		strictEqual(pane.agentState, "working");
		strictEqual(pane.revision, 9);
		// Non-string token values are dropped rather than coerced.
		deepStrictEqual({ ...pane.tokens }, { clio_owner: "clio:mux" });
	});

	it("maps an agent status it has never seen to unknown", async () => {
		const fake = await server();
		const live = client(fake.socketPath);
		fake.setHandler("pane.get", () => ({
			result: {
				type: "pane_info",
				pane: {
					pane_id: "w1:p1",
					terminal_id: "term_1",
					workspace_id: "w1",
					tab_id: "w1:t1",
					focused: false,
					agent_status: "hibernating",
					revision: 1,
				},
			},
		}));
		strictEqual((await live.paneGet("w1:p1")).agentState, "unknown");
	});

	it("delivers pushed lifecycle events on a dedicated connection", async () => {
		const fake = await server();
		const live = client(fake.socketPath);
		const seen: MuxEvent[] = [];
		const subscription = await live.subscribe(["pane.closed", "pane.exited"], (event) => seen.push(event));

		await waitForCondition(() => fake.subscriptionCount() === 1, "the subscription to be acknowledged");
		// Requests go over their own connection, not the subscription's.
		await live.ping();
		const subscribeConnection = fake.requestsFor("events.subscribe")[0]?.connectionId;
		const pingConnection = fake.requestsFor("ping").at(-1)?.connectionId;
		ok(subscribeConnection !== undefined && pingConnection !== undefined);
		ok(subscribeConnection !== pingConnection, "the event stream must not share the request connection");

		fake.pushEvent("pane_closed", { paneId: "w1:p9", workspaceId: "w1" });
		fake.pushEvent("pane_exited", { paneId: "w1:p8", workspaceId: "w1" });
		await waitForCondition(() => seen.length === 2, "both pushed events");
		deepStrictEqual(seen, [
			{ kind: "pane.closed", paneId: "w1:p9", workspaceId: "w1" },
			{ kind: "pane.exited", paneId: "w1:p8", workspaceId: "w1" },
		]);
		subscription.close();
	});

	it("reconnects a dropped event stream and re-bootstraps from session.snapshot", async () => {
		const fake = await server();
		const live = client(fake.socketPath);
		const seen: MuxEvent[] = [];
		const resyncs: number[] = [];
		const subscription = await live.subscribe(["pane.closed", "pane.exited"], (event) => seen.push(event), {
			onResync: (snapshot) => resyncs.push(snapshot.panes.length),
		});
		await waitForCondition(() => fake.subscriptionCount() === 1, "the first subscription");
		const snapshotsBefore = fake.requestsFor("session.snapshot").length;

		// A herdr server killed out from under Clio takes every connection with it.
		fake.addPane({ paneId: "w1:p7", tabId: "w1:t1", workspaceId: "w1" });
		fake.dropConnections();

		await waitForCondition(() => fake.subscriptionCount() === 1, "the stream to resubscribe");
		await waitForCondition(
			() => fake.requestsFor("session.snapshot").length > snapshotsBefore,
			"a snapshot re-bootstrap after reconnect",
		);
		await waitForCondition(() => resyncs.length === 1, "the resync callback");
		strictEqual(resyncs[0], 2, "the re-bootstrap snapshot carries the pane added while the socket was down");
		strictEqual(live.cachedSnapshot()?.panes.length, 2);

		// Events flow again on the new connection.
		fake.pushEvent("pane_closed", { paneId: "w1:p7", workspaceId: "w1" });
		await waitForCondition(() => seen.length === 1, "an event on the reconnected stream");
		subscription.close();
	});

	it("fails pending requests when the connection drops, then reconnects on the next call", async () => {
		const fake = await server();
		const live = client(fake.socketPath, { requestTimeoutMs: 2_000 });
		fake.setHandler("pane.list", () => ({ hang: true }));
		const inflight = live.paneList();
		await waitForCondition(() => fake.requestsFor("pane.list").length === 1, "the request to reach the server");
		fake.dropConnections();
		await rejects(
			() => inflight,
			(error: unknown) => {
				ok(error instanceof MuxError);
				strictEqual(error.kind, "transport");
				return true;
			},
		);
		strictEqual(live.connected(), false);
		fake.setHandler("pane.list", null);
		strictEqual((await live.paneList()).length, 1);
		strictEqual(live.connected(), true);
	});

	it("holds off reconnect attempts with capped backoff after a failed connect", async () => {
		const dir = scratchDir();
		const live = client(join(dir, "absent.sock"));
		await rejects(() => live.ping());
		// The second call is refused from the backoff gate rather than hammering
		// the socket path again.
		await rejects(
			() => live.ping(),
			(error: unknown) => {
				ok(error instanceof MuxError);
				strictEqual(error.kind, "transport");
				ok(error.message.includes("backoff"));
				return true;
			},
		);
	});
});
