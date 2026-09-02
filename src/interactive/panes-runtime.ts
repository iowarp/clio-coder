/**
 * The one implementation of `PanesOperations`, shared by `/panes` and the
 * `panes` orchestrator tool.
 *
 * Two rules run through it. Presets probe their binary through the toolchain
 * ladder *before* the pane is split: `openUtilityPane` delivers its command by
 * sending `exec <argv>` into the pane's shell, so a binary that is not there
 * kills the pane the instant it appears, and the operator sees a flicker
 * instead of an install hint (phase 1 report, open question 3). And every
 * mutation is scoped to panes Clio created, because the contract's registry
 * refuses anything else.
 *
 * `show` targets running dispatches, not panes: it resolves a fuzzy agent id
 * or run-id prefix against the live dispatch snapshot and points the shared
 * watch pane at the match, under the one policy decision in
 * `pane-policy.ts`. There is no per-run pane inventory to search any more.
 */

import type { ClioSettings } from "../core/config.js";
import type { DispatchSnapshot } from "../domains/dispatch/contract.js";
import {
	newestRunEventJournalRunId,
	runEventJournalPath,
	runEventJournalRoot,
} from "../domains/dispatch/run-event-journal.js";
import type { MuxContract, MuxPaneRecord } from "../domains/mux/index.js";
import {
	PANES_PRESETS,
	type PanesCloseResult,
	type PanesFilesResult,
	type PanesInventoryEntry,
	type PanesOpenResult,
	type PanesOperations,
	type PanesShowResult,
	type PanesStatus,
	type PanesWatchController,
	type PanesYaziController,
	type PanesYaziStatus,
	type PanesZoomResult,
	resolvePanesPresetId,
} from "../domains/mux/operations.js";
import { resolveBinary } from "../tools/executables.js";
import { type PaneWatchSource, paneWatchDecision } from "./pane-policy.js";

export interface PanesRuntimeDeps {
	mux: MuxContract;
	getSettings: () => Readonly<ClioSettings>;
	/** Live dispatch state, used to turn a fuzzy agent id into a run id. */
	getDispatchSnapshot: () => DispatchSnapshot;
	getCwd: () => string;
	/** Injection seam for tests; production uses the toolchain ladder. */
	resolveBinaryPath?: (name: string) => string | null;
	/** Journal root override for tests. */
	journalRoot?: () => string;
	/** Newest run whose journal exists, for the `logs` preset. */
	newestJournalRunId?: () => string | null;
}

/**
 * Why there is no pane layer, in the operator's terms. Detection already
 * knows (no `HERDR_ENV`, no socket, a refused rung); repeating that reason
 * beside the refusal is what turns "unavailable" into a next step, and the
 * `--with-panes` hint covers the session that never asked for panes.
 */
function unavailableReason(mux: MuxContract): string {
	const reason = mux.detection().reason;
	return `the pane layer is not available in this session: ${reason}. Start Clio inside a herdr session with \`clio-coder --with-panes\` to get panes`;
}

/** Fuzzy operator addressing shared by `close` and `zoom`: id, label, purpose; newest first. */
function matchOwnedPane(owned: ReadonlyArray<MuxPaneRecord>, target: string): MuxPaneRecord | null {
	const needle = target.trim().toLowerCase();
	const newestFirst = [...owned].reverse();
	return (
		newestFirst.find((record) => record.ref.paneId.toLowerCase() === needle) ??
		newestFirst.find((record) => record.label.toLowerCase().includes(needle)) ??
		newestFirst.find((record) => record.purpose === needle) ??
		null
	);
}

function inventory(records: ReadonlyArray<MuxPaneRecord>): ReadonlyArray<PanesInventoryEntry> {
	return records.map((record) => ({
		paneId: record.ref.paneId,
		tabId: record.ref.tabId,
		purpose: record.purpose,
		label: record.label,
		adopted: record.adopted === true,
	}));
}

export function createPanesRuntime(deps: PanesRuntimeDeps): PanesOperations {
	const probe = deps.resolveBinaryPath ?? resolveBinary;
	const journalRoot = deps.journalRoot ?? runEventJournalRoot;
	let yaziController: PanesYaziController | null = null;
	let watchController: PanesWatchController | null = null;
	let nextPendingOpen = 0;
	const pendingOpens = new Map<string, PanesInventoryEntry>();
	const beginPendingOpen = (label: string): string => {
		nextPendingOpen += 1;
		const id = `pending:${nextPendingOpen}`;
		pendingOpens.set(id, {
			paneId: id,
			tabId: "pending",
			purpose: "utility",
			label,
			adopted: false,
			pending: true,
		});
		return id;
	};
	const closedYaziStatus = (): PanesYaziStatus => ({
		mode: "closed",
		paneId: null,
		paneCwd: null,
		lastLineAt: null,
		droppedLines: 0,
	});

	/**
	 * Resolve one operator- or model-supplied target to a live dispatched run.
	 *
	 * Fuzzy agent id first, then runId prefix, most recent run winning: "the
	 * tester" is what an operator types; a run id is what a tool call carries.
	 * Retrying runs count as live; the watch pane shows them coming back.
	 */
	const matchRun = (target: string): { runId: string; agentId: string; status: string } | null => {
		const needle = target.trim().toLowerCase();
		if (needle.length === 0) return null;
		const snapshot = deps.getDispatchSnapshot();
		const live = [
			...snapshot.running.map((run) => ({ runId: run.runId, agentId: run.agentId, status: "running" })),
			...snapshot.retrying.map((run) => ({ runId: run.runId, agentId: run.agentId, status: "retrying" })),
		];
		// Newest first, so "the tester" means the tester the operator just started.
		const newestFirst = [...live].reverse();
		const byAgent = newestFirst.find((run) => run.agentId.toLowerCase().includes(needle));
		if (byAgent) return byAgent;
		return newestFirst.find((run) => run.runId.toLowerCase().startsWith(needle)) ?? null;
	};

	/** argv for one preset, once its binary has been found. */
	const presetArgv = (presetId: string, binaryPath: string): ReadonlyArray<string> | null => {
		if (presetId === "shell") return [binaryPath, "-l"];
		if (presetId === "logs") {
			const runId = (deps.newestJournalRunId ?? (() => newestRunEventJournalRunId(journalRoot())))();
			if (runId === null) return null;
			// `-F` rather than `-f`: the journal is recreated when its run's
			// directory is pruned, and a viewer following an inode would silently
			// stop at that point.
			return [binaryPath, "-n", "200", "-F", runEventJournalPath(runId, journalRoot())];
		}
		return null;
	};

	const show = async (target: string, source: PaneWatchSource): Promise<PanesShowResult> => {
		if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
		const match = matchRun(target);
		if (match === null) {
			// The candidate list is what turns a miss into a next step: it names
			// the runs that are actually live right now.
			const snapshot = deps.getDispatchSnapshot();
			const candidates = [
				...new Set([...snapshot.running.map((run) => run.agentId), ...snapshot.retrying.map((run) => run.agentId)]),
			];
			return { status: "not-found", target, candidates };
		}
		const decision = paneWatchDecision({ source, runStatus: match.status });
		if (!decision.open) return { status: "refused", reason: decision.reason };
		if (watchController === null) {
			return { status: "unavailable", reason: "the watch pane is not wired in this session" };
		}
		const watched = await watchController.watch(match.runId);
		if (watched.status !== "watching") return { status: "unavailable", reason: watched.reason };
		return { status: "watching", runId: match.runId, agentId: match.agentId, opened: watched.opened };
	};

	/**
	 * The files pane's open half, shared by `/files`, `/panes open files`, the
	 * keybinding, and the model tool. The settings gate and the missing-engine
	 * message live here so every door says the same thing.
	 */
	const openFiles = async (once: boolean): Promise<Exclude<PanesFilesResult, { status: "closed" }>> => {
		const preset = PANES_PRESETS[0];
		if (!deps.getSettings().interface.panes.files.enabled) {
			return { status: "refused", reason: "the files pane is disabled by interface.panes.files.enabled" };
		}
		if (!yaziController) {
			return { status: "unavailable", reason: "the files pane return path is not ready" };
		}
		const pendingId = beginPendingOpen(preset.id);
		try {
			const result = await yaziController.open(once ? { once: true } : undefined);
			if (result.status === "opened") {
				return { status: "opened", paneId: result.paneId, existing: result.existing };
			}
			if (result.status === "missing-binary") {
				return {
					status: "missing-binary",
					binary: result.binary,
					installHint: preset.installHint,
					// The engine's own resolution sentence, prefixed with the surface it
					// serves: an operator who typed `/files` should not have to know the
					// name of the program to read the answer.
					detail: `the files pane engine is not available: ${result.detail}`,
				};
			}
			return {
				status: result.status === "profile-error" ? "refused" : "unavailable",
				reason: result.reason,
			};
		} finally {
			pendingOpens.delete(pendingId);
		}
	};

	return {
		async files(action): Promise<PanesFilesResult> {
			if (action === "close") {
				await yaziController?.close();
				return { status: "closed" };
			}
			if (action === "toggle" && yaziController?.isOpen()) {
				await yaziController.close();
				return { status: "closed" };
			}
			return openFiles(action === "pick");
		},

		status(): PanesStatus {
			const detection = deps.mux.detection();
			const settings = deps.getSettings();
			const panes = settings.interface.panes;
			return {
				mode: deps.mux.mode,
				available: deps.mux.available(),
				reason: detection.reason,
				socketPath: detection.socketPath,
				server: detection.server,
				settings: {
					enabled: panes.enabled,
					notifications: panes.notifications,
					layout: panes.layout,
					journal: settings.fleet.history.journal,
					yazi: { ...panes.files },
				},
				yazi: yaziController?.status() ?? closedYaziStatus(),
				docks: deps.mux.docks().map((dock) => ({
					slot: dock.slot,
					paneId: dock.paneId,
					targetShare: dock.targetShare,
				})),
				panes: [...inventory(deps.mux.list()), ...pendingOpens.values()],
			};
		},

		show(target: string): Promise<PanesShowResult> {
			// The slash command and the tool share this implementation; the policy
			// treats both as operator pull, so the source only matters for logs.
			return show(target, "slash");
		},

		async open(request: { preset?: string; argv?: ReadonlyArray<string>; once?: boolean }): Promise<PanesOpenResult> {
			const cwd = deps.getCwd();
			if (request.preset !== undefined) {
				const presetId = resolvePanesPresetId(request.preset);
				const preset = presetId === null ? undefined : PANES_PRESETS.find((entry) => entry.id === presetId);
				if (!preset) {
					return { status: "refused", reason: `unknown preset: ${request.preset}` };
				}
				if (preset.id === "files") {
					const result = await openFiles(request.once === true);
					if (result.status === "opened") {
						return { status: "opened", label: preset.id, paneId: result.paneId, existing: result.existing };
					}
					if (result.status === "missing-binary") {
						return { ...result, preset: preset.id };
					}
					return result;
				}
				if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
				// One pane per preset. A second `/panes open shell` is a request to
				// see the shell that is already there, not to split the screen again;
				// the pane host is asked for focus so the operator lands in it.
				const live = deps.mux.list().find((record) => record.purpose === "utility" && record.label === preset.id);
				if (live) {
					await deps.mux.unzoomSelf();
					await deps.mux.focusPane(live.ref.paneId);
					return { status: "opened", label: preset.id, paneId: live.ref.paneId, existing: true };
				}
				const binaryPath = probe(preset.binary);
				if (binaryPath === null) {
					return {
						status: "missing-binary",
						preset: preset.id,
						binary: preset.binary,
						installHint: preset.installHint,
						detail: `${preset.binary} was not found (install with \`${preset.installHint}\`)`,
					};
				}
				const argv = presetArgv(preset.id, binaryPath);
				if (argv === null) {
					return {
						status: "refused",
						reason: `no dispatched run has written a journal under ${journalRoot()} yet; the logs pane follows the newest run once one starts`,
					};
				}
				const pendingId = beginPendingOpen(preset.id);
				try {
					const ref = await deps.mux.openUtilityPane({ argv, cwd, label: preset.id });
					if (ref === null) return { status: "unavailable", reason: `pane host refused to open ${preset.id}` };
					return { status: "opened", label: preset.id, paneId: ref.paneId };
				} finally {
					pendingOpens.delete(pendingId);
				}
			}
			if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
			const argv = request.argv ?? [];
			if (argv.length === 0) return { status: "refused", reason: "nothing to run" };
			const label = argv[0] ?? "pane";
			const pendingId = beginPendingOpen(label);
			try {
				const ref = await deps.mux.openUtilityPane({ argv, cwd, label });
				if (ref === null) return { status: "unavailable", reason: `pane host refused to open ${label}` };
				return { status: "opened", label, paneId: ref.paneId };
			} finally {
				pendingOpens.delete(pendingId);
			}
		},

		async zoom(target: string): Promise<PanesZoomResult> {
			if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
			const match = matchOwnedPane(deps.mux.list(), target.trim().length === 0 ? "watch" : target);
			if (!match) return { status: "not-found", target: target.trim().length === 0 ? "watch" : target };
			const changed = await deps.mux.zoomPane(match.ref.paneId, "toggle");
			if (!changed) {
				return { status: "unavailable", reason: "the pane host does not support zoom (protocol below pane.zoom)" };
			}
			return { status: "zoomed", paneId: match.ref.paneId, label: match.label };
		},

		async close(target: string): Promise<PanesCloseResult> {
			if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
			const owned = deps.mux.list();
			if (target === "all") {
				const labels: string[] = [];
				// Snapshot first: closing mutates the registry the list came from.
				for (const record of [...owned]) {
					if (await deps.mux.closePane(record.ref.paneId)) labels.push(record.label);
				}
				return { status: "closed", closed: labels.length, labels };
			}
			const match = matchOwnedPane(owned, target);
			if (!match) return { status: "not-found", target };
			const closed = await deps.mux.closePane(match.ref.paneId);
			return closed ? { status: "closed", closed: 1, labels: [match.label] } : { status: "not-found", target };
		},

		attachYazi(controller: PanesYaziController): () => void {
			yaziController = controller;
			return () => {
				if (yaziController === controller) yaziController = null;
			};
		},

		attachWatch(controller: PanesWatchController): () => void {
			watchController = controller;
			return () => {
				if (watchController === controller) watchController = null;
			};
		},
	};
}
