/**
 * The `MuxContract` behavioral rules from spec 4.4.
 *
 * The load-bearing ones: best-effort always, so no mux failure escapes as an
 * exception and a broken socket degrades to `available() === false`; the Fleet
 * tab is created once, cached, and re-resolved when the user closes it;
 * `openRunPane` is idempotent per run id; every Clio-created pane carries the
 * `clio_owner` metadata token; the registry reconciles on `pane.closed` and
 * `pane.exited`; and Clio refuses to close, focus, or report state on a pane it
 * did not create. `none` mode is pinned to perform no socket syscall at all.
 *
 * SA-3 adds one documented exception to the ownership rule: Clio's own hosting
 * pane, addressed through `HERDR_PANE_ID`, which `reportSelf` writes to.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import * as net from "node:net";
import { after, describe, it } from "node:test";
import { createMuxRuntime, type MuxRuntime } from "../../src/domains/mux/contract.js";
import { detectMux } from "../../src/domains/mux/detect.js";
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
}

async function guest(
	options: {
		selfPaneId?: string | null;
		viewerCommand?: (request: { runId: string; agentId: string; label: string }) => ReadonlyArray<string> | null;
	} = {},
): Promise<GuestFixture> {
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
	const runtime = createMuxRuntime({
		detection: detection.detection,
		client,
		cwd: "/work",
		now: () => clock,
		...(options.viewerCommand ? { viewerCommand: options.viewerCommand } : {}),
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
			strictEqual(await mux.openRunPane({ runId: "r1", agentId: "tester", label: "run tests" }), null);
			strictEqual(await mux.focusRunPane("r1"), false);
			strictEqual(await mux.openUtilityPane({ argv: ["bash"], cwd: "/work", label: "shell" }), null);
			strictEqual(await mux.reportSelf({ state: "working" }), false);
			await mux.closeRunPane("r1");
			await mux.reportRunState("r1", { phase: "planning", agentState: "working" });
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
	it("opens a run pane in a Fleet tab, tags it, and reports its state", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		strictEqual(mux.available(), true);

		const ref = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "run the suite" });
		ok(ref);

		const created = fake.requestsFor("tab.create");
		strictEqual(created.length, 1);
		strictEqual(created[0]?.params.label, "Fleet");
		strictEqual(created[0]?.params.workspace_id, "w1");
		strictEqual(created[0]?.params.focus, false, "the Fleet tab must open unfocused");

		const metadata = fake.requestsFor("pane.report_metadata");
		strictEqual(metadata.length, 1);
		strictEqual(metadata[0]?.params.pane_id, ref.paneId);
		strictEqual(metadata[0]?.params.source, "clio:mux");
		deepStrictEqual(metadata[0]?.params.tokens, { clio_owner: "clio:mux", role: "tester", run: "run-1" });

		const agent = fake.requestsFor("pane.report_agent");
		strictEqual(agent.length, 1);
		strictEqual(agent[0]?.params.source, "clio:dispatch");
		strictEqual(agent[0]?.params.agent, "tester");
		strictEqual(agent[0]?.params.state, "working");

		const inventory = mux.list();
		strictEqual(inventory.length, 1);
		strictEqual(inventory[0]?.purpose, "run");
		strictEqual(inventory[0]?.runId, "run-1");
	});

	it("returns the existing ref for a run that already has a pane", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const first = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		const second = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		deepStrictEqual(first, second);
		strictEqual(fake.requestsFor("tab.create").length, 1);
		strictEqual(fake.requestsFor("pane.split").length, 0, "the second call must not create a pane");
		strictEqual(mux.list().length, 1);
	});

	it("stacks later run panes in the Fleet tab without stealing focus", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const first = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		const second = await mux.openRunPane({ runId: "run-2", agentId: "fixer", label: "two" });
		ok(first && second);
		strictEqual(first.tabId, second.tabId);
		strictEqual(fake.requestsFor("tab.create").length, 1, "the Fleet tab id is cached across runs");
		const split = fake.requestsFor("pane.split");
		strictEqual(split.length, 1);
		strictEqual(split[0]?.params.focus, false);
		strictEqual(split[0]?.params.target_pane_id, first.paneId);
	});

	it("re-resolves the Fleet tab when the user closed it", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const first = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		ok(first);
		// The user closes the whole tab behind Clio's back.
		fake.removePane(first.paneId);
		fake.setHandler("tab.list", () => ({
			result: { type: "tab_list", tabs: [] },
		}));
		const second = await mux.openRunPane({ runId: "run-2", agentId: "fixer", label: "two" });
		ok(second);
		strictEqual(fake.requestsFor("tab.create").length, 2, "a closed Fleet tab is rebuilt, not reused");
		ok(second.tabId !== first.tabId);
	});

	it("focuses a run pane through agent.focus and refuses runs it does not own", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const ref = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		ok(ref);
		strictEqual(await mux.focusRunPane("run-1"), true);
		// agent.focus is the preferred rung: it resolves for the viewer pane
		// precisely because openRunPane gave that pane agent authority, and it
		// additionally clears herdr's attention state.
		strictEqual(fake.requestsFor("agent.focus").length, 1);
		strictEqual(fake.requestsFor("agent.focus")[0]?.params.target, ref.paneId);
		strictEqual(fake.focusedPane(), ref.paneId);
		strictEqual(fake.focusedTab(), ref.tabId);
		strictEqual(fake.requestsFor("tab.focus").length, 1, "the shared ladder always reconciles the tab dimension");

		strictEqual(await mux.focusRunPane("a-run-clio-never-opened"), false);
		strictEqual(fake.requestsFor("agent.focus").length, 1, "an unowned run must not reach the server");
	});

	it("never closes, or reports state on, a pane Clio did not create", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		const metadataBefore = fake.requestsFor("pane.report_metadata").length;
		const agentBefore = fake.requestsFor("pane.report_agent").length;

		await mux.closeRunPane("someone-elses-run");
		await mux.reportRunState("someone-elses-run", { phase: "planning", agentState: "working" });

		strictEqual(fake.requestsFor("pane.close").length, 0);
		strictEqual(fake.requestsFor("pane.report_metadata").length, metadataBefore);
		strictEqual(fake.requestsFor("pane.report_agent").length, agentBefore);
	});

	it("reports run display state as agent state plus metadata tokens", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		await mux.reportRunState("run-1", {
			phase: "verifying",
			agentState: "blocked",
			model: "qwen3-coder",
			outcome: "failed",
			displayAgent: "tester",
			tokens: { role: "verifier", role_display: "verifier", agent: "tester" },
			stateLabels: { working: "verifying", blocked: "verification blocked", idle: "failed, review" },
		});
		const agent = fake.requestsFor("pane.report_agent").at(-1);
		strictEqual(agent?.params.state, "blocked");
		strictEqual(agent?.params.agent, "tester");
		const metadata = fake.requestsFor("pane.report_metadata").at(-1);
		deepStrictEqual(metadata?.params.tokens, {
			clio_owner: "clio:mux",
			role: "verifier",
			// The run token is what a later process reads back off the pane to
			// re-adopt this viewer instead of opening a second one.
			run: "run-1",
			phase: "verifying",
			model: "qwen3-coder",
			outcome: "failed",
			role_display: "verifier",
			agent: "tester",
		});
		strictEqual(metadata?.params.display_agent, "tester");
		deepStrictEqual(metadata?.params.state_labels, {
			working: "verifying",
			blocked: "verification blocked",
			idle: "failed, review",
		});
	});

	it("keeps a failed run's pane open when the caller asks it to", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		await mux.reportRunState("run-1", { phase: "done", agentState: "idle", outcome: "failed" });
		await mux.closeRunPane("run-1", { keepOnFailure: true });
		strictEqual(fake.requestsFor("pane.close").length, 0, "a failed run's pane persists for post-mortem");
		strictEqual(mux.list().length, 1);

		await mux.closeRunPane("run-1");
		strictEqual(fake.requestsFor("pane.close").length, 1);
		strictEqual(mux.list().length, 0);
	});

	it("closes a succeeded run's pane even under keepOnFailure", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		await mux.reportRunState("run-1", { phase: "done", agentState: "idle", outcome: "succeeded" });
		await mux.closeRunPane("run-1", { keepOnFailure: true });
		strictEqual(fake.requestsFor("pane.close").length, 1);
		strictEqual(mux.list().length, 0);
	});

	it("reconciles the registry when a pane closes or exits behind Clio's back", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const first = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		const second = await mux.openRunPane({ runId: "run-2", agentId: "fixer", label: "two" });
		ok(first && second);
		strictEqual(mux.list().length, 2);

		fake.pushEvent("pane_closed", { paneId: first.paneId, workspaceId: "w1" });
		await waitForCondition(() => mux.list().length === 1, "the closed pane to leave the registry");
		strictEqual(mux.list()[0]?.runId, "run-2");

		fake.pushEvent("pane_exited", { paneId: second.paneId, workspaceId: "w1" });
		await waitForCondition(() => mux.list().length === 0, "the exited pane to leave the registry");

		// The run is no longer Clio's to close, so nothing reaches the server.
		await mux.closeRunPane("run-1");
		strictEqual(fake.requestsFor("pane.close").length, 0);
	});

	it("opens a utility pane beside Clio's own pane and runs its argv", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const ref = await mux.openUtilityPane({
			argv: ["yazi", "--cwd", "/some dir"],
			cwd: "/work",
			label: "files",
			env: { CLIO_PANE: "1" },
		});
		ok(ref);
		const split = fake.requestsFor("pane.split")[0];
		strictEqual(split?.params.target_pane_id, "w1:p1", "utility panes split relative to Clio's own pane");
		strictEqual(split?.params.direction, "right");
		strictEqual(split?.params.focus, false, "opening a utility pane must not move focus off Clio");
		strictEqual(split?.params.cwd, "/work");
		deepStrictEqual(split?.params.env, { CLIO_PANE: "1" });

		const sent = fake.requestsFor("pane.send_text")[0];
		strictEqual(sent?.params.pane_id, ref.paneId);
		strictEqual(sent?.params.text, "exec 'yazi' '--cwd' '/some dir'\n");

		const record = mux.list()[0];
		strictEqual(record?.purpose, "utility");
		strictEqual(record?.runId, null);
	});

	it("keeps a shell behind a following run viewer and renders a static post-mortem when it exits", async () => {
		const { fake, runtime } = await guest({
			viewerCommand: () => ["node", "/opt/clio/run-view.js", "run-1", "--follow"],
		});
		await runtime.contract.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		strictEqual(
			fake.requestsFor("pane.send_text")[0]?.params.text,
			"'node' '/opt/clio/run-view.js' 'run-1' '--follow'; 'node' '/opt/clio/run-view.js' 'run-1'\n",
		);
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
		fake.setHandler("tab.create", () => ({ error: { code: "tab_create_failed", message: "no room" } }));
		strictEqual(await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" }), null);
		// A server-side refusal is not a transport failure, so the mux stays available.
		strictEqual(mux.available(), true);

		fake.setHandler("tab.create", null);
		ok(await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" }));
	});

	it("degrades to unavailable when the socket dies, and probes again after the cooldown", async () => {
		const fixture = await guest();
		const mux = fixture.runtime.contract;
		strictEqual(mux.available(), true);
		await fixture.fake.stop();

		strictEqual(await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" }), null);
		strictEqual(mux.available(), false, "a dead socket degrades the contract rather than throwing");

		fixture.advance(5_000);
		strictEqual(mux.available(), true, "the contract probes again once the cooldown lapses");
	});

	it("tears down sockets on shutdown without closing or forgetting owned panes", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const ref = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		ok(ref);
		await mux.shutdown();
		strictEqual(mux.available(), false);
		strictEqual(mux.list().length, 1, "shutdown keeps the ownership snapshot for pane adoption semantics");
		ok(
			fake.panes().some((pane) => pane.paneId === ref.paneId),
			"the pane remains on the server",
		);
		strictEqual(fake.requestsFor("pane.close").length, 0, "shutdown must never issue pane.close");
		const splitsBefore = fake.requestsFor("pane.split").length;
		strictEqual(await mux.openRunPane({ runId: "run-2", agentId: "fixer", label: "two" }), null);
		strictEqual(fake.requestsFor("pane.split").length, splitsBefore);
	});
});

describe("mux contract phase 3 surfaces", () => {
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

	it("refreshes authority when agent.focus cannot initially resolve the pane", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const ref = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		ok(ref);
		// A pane whose agent authority herdr no longer holds is exactly the state
		// spec 4.3 names the fallback rung for.
		fake.setHandler("agent.focus", () => ({ error: { code: "agent_not_found", message: "no agent there" } }));
		strictEqual(await mux.focusRunPane("run-1"), true);
		strictEqual(fake.requestsFor("agent.focus").length, 2, "the ladder retries after refreshing authority");
		strictEqual(fake.requestsFor("tab.focus").length, 1);
		strictEqual(fake.requestsFor("tab.focus")[0]?.params.tab_id, ref.tabId);
		strictEqual(fake.focusedTab(), ref.tabId);
		strictEqual(fake.focusedPane(), ref.paneId);
		strictEqual(mux.available(), true, "a server refusal is not a transport failure");
	});

	it("skips both gated methods on a server below their protocol floor", async () => {
		const fake = await startFakeHerdrServer({ protocol: 16, version: "0.6.0" });
		servers.push(fake);
		const detection = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			openClient: (socketPath) => createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500 }),
		});
		ok(detection.client);
		const runtime = createMuxRuntime({ detection: detection.detection, client: detection.client });
		runtimes.push(runtime);
		const mux = runtime.contract;
		const ref = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		ok(ref);
		await mux.notify({ title: "done" });
		strictEqual(fake.requestsFor("notification.show").length, 0, "a gated method is not attempted below its floor");
		strictEqual(await mux.focusRunPane("run-1"), true);
		strictEqual(fake.requestsFor("agent.focus").length, 0);
		strictEqual(fake.requestsFor("tab.focus").length, 1, "the fallback rung carries the focus instead");
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

	it("adopts a still-open viewer pane from a previous session and never opens a second", async () => {
		const fake = await startFakeHerdrServer({
			panes: [
				{ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
				{ paneId: "w1:p9", tabId: "w1:t2", workspaceId: "w1" },
				{ paneId: "w1:p8", tabId: "w1:t2", workspaceId: "w1" },
			],
		});
		servers.push(fake);
		// The pane a previous process opened still carries Clio's owner token and
		// the run it was opened for; a foreign pane carries neither.
		fake.setTokens("w1:p9", { clio_owner: "clio:mux", run: "run-1", role: "tester" });
		fake.setTokens("w1:p8", { run: "run-2" });
		const detection = await detectMux({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" },
			openClient: (socketPath) => createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500 }),
		});
		ok(detection.client);
		const runtime = createMuxRuntime({ detection: detection.detection, client: detection.client });
		runtimes.push(runtime);
		const mux = runtime.contract;

		const adopted = await mux.adoptRunPanes([
			{ runId: "run-1", agentId: "tester", label: "one" },
			{ runId: "run-2", agentId: "fixer", label: "two" },
			{ runId: "run-3", agentId: "scout", label: "three" },
		]);
		deepStrictEqual([...adopted], ["run-1"], "only a pane carrying Clio's owner token is Clio's to adopt");
		strictEqual(mux.list().length, 1);
		strictEqual(mux.list()[0]?.adopted, true);

		const splitsBefore = fake.requestsFor("pane.split").length;
		const again = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		strictEqual(again?.paneId, "w1:p9");
		strictEqual(fake.requestsFor("pane.split").length, splitsBefore, "an adopted run must not open a second pane");
		strictEqual(fake.requestsFor("tab.create").length, 0);
	});

	it("reports a pane leaving to its handlers, once, with the record that left", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		const seen: string[] = [];
		const off = mux.onPaneGone((record) => {
			if (record.runId) seen.push(record.runId);
		});
		const ref = await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		ok(ref);
		fake.pushEvent("pane_closed", { paneId: ref.paneId, workspaceId: ref.workspaceId });
		await waitForCondition(() => seen.length === 1, "the pane-gone handler");
		deepStrictEqual(seen, ["run-1"]);
		off();
		const second = await mux.openRunPane({ runId: "run-2", agentId: "fixer", label: "two" });
		ok(second);
		fake.pushEvent("pane_closed", { paneId: second.paneId, workspaceId: second.workspaceId });
		await waitForCondition(() => mux.list().length === 0, "the registry to drop the second pane");
		deepStrictEqual(seen, ["run-1"], "an unsubscribed handler stops hearing");
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

	it("puts a state_labels override on the terminal report", async () => {
		const { fake, runtime } = await guest();
		const mux = runtime.contract;
		await mux.openRunPane({ runId: "run-1", agentId: "tester", label: "one" });
		await mux.reportRunState("run-1", {
			phase: "done",
			agentState: "idle",
			outcome: "succeeded",
			stateLabels: { idle: "review ready" },
		});
		const metadata = fake.requestsFor("pane.report_metadata").at(-1);
		deepStrictEqual(metadata?.params.state_labels, { idle: "review ready" });
	});
});
