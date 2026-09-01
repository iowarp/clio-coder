/**
 * The dock tier: managed panes with target geometry and a reconciled lifecycle.
 *
 * Pinned here: a dock split honors its share and never asks for focus; the
 * share is raised to the slot's cell floor before the split is requested; an
 * anchor too small to host a dock refuses before anything reaches the wire; a
 * user resize observed via `layout.updated` becomes the new target rather
 * than being fought; a user close is final; adoption returns a surviving dock
 * to its slot after a crash; a clean shutdown closes docks but leaves
 * unmanaged utility panes; and every focus/zoom path refuses panes Clio does
 * not own. Below the protocol-17 layout floor the whole tier degrades to
 * plain splits, and it must be live at protocol 20, which is what the
 * pinned herdr 0.8.2 artifact actually speaks.
 */

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createMuxRuntime, type MuxRuntime } from "../../src/domains/mux/contract.js";
import { detectMux } from "../../src/domains/mux/detect.js";
import { DOCK_SPECS, deriveSplitPath, planDockOpen, ratioForDockShare } from "../../src/domains/mux/dock-controller.js";
import { createMuxClient } from "../../src/domains/mux/socket-client.js";
import type { MuxLayoutNode } from "../../src/domains/mux/types.js";
import { type FakeHerdrServer, startFakeHerdrServer, waitForCondition } from "../harness/fake-herdr-server.js";

const servers: FakeHerdrServer[] = [];
const runtimes: MuxRuntime[] = [];
const BACKOFF = { initialDelayMs: 15, maxDelayMs: 60, factor: 2 };

interface DockFixture {
	fake: FakeHerdrServer;
	runtime: MuxRuntime;
}

async function guest(
	options: { protocol?: number; area?: { width: number; height: number }; start?: boolean } = {},
): Promise<DockFixture> {
	const fake = await startFakeHerdrServer({
		// The pinned 0.8.2 artifact speaks protocol 20 (hash-verified), so the
		// default fixture models it rather than a newer build.
		protocol: options.protocol ?? 20,
		version: "0.8.2",
		area: options.area ?? { width: 200, height: 60 },
	});
	servers.push(fake);
	const detection = await detectMux({
		env: {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: fake.socketPath,
			HERDR_WORKSPACE_ID: "w1",
			HERDR_TAB_ID: "w1:t1",
			HERDR_PANE_ID: "w1:p1",
		},
		openClient: (socketPath) =>
			createMuxClient({ socketPath, requestTimeoutMs: 1_500, connectTimeoutMs: 500, backoff: BACKOFF }),
	});
	strictEqual(detection.detection.mode, "guest");
	ok(detection.client);
	const runtime = createMuxRuntime({ detection: detection.detection, client: detection.client });
	runtimes.push(runtime);
	if (options.start !== false) {
		await runtime.start();
		await waitForCondition(() => fake.subscriptionCount() === 1, "the lifecycle subscription");
	}
	return { fake, runtime };
}

after(async () => {
	for (const runtime of runtimes) await runtime.stop().catch(() => undefined);
	for (const fake of servers) await fake.stop().catch(() => undefined);
});

describe("dock geometry helpers", () => {
	it("plans a dock from the anchor rect, raising the share to the cell floor", () => {
		// 200 columns at the default 34% would give 68 >= 48: default survives.
		const wide = planDockOpen({ width: 200, height: 60 }, DOCK_SPECS.workers);
		ok(!("refused" in wide));
		strictEqual(wide.share, DOCK_SPECS.workers.defaultShare);
		strictEqual(wide.ratio, ratioForDockShare(DOCK_SPECS.workers.defaultShare));
		// 100 columns at 34% would give 34 < 48: the share is raised to 0.48.
		const narrow = planDockOpen({ width: 100, height: 60 }, DOCK_SPECS.workers);
		ok(!("refused" in narrow));
		strictEqual(narrow.share, 0.48);
		// 80 columns cannot give 48 at half the axis: refused outright.
		ok("refused" in planDockOpen({ width: 80, height: 60 }, DOCK_SPECS.workers));
	});

	it("derives the split path and dock side from a layout tree", () => {
		const tree: MuxLayoutNode = {
			type: "split",
			direction: "down",
			ratio: 0.7,
			first: {
				type: "split",
				direction: "right",
				ratio: 0.66,
				first: { type: "pane", paneId: "w1:p1", label: null },
				second: { type: "pane", paneId: "w1:p2", label: null },
			},
			second: { type: "pane", paneId: "w1:p3", label: null },
		};
		// The workers dock sits across the inner right split, second side.
		const workers = deriveSplitPath(tree, "w1:p1", "w1:p2");
		ok(workers);
		strictEqual(workers.dockIsSecond, true);
		strictEqual(workers.path.join(","), "false");
		strictEqual(workers.direction, "right");
		// The files dock separates at the root; the anchor is inside `first`.
		const files = deriveSplitPath(tree, "w1:p1", "w1:p3");
		ok(files);
		strictEqual(files.dockIsSecond, true);
		strictEqual(files.path.length, 0);
		strictEqual(files.direction, "down");
		// A pane not in the tree derives nothing, which is how staleness reads.
		strictEqual(deriveSplitPath(tree, "w1:p1", "w1:p99"), null);
	});
});

describe("dock open", () => {
	it("splits the anchor with the slot ratio, no focus, and tags ownership", async () => {
		const { fake, runtime } = await guest();
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			purpose: "watch",
			dock: { slot: "workers" },
		});
		ok(ref);
		const split = fake.requestsFor("pane.split")[0];
		strictEqual(split?.params.direction, "right");
		strictEqual(split?.params.focus, false);
		strictEqual(split?.params.ratio, ratioForDockShare(DOCK_SPECS.workers.defaultShare));
		strictEqual(fake.tokensFor(ref.paneId).clio_owner, "clio:mux");
		strictEqual(fake.tokensFor(ref.paneId).role, "watch");
		const state = runtime.contract.docks()[0];
		strictEqual(state?.slot, "workers");
		strictEqual(state?.paneId, ref.paneId);
	});

	it("answers an open for an occupied slot with the existing pane", async () => {
		const { fake, runtime } = await guest();
		const first = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "files",
			dock: { slot: "files" },
		});
		const again = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "files",
			dock: { slot: "files" },
		});
		strictEqual(again?.paneId, first?.paneId);
		strictEqual(fake.requestsFor("pane.split").length, 1);
	});

	it("refuses a dock the anchor cannot host, before any split reaches the wire", async () => {
		const { fake, runtime } = await guest({ area: { width: 80, height: 60 } });
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		strictEqual(ref, null);
		strictEqual(fake.requestsFor("pane.split").length, 0);
		strictEqual(runtime.contract.docks().length, 0);
		// A refusal is an answer about geometry, not a transport failure.
		strictEqual(runtime.contract.available(), true);
	});

	it("runs the dock tier at protocol 17, the floor the 0.7.5 schema attests", async () => {
		const { fake, runtime } = await guest({ protocol: 17 });
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		ok(ref);
		strictEqual(runtime.contract.docks().length, 1);
		strictEqual(fake.requestsFor("pane.split")[0]?.params.ratio, ratioForDockShare(DOCK_SPECS.workers.defaultShare));
	});

	it("degrades a dock request to a plain split below the layout floor", async () => {
		const { fake, runtime } = await guest({ protocol: 16 });
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			direction: "right",
			dock: { slot: "workers" },
		});
		ok(ref);
		strictEqual(runtime.contract.docks().length, 0);
		strictEqual(fake.requestsFor("pane.split")[0]?.params.ratio, undefined);
		strictEqual(await runtime.contract.resizeDock("workers", 0.4), false);
	});
});

describe("dock reconciliation", () => {
	it("adopts a user resize as the new target instead of fighting it", async () => {
		const { fake, runtime } = await guest();
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		ok(ref);
		// The user drags the divider to give the dock half the axis.
		fake.setSplitRatio("w1:t1", [], 0.5);
		fake.pushLayoutUpdated("w1:t1");
		await waitForCondition(() => {
			const share = runtime.contract.docks()[0]?.targetShare ?? 0;
			return Math.abs(share - 0.5) < 0.03;
		}, "the user resize to be adopted");
	});

	it("ignores an anchor-side split instead of adopting it as a dock resize", async () => {
		const { fake, runtime } = await guest();
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		ok(ref);
		// The user splits the anchor for a scratch shell; the fake emits the
		// layout_updated push a real server would. The anchor's own rect halves,
		// but the dock's share of the separating split never changed, so the
		// target must not move.
		const scratch = await runtime.contract.openUtilityPane({
			argv: ["bash"],
			cwd: "/tmp",
			label: "shell",
			direction: "right",
		});
		ok(scratch);
		// The scratch close rides the same ordered event stream as the layout
		// push, so once the registry shrinks the push has been processed too.
		fake.removePane(scratch.paneId);
		fake.pushEvent("pane_closed", { paneId: scratch.paneId, workspaceId: "w1" });
		await waitForCondition(() => runtime.contract.list().length === 1, "the scratch close to be processed");
		strictEqual(runtime.contract.docks()[0]?.targetShare, DOCK_SPECS.workers.defaultShare);
	});

	it("treats a user close as final and lets an explicit reopen start fresh", async () => {
		const { fake, runtime } = await guest();
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "files",
			dock: { slot: "files" },
		});
		ok(ref);
		fake.removePane(ref.paneId);
		fake.pushEvent("pane_closed", { paneId: ref.paneId, workspaceId: "w1" });
		await waitForCondition(() => runtime.contract.docks().length === 0, "the dock to drop on close");
		strictEqual(runtime.contract.list().length, 0);
		const reopened = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "files",
			dock: { slot: "files" },
		});
		ok(reopened);
		ok(reopened.paneId !== ref.paneId);
	});

	it("clears dock state on closePane even when no event subscription exists", async () => {
		// start: false models the worst case: events.subscribe failed at start()
		// and start() degraded, so no pane.closed push will ever arrive. Dock
		// cleanup must ride the closePane call itself, or the slot points at a
		// dead pane forever and every later open returns the corpse.
		const { fake, runtime } = await guest({ start: false });
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		ok(ref);
		strictEqual(await runtime.contract.closePane(ref.paneId), true);
		strictEqual(runtime.contract.docks().length, 0, "the dock slot must empty with the pane");
		strictEqual(runtime.contract.list().length, 0);
		const reopened = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		ok(reopened);
		ok(reopened.paneId !== ref.paneId, "a reopen must create a fresh dock, not return the dead id");
		strictEqual(fake.requestsFor("pane.split").length, 2);
	});

	it("returns a surviving pane to its slot through dock-aware adoption", async () => {
		const { fake, runtime } = await guest();
		// A previous session's workers dock: owner-tagged, role watch.
		fake.addPane({ paneId: "w1:p7", tabId: "w1:t1", workspaceId: "w1" });
		fake.setTokens("w1:p7", { clio_owner: "clio:mux", role: "watch" });
		const adopted = await runtime.contract.adoptPane({ purpose: "watch", label: "workers-view", dock: "workers" });
		strictEqual(adopted?.paneId, "w1:p7");
		const state = runtime.contract.docks()[0];
		strictEqual(state?.slot, "workers");
		strictEqual(state?.paneId, "w1:p7");
		// No second dock opens for the occupied slot.
		const again = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		strictEqual(again?.paneId, "w1:p7");
		strictEqual(fake.requestsFor("pane.split").length, 0);
	});
});

describe("dock focus, zoom, and shutdown", () => {
	it("focuses and zooms owned panes only, with zero wire traffic for foreign ones", async () => {
		const { fake, runtime } = await guest();
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		ok(ref);
		strictEqual(await runtime.contract.focusPane(ref.paneId), true);
		strictEqual(fake.focusedPane(), ref.paneId);
		strictEqual(await runtime.contract.zoomPane(ref.paneId, "on"), true);
		strictEqual(fake.zoomedPane("w1:t1"), ref.paneId);
		strictEqual(await runtime.contract.zoomPane(ref.paneId, "off"), true);
		// The user's own pane is off the table even though the wire allows it.
		strictEqual(await runtime.contract.focusPane("w1:p1"), false);
		strictEqual(await runtime.contract.zoomPane("w1:p1", "on"), false);
		strictEqual(fake.requestsFor("pane.focus").length, 1);
		strictEqual(fake.requestsFor("pane.zoom").length, 2);
	});

	it("resizes a dock through a freshly derived split path", async () => {
		const { fake, runtime } = await guest();
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		ok(ref);
		strictEqual(await runtime.contract.resizeDock("workers", 0.4), true);
		// Dock is the second child of the root split: wire ratio is the anchor's share.
		strictEqual(fake.requestsFor("layout.set_split_ratio")[0]?.params.ratio, 0.6);
		strictEqual(runtime.contract.docks()[0]?.targetShare, 0.4);
	});

	it("declines a resize when the separating split runs the wrong axis", async () => {
		const { fake, runtime } = await guest();
		const ref = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		ok(ref);
		// A user relocation left the workers dock below the anchor: the separating
		// split runs down while the slot's geometry measures columns. Applying the
		// share would set a height ratio against a column floor.
		fake.setHandler("layout.export", () => ({
			result: {
				type: "layout_export",
				layout: {
					workspace_id: "w1",
					tab_id: "w1:t1",
					zoomed: false,
					focused_pane_id: "w1:p1",
					root: {
						type: "split",
						direction: "down",
						ratio: 0.7,
						first: { type: "pane", pane_id: "w1:p1", cwd: "/tmp" },
						second: { type: "pane", pane_id: ref.paneId, cwd: "/tmp" },
					},
				},
			},
		}));
		strictEqual(await runtime.contract.resizeDock("workers", 0.4), false);
		strictEqual(fake.requestsFor("layout.set_split_ratio").length, 0);
	});

	it("closes docks on clean shutdown and leaves unmanaged utility panes alone", async () => {
		const { fake, runtime } = await guest();
		const dock = await runtime.contract.openUtilityPane({
			argv: [],
			cwd: "/tmp",
			label: "workers-view",
			dock: { slot: "workers" },
		});
		const utility = await runtime.contract.openUtilityPane({
			argv: ["bash"],
			cwd: "/tmp",
			label: "shell",
		});
		ok(dock);
		ok(utility);
		await runtime.contract.shutdown();
		strictEqual(
			fake.panes().some((pane) => pane.paneId === dock.paneId),
			false,
			"the dock pane must close with the session",
		);
		strictEqual(
			fake.panes().some((pane) => pane.paneId === utility.paneId),
			true,
			"the operator's utility pane must survive",
		);
	});
});
