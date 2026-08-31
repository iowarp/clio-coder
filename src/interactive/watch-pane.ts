/**
 * The workers-view watch pane: one pane, beside Clio's own, rendering whatever
 * run the operator points at.
 *
 * The pane hosts `clio-coder fleet view --watch <selection-file>` (see
 * src/cli/fleet-view.ts), a durable-state viewer that re-reads the selection
 * file on every poll. Retargeting is therefore one small atomic file write:
 * arrow keys in the Alt+W board follow the cursor with zero socket traffic and
 * zero pane churn, which is what makes the navigation feel like part of the
 * board rather than like driving a terminal multiplexer.
 *
 * Pane creation is deliberately lazy, but reclamation is eager. A surviving
 * pane is adopted as soon as the controller starts so the relaunched session's
 * inventory owns it before the next watch command. A new pane still opens only
 * on the first watch (operator Enter, `/panes show`, or the panes tool), and is
 * never closed by navigation: leaving the workers view parks it on the last
 * selection, and it goes away when the operator quits the viewer (`q`), closes
 * the pane, or runs `/panes close watch`.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ClioDirs, clioCacheDir, clioConfigDir, clioDataDir, clioStateDir } from "../core/xdg.js";
import type { MuxContract } from "../domains/mux/index.js";
import type { PanesWatchController, PanesWatchResult } from "../domains/mux/operations.js";
import { watchViewerCommand } from "../domains/mux/viewer-command.js";

/**
 * One selection file per state root, deliberately not per session: every
 * session over a state root shares one run ledger, so a surviving watch pane
 * from a crashed session keeps working the moment a new session writes the
 * same file.
 */
function watchSelectionPath(stateDir: string = clioStateDir()): string {
	return join(stateDir, "watch-selection");
}

export interface WatchPaneDeps {
	mux: MuxContract;
	getCwd: () => string;
	/** Selection-file override for tests. */
	selectionPath?: string;
	/** Resolved-layout override for tests. Production pins this process's four cached roots. */
	dirs?: Readonly<ClioDirs>;
	/** Command override for tests; production runs this install's own CLI. */
	command?: (selectionPath: string, dirs: Readonly<ClioDirs>) => ReadonlyArray<string>;
	writeFile?: (path: string, content: string) => void;
}

/** Replace-by-rename so the viewer's poll never reads a torn line. */
function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

export function createWatchPaneController(deps: WatchPaneDeps): PanesWatchController {
	const selectionPath = deps.selectionPath ?? watchSelectionPath();
	const dirs =
		deps.dirs ??
		Object.freeze({
			config: clioConfigDir(),
			data: clioDataDir(),
			state: clioStateDir(),
			cache: clioCacheDir(),
		});
	const command = deps.command ?? ((path, layout) => watchViewerCommand(path, { dirs: layout }));
	const write = deps.writeFile ?? atomicWrite;

	let paneId: string | null = null;
	let disposed = false;
	let adoptionInFlight: Promise<boolean> | null = null;
	const unsubscribe = deps.mux.onPaneGone((record) => {
		if (record.ref.paneId === paneId) paneId = null;
	});
	const adoptExistingPane = (): Promise<boolean> => {
		if (disposed || paneId !== null) return Promise.resolve(true);
		if (adoptionInFlight !== null) return adoptionInFlight;
		const attempt = Promise.resolve()
			.then(() => deps.mux.adoptPane({ purpose: "watch", label: "watch" }))
			.then((adopted) => {
				if (!disposed && paneId === null && adopted !== null) paneId = adopted.paneId;
				return true;
			})
			.catch(() => {
				// Startup reclamation is best effort. An explicit watch retries the
				// scan before it opens a replacement pane.
				return false;
			})
			.finally(() => {
				if (adoptionInFlight === attempt) adoptionInFlight = null;
			});
		adoptionInFlight = attempt;
		return attempt;
	};

	const writeSelection = (runId: string): boolean => {
		try {
			write(selectionPath, `${runId}\n`);
			return true;
		} catch {
			return false;
		}
	};

	// Reclaim durable ownership for inventory and navigation immediately. The
	// scan remains best effort and never opens a replacement pane on its own.
	void adoptExistingPane();

	return {
		async watch(runId: string): Promise<PanesWatchResult> {
			if (!writeSelection(runId)) {
				return { status: "unavailable", reason: `cannot write the watch selection at ${selectionPath}` };
			}
			if (paneId !== null) return { status: "watching", runId, paneId, opened: false };
			const scanned = await adoptExistingPane();
			if (!scanned) await adoptExistingPane();
			if (paneId !== null) return { status: "watching", runId, paneId, opened: false };
			const opened = await deps.mux.openUtilityPane({
				argv: command(selectionPath, dirs),
				cwd: deps.getCwd(),
				label: "watch",
				title: "clio watch",
				purpose: "watch",
				direction: "right",
			});
			if (opened === null) {
				return { status: "unavailable", reason: "the pane host refused to open the watch pane" };
			}
			paneId = opened.paneId;
			return { status: "watching", runId, paneId, opened: true };
		},

		follow(runId: string): boolean {
			// Navigation never opens anything; a closed watch pane stays closed
			// until the operator asks again with Enter.
			if (paneId === null) return false;
			return writeSelection(runId);
		},

		isOpen(): boolean {
			return paneId !== null;
		},

		dispose(): void {
			// The pane parks; only the subscription goes.
			disposed = true;
			unsubscribe();
		},
	};
}
