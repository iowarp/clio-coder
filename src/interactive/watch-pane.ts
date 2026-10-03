/**
 * The workers dock: one pane, beside Clio's own, running the workers
 * dashboard.
 *
 * The pane hosts `clio-coder fleet view --watch <selection-file>` (see
 * src/cli/fleet-board.ts), a durable-state dashboard that opens on a board of
 * this session's workers. Two small files carry everything between Clio and
 * it. Clio writes the selection file to ask for a takeover of one run
 * (`/panes show`, the panes tool, Enter or the cursor in the Fleet Runs board)
 * and to say which session the board belongs to; the dashboard re-reads it on
 * every poll, so a request costs one atomic write and no socket traffic. The
 * dashboard appends to the dock tap file when a key meant for Clio is pressed
 * inside it (`q` hides the dock, Alt+W is the workers key), because the pane
 * that has the keyboard is not Clio's.
 *
 * The workers key (Alt+W) treats the pane like the other docks: a first tap
 * opens or shows it and moves the keyboard in, or hides it when it is in the
 * layout; hiding parks the dashboard with its state intact, and only a close
 * ends it. Pane creation stays operator-pulled: nothing here opens a pane
 * because a worker started.
 *
 * Which pane is the dock is read from the mux registry on every call rather
 * than remembered: herdr renames a pane when it moves it between tabs, and the
 * registry follows the rename while a cached id would not.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ClioDirs, clioCacheDir, clioConfigDir, clioDataDir, clioStateDir } from "../core/xdg.js";
import type { MuxContract, MuxPaneOpenFailure, MuxPaneRecord, MuxPaneRef } from "../domains/mux/index.js";
import type { PanesWatchController, PanesWatchResult, PanesWorkersResult } from "../domains/mux/operations.js";
import { type TapFileWatcher, watchTapFile } from "../domains/mux/tap-file.js";
import { watchViewerCommand } from "../domains/mux/viewer-command.js";

/**
 * One selection file per state root, deliberately not per session: every
 * session over a state root shares one run ledger, so a surviving dock from a
 * crashed session keeps working the moment a new session writes the same file.
 */
function watchSelectionPath(stateDir: string = clioStateDir()): string {
	return join(stateDir, "watch-selection");
}

/** Where the dashboard reports keys pressed inside it; per state root for the same reason. */
function watchTapPath(stateDir: string = clioStateDir()): string {
	return join(stateDir, "watch-dock-taps");
}

export interface WatchPaneDeps {
	mux: MuxContract;
	getCwd: () => string;
	/**
	 * Live workers-dock share, read at each open so a `/settings` edit applies
	 * to the next pane. Absent (tests, minimal wiring) the dock spec's default
	 * governs.
	 */
	getWorkersRatio?: () => number;
	/** The session whose workers the board lists; read at each write so `/new` and `/resume` follow. */
	getSessionId?: () => string | null;
	/** Selection-file override for tests. */
	selectionPath?: string;
	/** Tap-file override for tests; null turns the in-dock keys off. */
	tapPath?: string | null;
	/** Resolved-layout override for tests. Production pins this process's four cached roots. */
	dirs?: Readonly<ClioDirs>;
	/** Command override for tests; production runs this install's own CLI. */
	command?: (selectionPath: string, dirs: Readonly<ClioDirs>, tapPath: string | null) => ReadonlyArray<string>;
	writeFile?: (path: string, content: string) => void;
	now?: () => number;
}

/** Replace-by-rename so the dashboard's poll never reads a torn request. */
function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

/** The counter already in the file, so a new session keeps it increasing for a surviving dashboard. */
function currentSeq(path: string): number {
	try {
		const match = /^seq=(\d+)$/mu.exec(readFileSync(path, "utf8"));
		return match?.[1] === undefined ? 0 : Number(match[1]);
	} catch {
		return 0;
	}
}

export function createWatchPaneController(deps: WatchPaneDeps): PanesWatchController {
	const selectionPath = deps.selectionPath ?? watchSelectionPath();
	const tapPath = deps.tapPath === undefined ? watchTapPath() : deps.tapPath;
	const dirs =
		deps.dirs ??
		Object.freeze({
			config: clioConfigDir(),
			data: clioDataDir(),
			state: clioStateDir(),
			cache: clioCacheDir(),
		});
	const command =
		deps.command ??
		((path, layout, taps) => watchViewerCommand(path, { dirs: layout, ...(taps ? { tapPath: taps } : {}) }));
	const write = deps.writeFile ?? atomicWrite;
	const now = deps.now ?? Date.now;
	// The board lists this session's workers; one with no session stamp counts
	// when it started after this Clio did.
	const since = new Date(now()).toISOString();

	let disposed = false;
	let adoptionInFlight: Promise<boolean> | null = null;
	let seq = currentSeq(selectionPath);
	let requested = "";
	const keyHandlers = new Set<(key: "hide" | "key") => void>();

	let taps: TapFileWatcher | null = null;
	if (tapPath !== null) {
		try {
			taps = watchTapFile(tapPath, (line) => {
				if (line !== "hide" && line !== "key") return;
				for (const handler of keyHandlers) handler(line);
			});
		} catch {
			// Without the tap file the dashboard's q and Alt+W reach nothing; the
			// dock still opens, hides and closes from Clio's own keys.
		}
	}

	const record = (): MuxPaneRecord | null => deps.mux.list().find((entry) => entry.purpose === "watch") ?? null;

	const visibility = (): "visible" | "hidden" | "closed" => {
		if (record() === null) return "closed";
		// Below the layout tier the pane is a plain split with no dock state, and
		// a plain split is always in the layout.
		return deps.mux.dockVisibility("workers") === "hidden" ? "hidden" : "visible";
	};

	/** One write: the request (blank asks for the board) plus the session the board belongs to. */
	const writeRequest = (runId: string, bump: boolean): boolean => {
		if (bump) {
			seq += 1;
			requested = runId;
		}
		const session = deps.getSessionId?.() ?? "";
		try {
			write(selectionPath, `${requested}\nseq=${seq}\nsession=${session}\nsince=${since}\n`);
			return true;
		} catch {
			return false;
		}
	};

	const adoptExistingPane = (): Promise<boolean> => {
		if (disposed || record() !== null) return Promise.resolve(true);
		if (adoptionInFlight !== null) return adoptionInFlight;
		const attempt = Promise.resolve()
			.then(() => deps.mux.adoptPane({ purpose: "watch", label: "watch", dock: "workers" }))
			.then(() => true)
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

	/**
	 * The one place the dock is created: the workers slot, split right of Clio's
	 * pane at the configured share. On a host without the layout tier the dock
	 * request degrades inside the contract to a plain right split.
	 */
	const openPane = (onFailure?: (failure: MuxPaneOpenFailure) => void): Promise<MuxPaneRef | null> =>
		deps.mux.openUtilityPane({
			...(onFailure ? { onFailure } : {}),
			argv: command(selectionPath, dirs, tapPath),
			cwd: deps.getCwd(),
			label: "watch",
			title: "clio-coder workers",
			purpose: "watch",
			dock: { slot: "workers", ...(deps.getWorkersRatio ? { share: deps.getWorkersRatio() } : {}) },
		});

	const describeFailure = (failure: MuxPaneOpenFailure): string => {
		if (failure.source === "local") return `cannot open the watch pane locally: ${failure.message}`;
		const details = [
			`kind=${failure.kind}`,
			...(failure.wireCode === null ? [] : [`code=${failure.wireCode}`]),
			...(failure.method === null ? [] : [`method=${failure.method}`]),
		];
		return `cannot open the watch pane (${details.join(", ")}): ${failure.message || "no failure message was supplied by the pane host"}`;
	};

	/** Open a new dock, the board or a takeover already requested. */
	const openNew = async (): Promise<{ ref: MuxPaneRef } | { reason: string }> => {
		let reason =
			"cannot open the watch pane: no failure reason was supplied by the pane host; check /panes before trying again";
		const opened = await openPane((failure) => {
			reason = describeFailure(failure);
		});
		return opened === null ? { reason } : { ref: opened };
	};

	const showParked = async (): Promise<string | null> => {
		let reason: string | null = null;
		const shown = await deps.mux.showDock("workers", {
			onFailure: (failure) => {
				reason = failure.message;
			},
		});
		return shown === null ? `the workers dock stayed hidden: ${reason ?? "the pane host refused"}` : null;
	};

	/** Calls touching the dock run one at a time, so a tool's show cannot race the key's hide. */
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const run = queue.then(task, task);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	/** Put the keyboard in the dock, as the files key does for Yazi. */
	const focusDock = async (): Promise<void> => {
		const pane = record();
		if (pane !== null) await deps.mux.focusPane(pane.ref.paneId);
	};

	// Reclaim durable ownership for inventory and navigation immediately. The
	// scan remains best effort and never opens a replacement pane on its own.
	void adoptExistingPane();

	return {
		ensureOpen(): Promise<boolean> {
			// Boot composition: the dock exists and shows the board. Adoption first,
			// so a surviving dock is reused rather than doubled.
			return serial(async () => {
				if (disposed) return false;
				if (record() !== null) return true;
				await adoptExistingPane();
				if (record() !== null) return true;
				writeRequest("", true);
				return "ref" in (await openNew());
			});
		},

		watch(runId: string): Promise<PanesWatchResult> {
			return serial(async () => {
				if (!writeRequest(runId, true)) {
					return { status: "unavailable", reason: `cannot write the watch selection at ${selectionPath}` };
				}
				if (record() === null) {
					const scanned = await adoptExistingPane();
					if (!scanned) await adoptExistingPane();
				}
				const pane = record();
				if (pane !== null) {
					// A parked dock comes back to show the run it was asked for, without
					// taking the keyboard from whoever asked.
					if (visibility() !== "hidden") return { status: "watching", runId, paneId: pane.ref.paneId, opened: false };
					const refused = await showParked();
					if (refused !== null) return { status: "unavailable", reason: refused };
					return { status: "watching", runId, paneId: record()?.ref.paneId ?? pane.ref.paneId, opened: true };
				}
				const opened = await openNew();
				if (!("ref" in opened)) return { status: "unavailable", reason: opened.reason };
				return { status: "watching", runId, paneId: opened.ref.paneId, opened: true };
			});
		},

		follow(runId: string): boolean {
			// Navigation never opens anything; a closed dock stays closed until the
			// operator asks again.
			if (record() === null) return false;
			if (runId === requested) return true;
			return writeRequest(runId, true);
		},

		toggle(): Promise<PanesWorkersResult> {
			return serial(async (): Promise<PanesWorkersResult> => {
				if (disposed) return { status: "unavailable", reason: "the workers dock is closed for this session" };
				if (record() === null) await adoptExistingPane();
				const state = visibility();
				if (state === "visible") {
					const hidden = await deps.mux.hideDock("workers");
					return hidden
						? { status: "hidden" }
						: { status: "unavailable", reason: "the workers dock did not hide; check /panes before trying again" };
				}
				if (state === "hidden") {
					writeRequest(requested, false);
					const refused = await showParked();
					if (refused !== null) return { status: "unavailable", reason: refused };
					await focusDock();
					return { status: "shown" };
				}
				// A fresh dock starts on the board, whatever a past session asked for.
				writeRequest("", true);
				await deps.mux.unzoomSelf();
				const opened = await openNew();
				if (!("ref" in opened)) return { status: "unavailable", reason: opened.reason };
				await focusDock();
				return { status: "opened" };
			});
		},

		hide(): Promise<boolean> {
			return serial(async () => (visibility() === "visible" ? deps.mux.hideDock("workers") : visibility() === "hidden"));
		},

		close(): Promise<boolean> {
			return serial(async () => {
				const pane = record();
				if (pane === null) return false;
				return deps.mux.closePane(pane.ref.paneId);
			});
		},

		visibility,

		isOpen(): boolean {
			return record() !== null;
		},

		onDockKey(handler: (key: "hide" | "key") => void): () => void {
			keyHandlers.add(handler);
			return () => {
				keyHandlers.delete(handler);
			};
		},

		dispose(): void {
			// The pane parks; only the tap watch goes.
			disposed = true;
			taps?.stop();
			keyHandlers.clear();
		},
	};
}
