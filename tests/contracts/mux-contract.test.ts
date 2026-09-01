/**
 * The `MuxContract` behavioral rules.
 *
 * The load-bearing ones: best-effort always, so no mux failure escapes as an
 * exception and a broken socket degrades to `available() === false`; every
 * Clio-created pane carries the `clio_owner` metadata token plus a `role`
 * token naming its purpose; the registry reconciles on `pane.closed` and
 * `pane.exited`; Clio refuses to close a pane it did not create; and
 * `adoptPane` re-claims exactly the panes a previous session tagged, in this
 * workspace, and nothing else. `none` mode is pinned to perform no socket
 * syscall at all.
 *
 * SA-3 adds one documented exception to the ownership rule: Clio's own hosting
 * pane, addressed through `HERDR_PANE_ID`, which `reportSelf` writes to.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import * as net from "node:net";
import { after, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createMuxRuntime, type MuxRuntime } from "../../src/domains/mux/contract.js";
import { detectMux } from "../../src/domains/mux/detect.js";
import { createMuxBundle } from "../../src/domains/mux/extension.js";
import type { MuxClient } from "../../src/domains/mux/socket-client.js";
import { createMuxClient } from "../../src/domains/mux/socket-client.js";
import { type FakeHerdrServer, startFakeHerdrServer, waitForCondition } from "../harness/fake-herdr-server.js";

const servers: FakeHerdrServer[] = [];
const runtimes: MuxRuntime[] = [];

interface GuestFixture {
	fake: FakeHerdrServer;
	runtime: MuxRuntime;
	client: MuxClient;
	/** Wall clock the runtime reads, so the degrade cooldown is deterministic. */
	advance(ms: number): void;
	/** Everything the runtime logged, so a degrade's level can be asserted. */
	logs(): ReadonlyArray<{ level: string; message: string }>;
}

async function guest(options: { selfPaneId?: string | null } = {}): Promise<GuestFixture> {
	const fake = await startFakeHerdrServer();
	servers.push(fake);
	const selfPaneId = options.selfPaneId === undefined ? "w1:p1" : options.selfPaneId;
	const detection = await detectMux({
		env: {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: fake.socketPath,
			HERDR_WORKSPACE_ID: "w1",
			HERDR_TAB_ID: "w1:t1",
			...(selfPaneId ? { HERDR_PANE_ID: selfPaneId } : {}),
		},
		openClient: (socketPath) =>
			createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500, backoff: BACKOFF }),
	});
	strictEqual(detection.detection.mode, "guest");
	const client = detection.client;
	ok(client);
	let clock = 1_000;
	const logged: Array<{ level: string; message: string }> = [];
	const runtime = createMuxRuntime({
		detection: detection.detection,
		client,
		now: () => clock,
		log: (level, message) => logged.push({ level, message }),
	});
	runtimes.push(runtime);
	await runtime.start();
	await waitForCondition(() => fake.subscriptionCount() === 1, "the lifecycle subscription");
	return {
		fake,
		runtime,
		client,
		advance(ms: number): void {
			clock += ms;
		},
		logs(): ReadonlyArray<{ level: string; message: string }> {
			return [...logged];
		},
	};
}

const BACKOFF = { initialDelayMs: 15, maxDelayMs: 60, factor: 2 };

after(async () => {
	for (const runtime of runtimes) await runtime.stop().catch(() => undefined);
	for (const fake of servers) await fake.stop().catch(() => undefined);
});

describe("mux contract in none mode", () => {
	it("answers every method without touching a socket", async () => {
		const original = net.Socket.prototype.connect;
		let attempts = 0;
		net.Socket.prototype.connect = function poisoned(): never {
			attempts += 1;
			throw new Error("none mode must not open a socket");
		} as unknown as typeof original;
		try {
			const { detection, client } = await detectMux({ env: {} });
			strictEqual(detection.mode, "none");
			strictEqual(client, null);
			const runtime = createMuxRuntime({ detection, client });
			await runtime.start();
			const mux = runtime.contract;

			strictEqual(mux.mode, "none");
			strictEqual(mux.available(), false);
			strictEqual(await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "shell" }), null);
			strictEqual(await mux.adoptPane({ purpose: "watch", label: "watch" }), null);
			strictEqual(await mux.closePane("w1:p2"), false);
			strictEqual(await mux.reportSelf({ state: "working" }), false);
			await mux.notify({ title: "done" });
			strictEqual(await mux.worktreeCreate({ cwd: "/repo", branch: "candidate", base: "HEAD", path: "/repo/wt" }), null);
			strictEqual(await mux.worktreeRemove("w2", { force: true }), false);
			deepStrictEqual([...mux.list()], []);
			await mux.shutdown();

			strictEqual(attempts, 0, "none mode performed a socket syscall");
		} finally {
			net.Socket.prototype.connect = original;
		}
	});
});

describe("mux contract in guest mode", () => {
	it("opens a utility pane beside Clio's own pane, tags it, and runs its argv", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		strictEqual(mux.available(), true);
		const ref = await mux.openUtilityPane({
			argv: ["yazi", "--cwd", "/some dir"],
			cwd: "/work",
			label: "files",
			title: "clio files",
			env: { CLIO_PANE: "1" },
		});
		ok(ref);
		const split = fake.requestsFor("pane.split")[0];
		strictEqual(split?.params.target_pane_id, "w1:p1", "utility panes split relative to Clio's own pane");
		strictEqual(split?.params.direction, "right");
		strictEqual(split?.params.focus, false, "opening a utility pane must not move focus off Clio");
		strictEqual(split?.params.cwd, "/work");
		deepStrictEqual(split?.params.env, { CLIO_PANE: "1" });
		deepStrictEqual(fake.requestsFor("pane.rename")[0]?.params, { pane_id: ref.paneId, label: "clio files" });

		const metadata = fake.requestsFor("pane.report_metadata")[0];
		strictEqual(metadata?.params.pane_id, ref.paneId);
		strictEqual(metadata?.params.source, "clio:mux");
		strictEqual(metadata?.params.title, "clio files");
		deepStrictEqual(metadata?.params.tokens, { clio_owner: "clio:mux", role: "utility" });

		const sent = fake.requestsFor("pane.send_text")[0];
		strictEqual(sent?.params.pane_id, ref.paneId);
		strictEqual(sent?.params.text, "exec 'yazi' '--cwd' '/some dir'\n");

		const record = mux.list()[0];
		strictEqual(record?.purpose, "utility");
		strictEqual(record?.label, "files");
	});

	it("tags a watch pane with its purpose so a later session can find it", async () => {
		const { fake, runtime } = await guest();
		const ref = await runtime.contract.openUtilityPane({
			argv: ["node", "/opt/clio/cli.js", "fleet", "view", "--watch", "/state/watch-selection"],
			cwd: "/work",
			label: "watch",
			purpose: "watch",
		});
		ok(ref);
		deepStrictEqual(fake.requestsFor("pane.report_metadata")[0]?.params.tokens, {
			clio_owner: "clio:mux",
			role: "watch",
		});
		strictEqual(runtime.contract.list()[0]?.purpose, "watch");
	});

	it("redirects utility stdout exactly once only when the caller names a path", async () => {
		const { fake, runtime } = await guest();
		await runtime.contract.openUtilityPane({
			argv: ["yazi", "--local-events", "cd,clio-pick"],
			cwd: "/work",
			label: "yazi",
			stdoutPath: "/cache/yazi/session one.stream",
		});
		strictEqual(
			fake.requestsFor("pane.send_text")[0]?.params.text,
			"exec 'yazi' '--local-events' 'cd,clio-pick' > '/cache/yazi/session one.stream'\n",
		);
		strictEqual((String(fake.requestsFor("pane.send_text")[0]?.params.text).match(/ > /g) ?? []).length, 1);

		await runtime.contract.openUtilityPane({ argv: ["bash", "-l"], cwd: "/work", label: "shell" });
		strictEqual(fake.requestsFor("pane.send_text")[1]?.params.text, "exec 'bash' '-l'\n");
	});

	it("closes a Clio-owned pane by id and refuses a foreign one", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const ref = await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "shell" });
		ok(ref);
		strictEqual(await mux.closePane("w1:p1"), false, "Clio's own hosting pane is not Clio's to close");
		strictEqual(fake.requestsFor("pane.close").length, 0);
		strictEqual(await mux.closePane(ref.paneId), true);
		strictEqual(fake.requestsFor("pane.close").length, 1);
		strictEqual(mux.list().length, 0);
	});

	it("reconciles the registry when a pane closes or exits behind Clio's back", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const first = await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "one" });
		const second = await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "two" });
		ok(first && second);
		strictEqual(mux.list().length, 2);

		fake.pushEvent("pane_closed", { paneId: first.paneId, workspaceId: "w1" });
		await waitForCondition(() => mux.list().length === 1, "the closed pane to leave the registry");
		strictEqual(mux.list()[0]?.label, "two");

		fake.pushEvent("pane_exited", { paneId: second.paneId, workspaceId: "w1" });
		await waitForCondition(() => mux.list().length === 0, "the exited pane to leave the registry");

		// Neither pane is Clio's to close any more, so nothing reaches the server.
		strictEqual(await mux.closePane(first.paneId), false);
		strictEqual(fake.requestsFor("pane.close").length, 0);
	});

	it("reports a pane leaving to its handlers, once, with the record that left", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const seen: string[] = [];
		const off = mux.onPaneGone((record) => {
			seen.push(record.label);
		});
		const ref = await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "one" });
		ok(ref);
		fake.pushEvent("pane_closed", { paneId: ref.paneId, workspaceId: ref.workspaceId });
		await waitForCondition(() => seen.length === 1, "the pane-gone handler");
		deepStrictEqual(seen, ["one"]);
		off();
		const second = await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "two" });
		ok(second);
		fake.pushEvent("pane_closed", { paneId: second.paneId, workspaceId: second.workspaceId });
		await waitForCondition(() => mux.list().length === 0, "the registry to drop the second pane");
		deepStrictEqual(seen, ["one"], "an unsubscribed handler stops hearing");
	});

	it("reports Clio's own pane state through HERDR_PANE_ID", async () => {
		const { fake, runtime } = await guest();
		strictEqual(
			await runtime.contract.reportSelf({
				state: "blocked",
				message: "waiting on approval",
				tokens: { phase: "approval" },
				stateLabels: { blocked: "needs approval" },
				ttlMs: 30_000,
			}),
			true,
		);
		const agent = fake.requestsFor("pane.report_agent").at(-1);
		strictEqual(agent?.params.pane_id, "w1:p1");
		strictEqual(agent?.params.source, "clio:coder");
		strictEqual(agent?.params.agent, "clio-coder");
		strictEqual(agent?.params.state, "blocked");
		strictEqual(agent?.params.message, "waiting on approval");
		const metadata = fake.requestsFor("pane.report_metadata").at(-1);
		strictEqual(metadata?.params.pane_id, "w1:p1");
		deepStrictEqual(metadata?.params.tokens, { phase: "approval" });
		deepStrictEqual(metadata?.params.state_labels, { blocked: "needs approval" });
		strictEqual(metadata?.params.ttl_ms, 30_000);
	});

	it("declines to self-report when there is no HERDR_PANE_ID to report on", async () => {
		const { fake, runtime } = await guest({ selfPaneId: null });
		strictEqual(await runtime.contract.reportSelf({ state: "working" }), false);
		strictEqual(fake.requestsFor("pane.report_agent").length, 0);
	});

	it("swallows a server-side failure and keeps the socket usable", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		fake.setHandler("pane.split", () => ({ error: { code: "pane_split_failed", message: "no room" } }));
		strictEqual(await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "shell" }), null);
		// A server-side refusal is not a transport failure, so the mux stays available.
		strictEqual(mux.available(), true);

		fake.setHandler("pane.split", null);
		ok(await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "shell" }));
	});

	it("degrades to unavailable when the socket dies, and probes again after the cooldown", async () => {
		const fixture = await guest();
		const mux = fixture.runtime.contract;
		strictEqual(mux.available(), true);
		await fixture.fake.stop();

		strictEqual(await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "shell" }), null);
		strictEqual(mux.available(), false, "a dead socket degrades the contract rather than throwing");

		fixture.advance(5_000);
		strictEqual(mux.available(), true, "the contract probes again once the cooldown lapses");
	});

	it("tears down sockets on shutdown without closing or forgetting owned panes", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const ref = await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "shell" });
		ok(ref);
		await mux.shutdown();
		strictEqual(mux.available(), false);
		strictEqual(mux.list().length, 1, "shutdown keeps the ownership snapshot; panes are durable");
		ok(
			fake.panes().some((pane) => pane.paneId === ref.paneId),
			"the pane remains on the server",
		);
		strictEqual(fake.requestsFor("pane.close").length, 0, "shutdown must never issue pane.close");
		const splitsBefore = fake.requestsFor("pane.split").length;
		strictEqual(await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "again" }), null);
		strictEqual(fake.requestsFor("pane.split").length, splitsBefore);
	});
});

describe("mux pane adoption", () => {
	it("adopts exactly the surviving pane that carries the owner token and matching role", async () => {
		const fake = await startFakeHerdrServer({
			panes: [
				{ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
				{ paneId: "w1:p9", tabId: "w1:t1", workspaceId: "w1" },
				{ paneId: "w1:p8", tabId: "w1:t1", workspaceId: "w1" },
			],
		});
		servers.push(fake);
		// The pane a previous process opened still carries Clio's owner token and
		// its purpose; a foreign pane carries neither.
		fake.setTokens("w1:p9", { clio_owner: "clio:mux", role: "watch" });
		fake.setTokens("w1:p8", { role: "watch" });
		const detection = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			openClient: (socketPath) => createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500 }),
		});
		ok(detection.client);
		const runtime = createMuxRuntime({ detection: detection.detection, client: detection.client });
		runtimes.push(runtime);
		const mux = runtime.contract;

		const adopted = await mux.adoptPane({ purpose: "watch", label: "watch" });
		strictEqual(adopted?.paneId, "w1:p9", "only a pane carrying Clio's owner token is Clio's to adopt");
		strictEqual(mux.list().length, 1);
		strictEqual(mux.list()[0]?.adopted, true);

		// A second adopt answers from the registry rather than re-scanning.
		const snapshotsBefore = fake.requestsFor("session.snapshot").length;
		const again = await mux.adoptPane({ purpose: "watch", label: "watch" });
		strictEqual(again?.paneId, "w1:p9");
		strictEqual(fake.requestsFor("session.snapshot").length, snapshotsBefore);
	});

	it("never adopts a pane from another workspace", async () => {
		const fake = await startFakeHerdrServer({
			panes: [
				{ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
				{ paneId: "w2:p5", tabId: "w2:t1", workspaceId: "w2" },
			],
		});
		servers.push(fake);
		// Another session's watch pane in another workspace carries the same
		// tokens; adopting it would retarget a surface this operator cannot see.
		fake.setTokens("w2:p5", { clio_owner: "clio:mux", role: "watch" });
		const detection = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			openClient: (socketPath) => createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500 }),
		});
		ok(detection.client);
		const runtime = createMuxRuntime({ detection: detection.detection, client: detection.client });
		runtimes.push(runtime);
		strictEqual(await runtime.contract.adoptPane({ purpose: "watch", label: "watch" }), null);
		strictEqual(runtime.contract.list().length, 0);
	});
});

describe("mux gated wire surfaces", () => {
	it("round-trips the protocol-10 worktree lifecycle through the typed client", async () => {
		const { fake, client } = await guest();
		const created = await client.worktreeCreate({
			cwd: "/repo",
			branch: "clio/compete/group/1",
			base: "HEAD",
			path: "/repo/.clio-coder/worktrees/group/candidate-1",
			label: "candidate one",
			focus: false,
		});
		strictEqual(created.workspaceId, "w2");
		strictEqual(created.worktree.branch, "clio/compete/group/1");
		strictEqual(created.worktree.path, "/repo/.clio-coder/worktrees/group/candidate-1");
		strictEqual(created.rootPane.workspaceId, "w2");

		const listed = await client.worktreeList({ cwd: "/repo" });
		strictEqual(listed.source.repoRoot, "/repo");
		strictEqual(listed.worktrees.length, 1);
		strictEqual(listed.worktrees[0]?.openWorkspaceId, "w2");

		const opened = await client.worktreeOpen({ path: created.worktree.path, focus: false });
		strictEqual(opened.alreadyOpen, true);
		strictEqual(opened.workspaceId, created.workspaceId);

		const removed = await client.worktreeRemove(created.workspaceId, { force: true });
		strictEqual(removed.path, created.worktree.path);
		strictEqual(removed.forced, true);
		strictEqual(fake.worktrees().length, 0);
		deepStrictEqual(
			fake.requestsFor("worktree.create")[0]?.params,
			{
				cwd: "/repo",
				branch: "clio/compete/group/1",
				base: "HEAD",
				path: "/repo/.clio-coder/worktrees/group/candidate-1",
				label: "candidate one",
				focus: false,
			},
			"the 0.8.2-only trust_repository option stays absent for 0.7.5 compatibility",
		);
	});

	it("gates worktree mutation below protocol 10", async () => {
		const fake = await startFakeHerdrServer({ protocol: 9, version: "0.3.0" });
		servers.push(fake);
		const detection = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: "w1" },
			openClient: (socketPath) => createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500 }),
		});
		ok(detection.client);
		const runtime = createMuxRuntime({ detection: detection.detection, client: detection.client });
		runtimes.push(runtime);
		strictEqual(
			await runtime.contract.worktreeCreate({ cwd: "/repo", branch: "candidate", base: "HEAD", path: "/repo/wt" }),
			null,
		);
		strictEqual(await runtime.contract.worktreeRemove("w2", { force: true }), false);
		strictEqual(fake.requestsFor("worktree.create").length, 0);
		strictEqual(fake.requestsFor("worktree.remove").length, 0);
	});

	it("skips notification.show on a server below its protocol floor", async () => {
		const fake = await startFakeHerdrServer({ protocol: 16, version: "0.6.0" });
		servers.push(fake);
		const detection = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			openClient: (socketPath) => createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500 }),
		});
		ok(detection.client);
		const runtime = createMuxRuntime({ detection: detection.detection, client: detection.client });
		runtimes.push(runtime);
		await runtime.contract.notify({ title: "done" });
		strictEqual(fake.requestsFor("notification.show").length, 0, "a gated method is not attempted below its floor");
	});

	it("skips pane.rename below protocol 17 without refusing the utility pane", async () => {
		const fake = await startFakeHerdrServer({ protocol: 16, version: "0.6.0" });
		servers.push(fake);
		const detection = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			openClient: (socketPath) => createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500 }),
		});
		ok(detection.client);
		const runtime = createMuxRuntime({ detection: detection.detection, client: detection.client });
		runtimes.push(runtime);
		const opened = await runtime.contract.openUtilityPane({
			argv: ["bash"],
			cwd: "/work",
			label: "watch",
			title: "clio watch",
		});
		ok(opened);
		strictEqual(fake.requestsFor("pane.rename").length, 0, "a gated method is not attempted below its floor");
		strictEqual(fake.requestsFor("pane.report_metadata")[0]?.params.title, undefined);
	});

	it("shows a toast, and accepts a suppressed one without degrading", async () => {
		const { fake, runtime } = await guest();
		await runtime.contract.notify({ title: "tester failed", body: "exit 1", sound: "request" });
		const shown = fake.notifications().at(-1);
		strictEqual(shown?.title, "tester failed");
		strictEqual(shown?.body, "exit 1");
		strictEqual(shown?.sound, "request");

		const quiet = await startFakeHerdrServer({ toastsShown: false });
		servers.push(quiet);
		const detection = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: quiet.socketPath, HERDR_WORKSPACE_ID: "w1" },
			openClient: (socketPath) => createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500 }),
		});
		ok(detection.client);
		const quietRuntime = createMuxRuntime({ detection: detection.detection, client: detection.client });
		runtimes.push(quietRuntime);
		await quietRuntime.contract.notify({ title: "suppressed" });
		strictEqual(quiet.notifications().length, 1, "the call still went out");
		strictEqual(quietRuntime.contract.available(), true, "shown:false is an answer, not a failure");
	});

	// The toast path shipped with its failure side never driven against a live
	// host. Verified since against herdr 0.8.2 on a real socket: a malformed
	// request comes back `invalid request: unknown variant ...` and leaves the
	// layer usable, while a closed client throws a transport error that degrades
	// it. These pin both halves so the fixture keeps matching the wire.
	it("swallows a refused toast without degrading the pane layer", async () => {
		const { fake, runtime, logs } = await guest();
		fake.setHandler("notification.show", () => ({
			error: { code: "invalid_request", message: "unknown variant `chime`, expected one of `none`, `done`" },
		}));

		// The call must not throw: a dispatch's terminal event drives it, and a
		// rejected toast can never be allowed to fail the run that earned it.
		await runtime.contract.notify({ title: "tester failed", body: "exit 1", sound: "request" });

		// A server that answered is a server that is there. Degrading on a refused
		// method would take panes away over a request herdr simply did not like.
		strictEqual(runtime.contract.available(), true, "a refused method is not a dead transport");
		strictEqual(fake.requestsFor("notification.show").length, 1, "the call reached the server");
		strictEqual(
			logs().some((line) => line.level === "warning"),
			false,
			"a refused toast is the operator's business, not a warning about Clio's health",
		);

		// The layer still works for everything else.
		fake.setHandler("notification.show", null);
		await runtime.contract.notify({ title: "next one" });
		strictEqual(fake.notifications().at(-1)?.title, "next one");
	});

	it("degrades once on a dead socket, then probes again after the cooldown", async () => {
		const { fake, runtime, advance, logs } = await guest();
		fake.dropConnections();
		await fake.stop();

		await runtime.contract.notify({ title: "tester failed", sound: "request" });
		strictEqual(runtime.contract.available(), false, "a dead transport degrades the layer");
		const warnings = logs().filter((line) => line.level === "warning");
		strictEqual(warnings.length, 1, JSON.stringify(logs()));
		ok(warnings[0]?.message.startsWith("mux notify failed:"), warnings[0]?.message);

		// Inside the cooldown the layer stays down and opens no socket at all.
		await runtime.contract.notify({ title: "second" });
		strictEqual(logs().filter((line) => line.level === "warning").length, 1, "the cooldown silences the retry");

		// Past it, the next call is allowed to try again rather than staying dark
		// forever on one bad moment.
		advance(5_001);
		strictEqual(runtime.contract.available(), true, "the cooldown expires into a probe, not a permanent refusal");
		await runtime.contract.notify({ title: "third" });
		strictEqual(runtime.contract.available(), false, "a probe that failed degrades again");
	});
});

describe("contracts/mux boot logging", () => {
	// The refusal has to reach the operator, and `warning` is the only level the
	// orchestrator routes to boot stderr (src/entry/orchestrator.ts). Logging the
	// embedded degrade at debug is what made it silent.
	it("logs a refused rung at warning and an ordinary none at debug", async () => {
		const refusedLines: Array<{ level: string; message: string }> = [];
		const refused = await createMuxBundle({} as DomainContext, {
			enabled: "embedded",
			env: { HERDR_ENV: "1" },
			log: (level, message) => refusedLines.push({ level, message }),
		});
		await refused.extension.stop?.();
		const warned = refusedLines.filter((line) => line.level === "warning");
		strictEqual(warned.length, 1, JSON.stringify(refusedLines));
		ok(warned[0]?.message.includes("panes refused"), warned[0]?.message);
		ok(warned[0]?.message.includes("phase 5"), warned[0]?.message);

		const quietLines: Array<{ level: string; message: string }> = [];
		const quiet = await createMuxBundle({} as DomainContext, {
			enabled: "auto",
			env: {},
			log: (level, message) => quietLines.push({ level, message }),
		});
		await quiet.extension.stop?.();
		strictEqual(
			quietLines.some((line) => line.level === "warning"),
			false,
			"a machine with no pane host never asked for one",
		);
	});
});
