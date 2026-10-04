/**
 * The one implementation of `PanesOperations`, shared by `/panes` and the
 * `panes` orchestrator tool.
 *
 * Two rules run through it. Presets probe their binary through the toolchain
 * ladder *before* the pane is split: `openUtilityPane` delivers its command by
 * sending `exec <argv>` into the pane's shell, so a binary that is not there
 * kills the pane the instant it appears, and the operator sees a flicker
 * instead of an install hint. Every
 * mutation is scoped to panes Clio created, because the contract's registry
 * refuses anything else.
 *
 * `show` targets running dispatches, not panes: it resolves a fuzzy agent id
 * or run-id prefix against the live dispatch snapshot and points the shared
 * watch pane at the match, under the one policy decision in
 * `pane-policy.ts`. There is no per-run pane inventory to search any more.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { ClioSettings } from "../core/config.js";
import { resolveClioDirs } from "../core/xdg.js";
import type { DispatchSnapshot } from "../domains/dispatch/contract.js";
import {
	newestRunEventJournalRunId,
	runEventJournalPath,
	runEventJournalRoot,
} from "../domains/dispatch/run-event-journal.js";
import type { MuxContract, MuxPaneRecord } from "../domains/mux/index.js";
import type { MusicState } from "../domains/mux/music-operations.js";
import {
	PANE_HANDOFF_LABEL_SUFFIX,
	PANE_INTERRUPT_KEYS,
	PANE_PEER_IDS,
	PANES_PRESETS,
	type PanesCloseResult,
	type PanesDockReport,
	type PanesFilesResult,
	type PanesInventoryEntry,
	type PanesOpenResult,
	type PanesOperations,
	type PanesReadResult,
	type PanesSendResult,
	type PanesShowResult,
	type PanesStatus,
	type PanesWaitResult,
	type PanesWatchController,
	type PanesYaziController,
	type PanesYaziStatus,
	type PanesZoomResult,
	resolvePanesPresetId,
} from "../domains/mux/operations.js";
import { deliverPeerPrompt, PEER_INBOX_TOKEN } from "../domains/mux/peer-inbox.js";
import { resolveBinary } from "../tools/executables.js";
import { type PaneWatchSource, paneWatchDecision } from "./pane-policy.js";

export interface PanesRuntimeDeps {
	mux: MuxContract;
	getSettings: () => Readonly<ClioSettings>;
	/** Live dispatch state, used to turn a fuzzy agent id into a run id. */
	getDispatchSnapshot: () => DispatchSnapshot;
	getCwd: () => string;
	/** Admission before an external peer can read the workspace. */
	agentRefusal?: () => string | null;
	/** Injection seam for tests; production uses the toolchain ladder. */
	resolveBinaryPath?: (name: string) => string | null;
	/** Journal root override for tests. */
	journalRoot?: () => string;
	/** Newest run whose journal exists, for the `logs` preset. */
	newestJournalRunId?: () => string | null;
	/** The music pane's live facts. Absent where music cannot run; never gated by agentControl. */
	musicState?: () => Promise<MusicState>;
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

const DEFAULT_READ_LINES = 120;
const MAX_READ_LINES = 400;
const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;
const WAIT_GRACE_MS = 5_000;
const WAIT_POLL_MS = 500;
/** How long a send waits for a Clio peer to confirm it has the prompt. */
const PEER_RECEIPT_MS = 10_000;
/** Ceiling on one agent-state request inside a wait; the wait's own budget can only shorten it. */
const AGENT_RPC_MS = 5_000;

function noAgentReason(label: string): string {
	return `the pane host recognizes no running agent in ${label}: the peer has not finished starting, or it has exited`;
}

function unsupportedReason(label: string): string {
	return `the pane host does not admit prompts for ${label}, and Clio does not type into a peer by any other route. Ask the operator to give that pane its input`;
}

function blockedReason(label: string): string {
	return `${label} is blocked on an approval or a question for its operator; Clio does not answer for them`;
}

/** The panes `read`, `send` and `wait` may address: peers Clio handed off to, nothing else. */
function handoffPanes(owned: ReadonlyArray<MuxPaneRecord>): ReadonlyArray<MuxPaneRecord> {
	return owned.filter((record) => record.label.endsWith(PANE_HANDOFF_LABEL_SUFFIX));
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

/**
 * The sentence `/quit` prints about the panes it did not close, or null when
 * there are none.
 *
 * Policy (#272): docks close with the session and utility panes stay. A dock
 * is a Clio surface (the files pane, the workers watch pane), so it goes the
 * way a native application's windows go. A pane opened with `/panes open
 * shell|logs|<argv>` is a terminal the operator may be typing in, and killing
 * it on quit is the one thing a pane host must never do behind the operator's
 * back. The next session does not adopt it either, so without this line the
 * pane simply sat there with nothing naming it. Computed before the mux
 * domain stops, because shutdown forgets its registry.
 */
export function describePanesLeftBehind(mux: Pick<MuxContract, "list" | "docks">): string | null {
	const dockIds = new Set(mux.docks().map((dock) => dock.paneId));
	const left = mux.list().filter((record) => !dockIds.has(record.ref.paneId));
	if (left.length === 0) return null;
	const named = left.map((record) => `${record.label} (${record.ref.paneId})`).join(", ");
	return `Clio left ${left.length} ${left.length === 1 ? "pane" : "panes"} open in herdr: ${named}. Utility panes stay when a session ends; the docks closed with it. Next time run \`/panes close all\` before \`/quit\` to take them with you, or close ${left.length === 1 ? "it" : "them"} now with \`herdr pane close <paneId>\`.`;
}

export function createPanesRuntime(deps: PanesRuntimeDeps): PanesOperations {
	const probe = deps.resolveBinaryPath ?? resolveBinary;
	const journalRoot = deps.journalRoot ?? runEventJournalRoot;
	let yaziController: PanesYaziController | null = null;
	let watchController: PanesWatchController | null = null;
	let nextPendingOpen = 0;
	const pendingOpens = new Map<string, PanesInventoryEntry>();
	/** Request ids of sends a peer took but never confirmed, so a repeat reuses the id and cannot double-deliver. */
	const unconfirmedPeerRequests = new Map<string, string>();
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
	const openFiles = async (
		once: boolean,
	): Promise<Exclude<PanesFilesResult, { status: "closed" } | { status: "hidden" }>> => {
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
				return {
					status: "opened",
					paneId: result.paneId,
					existing: result.existing,
					...(result.revealed ? { revealed: true } : {}),
				};
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
			if (action === "hide" || (action === "toggle" && yaziController?.visibility() === "visible")) {
				const hidden = await yaziController?.hide();
				if (hidden === undefined) return { status: "unavailable", reason: "the files pane is not open" };
				return hidden.status === "hidden" ? { status: "hidden" } : { status: "unavailable", reason: hidden.reason };
			}
			return openFiles(action === "pick");
		},

		async docks(): Promise<ReadonlyArray<PanesDockReport>> {
			const settings = deps.getSettings();
			const reports: PanesDockReport[] = [];
			for (const slot of ["files", "workers", "music"] as const) {
				const state = deps.mux.dockVisibility(slot);
				let detail: string | undefined;
				if (slot === "music") {
					const music = state === "closed" ? null : await deps.musicState?.();
					if (music?.playback === "playing") detail = music.title ? `playing ${music.title}` : "playing";
					else if (music?.playback === "paused") detail = "paused";
					else if (!settings.integrations.music.enabled) detail = "integrations.music.enabled is false";
				} else if (slot === "files" && state === "closed" && !settings.interface.panes.files.enabled) {
					detail = "interface.panes.files.enabled is false";
				}
				reports.push({ slot, state, ...(detail === undefined ? {} : { detail }) });
			}
			return reports;
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
					hidden: dock.hidden,
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
						return {
							status: "opened",
							label: preset.id,
							paneId: result.paneId,
							existing: result.existing,
							...(result.revealed ? { revealed: true } : {}),
						};
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

		async handoff(request): Promise<PanesOpenResult> {
			const refusal = deps.agentRefusal?.() ?? null;
			if (refusal !== null) return { status: "refused", reason: refusal };
			if (!PANE_PEER_IDS.includes(request.peer))
				return { status: "refused", reason: `unknown coding peer: ${request.peer}` };
			if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
			const brief = request.brief?.trim() ?? "";
			if (Buffer.byteLength(brief, "utf8") > 8_192) {
				return { status: "refused", reason: "peer handoff brief exceeds 8192 UTF-8 bytes" };
			}
			let cwd: string;
			try {
				const selected = request.cwd ?? deps.getCwd();
				cwd = realpathSync(isAbsolute(selected) ? selected : resolve(deps.getCwd(), selected));
				if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
			} catch {
				return {
					status: "refused",
					reason: `peer handoff workspace is not an existing directory: ${request.cwd ?? deps.getCwd()}`,
				};
			}
			const binary =
				request.peer === "claude-code"
					? "claude"
					: request.peer === "antigravity"
						? "agy"
						: request.peer === "clio"
							? "clio-coder"
							: request.peer;
			const binaryPath = probe(binary);
			if (binaryPath === null) {
				return {
					status: "missing-binary",
					preset: request.peer,
					binary,
					installHint: `install ${binary}`,
					detail: `${binary} was not found`,
				};
			}
			const argv = [binaryPath];
			if (brief) {
				// A second Clio takes no prompt on its command line; its task is typed in.
				if (request.peer === "clio") {
					return {
						status: "refused",
						reason:
							"a second Clio takes no brief on its command line: open it without one, then give it its task with action=send",
					};
				}
				if (request.peer === "antigravity") argv.push("--prompt-interactive", brief);
				else if (request.peer === "opencode") argv.push("--prompt", brief);
				else if (request.peer === "pi") argv.push("--", brief);
				else argv.push(brief);
			}
			const label = `${request.peer}${PANE_HANDOFF_LABEL_SUFFIX}`;
			const pendingId = beginPendingOpen(label);
			try {
				const ref = await deps.mux.openUtilityPane({ argv, cwd, label, title: label });
				if (ref === null) return { status: "unavailable", reason: `pane host refused to open ${label}` };
				return { status: "opened", label, paneId: ref.paneId, cwd };
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

		async read(target: string, lines = DEFAULT_READ_LINES): Promise<PanesReadResult> {
			if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
			const match = matchOwnedPane(handoffPanes(deps.mux.list()), target);
			if (!match) return { status: "not-found", target };
			const read = await deps.mux.readPane(match.ref.paneId, Math.max(1, Math.min(MAX_READ_LINES, Math.trunc(lines))));
			if (read === null) return { status: "unavailable", reason: `the pane host could not read ${match.label}` };
			return { status: "read", paneId: match.ref.paneId, label: match.label, text: read.text, truncated: read.truncated };
		},

		async send(request): Promise<PanesSendResult> {
			const refusal = deps.agentRefusal?.() ?? null;
			if (refusal !== null) return { status: "refused", reason: refusal };
			if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
			const text = request.text ?? "";
			const interrupt = request.interrupt;
			if (text.length > 0 && interrupt !== undefined) {
				return { status: "refused", reason: "send takes text or an interrupt, never both in one call" };
			}
			if (text.length === 0 && interrupt === undefined) {
				return { status: "refused", reason: "nothing to send: give text, or interrupt with esc or ctrl+c" };
			}
			if (interrupt !== undefined && !PANE_INTERRUPT_KEYS.includes(interrupt)) {
				return {
					status: "refused",
					reason: `the only keys Clio presses in a peer are ${PANE_INTERRUPT_KEYS.join(" and ")}`,
				};
			}
			if (Buffer.byteLength(text, "utf8") > 8_192) {
				return { status: "refused", reason: "pane input exceeds 8192 UTF-8 bytes" };
			}
			const match = matchOwnedPane(handoffPanes(deps.mux.list()), request.target);
			if (!match) return { status: "not-found", target: request.target };
			const paneId = match.ref.paneId;
			// Both forms need a live recognized peer that is not blocked. For text
			// the host checks again under its own lock; for an interrupt this
			// reading is the check, and an interrupt cannot approve anything.
			const peer = await deps.mux.paneAgent(paneId);
			if (peer === null) return { status: "unavailable", reason: `the pane host could not report on ${match.label}` };
			if (peer.agent === null) return { status: "refused", reason: noAgentReason(match.label) };
			if (peer.state === "blocked") return { status: "refused", reason: blockedReason(match.label) };
			if (interrupt !== undefined) {
				if (!(await deps.mux.interruptPane(paneId, interrupt))) {
					return { status: "unavailable", reason: `the pane host refused the interrupt for ${match.label}` };
				}
				return { status: "sent", paneId, label: match.label };
			}
			// A Clio peer is reached through its own inbox, never its terminal: the
			// pane host admits prompts only for agent kinds it knows, and text typed
			// into a Clio could land in an approval dialog.
			if (match.label === `clio${PANE_HANDOFF_LABEL_SUFFIX}`) {
				const detection = deps.mux.detection();
				const key = `${paneId}\u0000${text}`;
				const delivery = await deliverPeerPrompt({
					stateDir: resolveClioDirs().state,
					token: peer.tokens[PEER_INBOX_TOKEN],
					paneId,
					socketPath: detection.socketPath ?? "",
					fromPaneId: detection.self.paneId ?? "",
					text,
					timeoutMs: PEER_RECEIPT_MS,
					...(unconfirmedPeerRequests.has(key) ? { requestId: unconfirmedPeerRequests.get(key) as string } : {}),
					...(request.signal ? { signal: request.signal } : {}),
				});
				if (delivery.status === "unconfirmed") unconfirmedPeerRequests.set(key, delivery.requestId);
				else unconfirmedPeerRequests.delete(key);
				if (delivery.status === "accepted") {
					return { status: "sent", paneId, label: match.label, ...(delivery.via === "queue" ? { queued: true } : {}) };
				}
				if (delivery.status === "refused") {
					return {
						status: "refused",
						reason:
							delivery.reason === "blocked"
								? blockedReason(match.label)
								: `${match.label} did not take the prompt (${delivery.reason}): ${delivery.detail}`,
					};
				}
				if (delivery.status === "unconfirmed") {
					return {
						status: "unconfirmed",
						paneId,
						label: match.label,
						reason: `${delivery.reason}. It may already be on its queue: read the pane before deciding, and a repeat of the same text is delivered at most once`,
					};
				}
				return { status: "refused", reason: `nothing was delivered to ${match.label}: ${delivery.reason}` };
			}
			const outcome = await deps.mux.promptPane(paneId, text);
			if (outcome.status === "sent") return { status: "sent", paneId, label: match.label };
			if (outcome.status === "failed") return { status: "unavailable", reason: outcome.reason };
			return {
				status: "refused",
				reason:
					outcome.why === "blocked"
						? blockedReason(match.label)
						: outcome.why === "unsupported"
							? unsupportedReason(match.label)
							: noAgentReason(match.label),
			};
		},

		async wait(target: string, options = {}): Promise<PanesWaitResult> {
			if (!deps.mux.available()) return { status: "unavailable", reason: unavailableReason(deps.mux) };
			const match = matchOwnedPane(handoffPanes(deps.mux.list()), target);
			if (!match) return { status: "not-found", target };
			const paneId = match.ref.paneId;
			const signal = options.signal;
			const budget = Math.max(1_000, Math.min(MAX_WAIT_MS, Math.trunc(options.timeoutMs ?? DEFAULT_WAIT_MS)));
			const started = performance.now();
			// A prompt sent a moment ago has not flipped the peer to `working` yet,
			// so an idle reading inside the grace window is not a settled one.
			let sawWorking = false;
			let last = "unknown";
			const cancelled = (): PanesWaitResult => ({ status: "cancelled", paneId, label: match.label });
			for (;;) {
				const remaining = budget - (performance.now() - started);
				if (remaining <= 0) break;
				if (signal?.aborted) return cancelled();
				// The reading carries the abort and what is left of the budget, so a
				// host that stops answering cannot hold the wait past either.
				const peer = await deps.mux.paneAgent(paneId, {
					timeoutMs: Math.max(1, Math.min(AGENT_RPC_MS, Math.ceil(remaining))),
					...(signal ? { signal } : {}),
				});
				// An abort that landed while the reading was in flight wins over
				// whatever the reading says.
				if (signal?.aborted) return cancelled();
				if (peer === null) {
					// Either the pane closed or the host did not answer. Only the
					// registry can tell them apart, and only the first is an ending.
					if (!deps.mux.list().some((record) => record.ref.paneId === paneId)) {
						return { status: "gone", target: match.label };
					}
					last = "unknown";
				} else if (peer.agent === null) {
					last = "unrecognized";
				} else {
					last = peer.state;
					if (peer.state === "working") sawWorking = true;
					else if (peer.state === "blocked") return { status: "settled", paneId, label: match.label, state: "blocked" };
					else if (
						(peer.state === "idle" || peer.state === "done") &&
						(sawWorking || performance.now() - started >= WAIT_GRACE_MS)
					) {
						return { status: "settled", paneId, label: match.label, state: peer.state };
					}
				}
				const left = budget - (performance.now() - started);
				if (left <= 0) break;
				try {
					await sleep(Math.min(WAIT_POLL_MS, left), undefined, signal ? { signal } : {});
				} catch {
					// The only way this sleep rejects is the abort.
					return cancelled();
				}
			}
			return { status: "timed-out", paneId, label: match.label, state: last };
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
