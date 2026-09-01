/**
 * The workers-view watch pane controller.
 *
 * The properties that make the navigation feel native: `watch` opens (or
 * adopts) at most one pane and every later call is a selection-file write;
 * `follow` never opens anything, so arrow keys cost zero socket traffic; a
 * pane the operator closed stays closed until the next explicit Enter; and
 * the selection write is atomic, so the viewer's poll cannot read a torn id.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { MuxContract, MuxOpenUtilityPaneRequest, MuxPaneRecord, MuxPaneRef } from "../../src/domains/mux/index.js";
import { createWatchPaneController } from "../../src/interactive/watch-pane.js";

const TEST_DIRS = {
	config: "/resolved/config",
	data: "/resolved/data",
	state: "/resolved/state",
	cache: "/resolved/cache",
} as const;

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempSelection(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-watch-"));
	dirs.push(dir);
	return join(dir, "watch-selection");
}

interface FakeMux {
	contract: MuxContract;
	opened: MuxOpenUtilityPaneRequest[];
	adoptable: MuxPaneRef | null;
	adoptions: number;
	adoptRequests: Array<{ purpose: string; dock?: string }>;
	paneGone(paneId: string): void;
}

function fakeMux(): FakeMux {
	const opened: MuxOpenUtilityPaneRequest[] = [];
	const handlers = new Set<(record: MuxPaneRecord) => void>();
	let next = 0;
	const fake: FakeMux = {
		opened,
		adoptable: null,
		adoptions: 0,
		adoptRequests: [],
		paneGone(paneId: string): void {
			for (const handler of handlers) {
				handler({ ref: { paneId, tabId: "w1:t1", workspaceId: "w1" }, purpose: "watch", label: "watch", openedAt: 0 });
			}
		},
		contract: {
			mode: "guest",
			available: () => true,
			detection: () => ({
				mode: "guest",
				socketPath: "/tmp/h.sock",
				server: { version: "0.7.5", protocol: 17 },
				self: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p0" },
				candidates: ["/tmp/h.sock"],
				reason: "fake",
				refused: false,
			}),
			async openUtilityPane(request: MuxOpenUtilityPaneRequest): Promise<MuxPaneRef | null> {
				opened.push(request);
				next += 1;
				return { paneId: `w1:p${next}`, tabId: "w1:t1", workspaceId: "w1" };
			},
			async adoptPane(request: {
				purpose: string;
				label: string;
				dock?: "workers" | "files";
			}): Promise<MuxPaneRef | null> {
				fake.adoptions += 1;
				fake.adoptRequests.push({ purpose: request.purpose, ...(request.dock ? { dock: request.dock } : {}) });
				return fake.adoptable;
			},
			async closePane(): Promise<boolean> {
				return false;
			},
			async focusPane(): Promise<boolean> {
				return false;
			},
			async zoomPane(): Promise<boolean> {
				return false;
			},
			async resizeDock(): Promise<boolean> {
				return false;
			},
			docks: () => [],
			async notify(): Promise<void> {},
			async worktreeCreate(): Promise<null> {
				return null;
			},
			async worktreeRemove(): Promise<boolean> {
				return false;
			},
			onPaneGone(handler: (record: MuxPaneRecord) => void): () => void {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
			list: () => [],
			async reportSelf(): Promise<boolean> {
				return false;
			},
			async shutdown(): Promise<void> {},
		},
	};
	return fake;
}

describe("watch pane controller", () => {
	it("opens one watch pane on first watch, then only writes the selection", async () => {
		const mux = fakeMux();
		const selectionPath = tempSelection();
		const watch = createWatchPaneController({
			mux: mux.contract,
			getCwd: () => "/work",
			getWorkersRatio: () => 0.4,
			selectionPath,
			dirs: TEST_DIRS,
		});

		const first = await watch.watch("run-1");
		strictEqual(first.status, "watching");
		if (first.status === "watching") strictEqual(first.opened, true);
		strictEqual(mux.opened.length, 1);
		strictEqual(mux.opened[0]?.purpose, "watch");
		// The watch pane is the workers dock now; the contract owns direction
		// and geometry from the slot spec, so no direction rides the request.
		deepStrictEqual(mux.opened[0]?.dock, { slot: "workers", share: 0.4 });
		strictEqual(mux.opened[0]?.direction, undefined);
		strictEqual(mux.opened[0]?.title, "clio watch");
		const command = mux.opened[0]?.argv ?? [];
		ok(command.join(" ").includes(`--watch ${selectionPath}`));
		deepStrictEqual(command.slice(4, -2), [
			"--config-dir",
			TEST_DIRS.config,
			"--data-dir",
			TEST_DIRS.data,
			"--state-dir",
			TEST_DIRS.state,
			"--cache-dir",
			TEST_DIRS.cache,
		]);
		strictEqual(readFileSync(selectionPath, "utf8"), "run-1\n");

		const second = await watch.watch("run-2");
		strictEqual(second.status, "watching");
		if (second.status === "watching") strictEqual(second.opened, false);
		strictEqual(mux.opened.length, 1, "an open watch pane is retargeted, never duplicated");
		strictEqual(readFileSync(selectionPath, "utf8"), "run-2\n");

		// The write is replace-by-rename: no partial temp file lingers.
		const dir = join(selectionPath, "..");
		deepStrictEqual(
			readdirSync(dir).filter((name) => name.endsWith(".tmp")),
			[],
		);
	});

	it("adopts a surviving watch pane instead of opening a second", async () => {
		const mux = fakeMux();
		mux.adoptable = { paneId: "w1:p77", tabId: "w1:t1", workspaceId: "w1" };
		const watch = createWatchPaneController({
			mux: mux.contract,
			getCwd: () => "/work",
			selectionPath: tempSelection(),
			dirs: TEST_DIRS,
		});
		const result = await watch.watch("run-1");
		strictEqual(result.status, "watching");
		if (result.status === "watching") {
			strictEqual(result.paneId, "w1:p77");
			strictEqual(result.opened, false);
		}
		deepStrictEqual(mux.opened, []);
		// Adoption reclaims the workers dock slot, not just registry ownership,
		// so geometry management resumes on the surviving pane.
		deepStrictEqual(mux.adoptRequests[0], { purpose: "watch", dock: "workers" });
	});

	it("ensureOpen composes the dock at boot without touching the selection", async () => {
		const mux = fakeMux();
		const selectionPath = tempSelection();
		const watch = createWatchPaneController({
			mux: mux.contract,
			getCwd: () => "/work",
			selectionPath,
			dirs: TEST_DIRS,
		});

		strictEqual(await watch.ensureOpen(), true);
		strictEqual(mux.opened.length, 1);
		// No ratio dep wired: the dock spec's default governs, so no share rides.
		deepStrictEqual(mux.opened[0]?.dock, { slot: "workers" });
		strictEqual(watch.isOpen(), true);
		// The selection file is untouched: the viewer parks on "no selection".
		let selection: string | null = null;
		try {
			selection = readFileSync(selectionPath, "utf8");
		} catch {
			selection = null;
		}
		strictEqual(selection, null);

		// Idempotent: a second ensureOpen answers with the existing pane.
		strictEqual(await watch.ensureOpen(), true);
		strictEqual(mux.opened.length, 1);
	});

	it("eagerly reclaims a surviving pane before the first explicit watch", async () => {
		const mux = fakeMux();
		mux.adoptable = { paneId: "w1:p77", tabId: "w1:t1", workspaceId: "w1" };
		const selectionPath = tempSelection();
		const watch = createWatchPaneController({
			mux: mux.contract,
			getCwd: () => "/work",
			selectionPath,
			dirs: TEST_DIRS,
		});

		await new Promise<void>((resolve) => setImmediate(resolve));
		strictEqual(mux.adoptions, 1);
		strictEqual(watch.isOpen(), true, "startup adoption makes the pane visible to the relaunched session");
		strictEqual(watch.follow("run-2"), true, "navigation can retarget the reclaimed pane without pressing Enter");
		strictEqual(readFileSync(selectionPath, "utf8"), "run-2\n");
		deepStrictEqual(mux.opened, []);
	});

	it("follow retargets an open pane and refuses to open a closed one", async () => {
		const mux = fakeMux();
		const selectionPath = tempSelection();
		const watch = createWatchPaneController({
			mux: mux.contract,
			getCwd: () => "/work",
			selectionPath,
			dirs: TEST_DIRS,
		});

		strictEqual(watch.follow("run-1"), false, "navigation never opens a pane");
		strictEqual(mux.opened.length, 0);

		await watch.watch("run-1");
		strictEqual(watch.follow("run-2"), true);
		strictEqual(readFileSync(selectionPath, "utf8"), "run-2\n");
		strictEqual(mux.opened.length, 1);
	});

	it("treats an operator-closed pane as a decision: follow goes quiet, Enter reopens", async () => {
		const mux = fakeMux();
		const selectionPath = tempSelection();
		const watch = createWatchPaneController({
			mux: mux.contract,
			getCwd: () => "/work",
			selectionPath,
			dirs: TEST_DIRS,
		});
		const first = await watch.watch("run-1");
		strictEqual(first.status, "watching");
		const paneId = first.status === "watching" ? first.paneId : "";

		mux.paneGone(paneId);
		strictEqual(watch.isOpen(), false);
		strictEqual(watch.follow("run-2"), false);
		strictEqual(readFileSync(selectionPath, "utf8"), "run-1\n", "a closed pane's selection is not rewritten");

		const reopened = await watch.watch("run-2");
		strictEqual(reopened.status, "watching");
		if (reopened.status === "watching") strictEqual(reopened.opened, true);
		strictEqual(mux.opened.length, 2);
	});

	it("reports unavailability when the pane host refuses the split", async () => {
		const mux = fakeMux();
		mux.contract.openUtilityPane = async () => null;
		const watch = createWatchPaneController({
			mux: mux.contract,
			getCwd: () => "/work",
			selectionPath: tempSelection(),
			dirs: TEST_DIRS,
		});
		const result = await watch.watch("run-1");
		strictEqual(result.status, "unavailable");
	});
});
