import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BusChannels, type ContextActivityPayload } from "../../core/bus-events.js";
import { CONTEXT_OPERATION_CUSTOM_TYPE, createContextOperation } from "../../core/context-operation.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { clioDataDir, clioStateDir } from "../../core/xdg.js";
import type { ConfigContract } from "../config/contract.js";
import { loadMemoryRecordsSync } from "../memory/index.js";
import { describeValidationContract, loadValidationContract } from "../safety/index.js";
import { createSemanticBackgroundRefresh } from "../semantic-app/background.js";
import { readSessionEntriesForId } from "../session/archive-readers.js";
import type { SessionContract } from "../session/contract.js";
import { foldDecisionBoard } from "../session/decision-board.js";
import { filterEntriesToActivePath } from "../session/tree/active-path.js";
import { detectProjectTypeHint, type ProjectType } from "../session/workspace/project-type.js";
import { adoptionSourcesChanged } from "./adoption.js";
import { runBootstrap } from "./bootstrap.js";
import { runContextClear } from "./clear.js";
import { loadProjectClioMd } from "./clio-md.js";
import { codewikiPath } from "./codewiki/artifact.js";
import { coordinateCodewikiExclusive, coordinateCodewikiWrite, drainCodewikiWrites } from "./codewiki/coordinator.js";
import type { ContextContract, ContextState } from "./contract.js";
import {
	bootstrapOperationFacts,
	ContextOperationAbortError,
	clearOperationFacts,
	refreshOperationFacts,
} from "./operation-result.js";
import { renderPromptContext } from "./prompt-context.js";
import { runContextRefresh } from "./refresh.js";
import { type ClioProjectState, readClioState, writeClioState } from "./state.js";

/**
 * Persist the current Clio state for `cwd`, preserving imported-context source
 * tracking and stamping the supplied fingerprint/index time. Shared by the session-start
 * freshness check, in-session incremental updates, and session stop.
 */
function persistState(
	cwd: string,
	fingerprint: ClioProjectState["fingerprint"],
	indexedAt: string,
	prev: ClioProjectState | null,
	codewiki: import("./codewiki/schema.js").Codewiki,
	projectType: ProjectType,
): void {
	writeClioState(
		cwd,
		{
			version: 1,
			projectType: prev?.projectType ?? projectType,
			fingerprint,
			codewikiVersion: codewiki.version,
			...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
			...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
			...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
			...(prev?.bootstrapFingerprint ? { bootstrapFingerprint: prev.bootstrapFingerprint } : {}),
			...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
			lastSessionAt: prev?.lastSessionAt ?? new Date().toISOString(),
			lastIndexedAt: indexedAt,
		},
		codewiki,
	);
}

/**
 * Rebuild the codewiki when it is missing or the working tree has drifted since
 * the last full index. Runs once at session start (catches branch switches, git
 * pulls, and out-of-session edits). Skips projects that were never indexed so we
 * never index an arbitrary directory unprompted, and resolves false for them so
 * the semantic background refresh skips them too. This is the only place a
 * session reconciles the index with the tree: in-session edits arrive through
 * `noteFileChanges`, and stop() deliberately does no indexing at all.
 *
 * Every phase runs through one shared slicer. This work overlaps a mounted TUI:
 * before slicing, a drifted tree on a 1100-file repository held the event loop
 * for roughly four seconds at session start, during which the prompt was on
 * screen and keystrokes queued silently. `void` on the promise never helped,
 * because nothing inside it awaited.
 */
async function ensureCodewikiFresh(cwd: string): Promise<boolean> {
	const state = readClioState(cwd);
	if (!state && !existsSync(codewikiPath(cwd))) return false;
	const indexedAt = new Date().toISOString();
	await coordinateCodewikiWrite(
		cwd,
		(current, workspace) => {
			const language = readClioState(workspace)?.projectType ?? current?.language;
			return {
				kind: "ensure",
				cwd,
				...(language ? { language } : {}),
				current,
				previous: readClioState(workspace)?.fingerprint ?? null,
			};
		},
		{
			afterCommit: ({ codewiki, fingerprint }, workspace) =>
				persistState(workspace, fingerprint, indexedAt, readClioState(workspace), codewiki, codewiki.language),
		},
	);
	return true;
}

const CONTEXT_STATE_CACHE_TTL_MS = 1500;

function memoryCount(): number {
	try {
		return loadMemoryRecordsSync(clioDataDir()).length;
	} catch {
		return 0;
	}
}

function resolveClioMdState(cwd: string): ContextState["clioMd"] {
	const clio = loadProjectClioMd(cwd);
	if (clio.files.length === 0 && clio.errors.length === 0) return "none";
	if (clio.errors.length > 0) return "malformed";
	const state = readClioState(cwd);
	const localStandardIsEffective = clio.files.some((file) => file.path === join(resolve(cwd), "CLIO-CODER.md"));
	if (
		localStandardIsEffective &&
		state?.contextSources !== undefined &&
		adoptionSourcesChanged(state.contextSources, { cwd })
	) {
		return "stale";
	}
	return "ok";
}

function createContextStateReader(): { read(cwd?: string): ContextState; invalidate(cwd?: string): void } {
	let cached: { cwd: string; at: number; state: ContextState } | null = null;
	return {
		read(cwd = process.cwd()): ContextState {
			const now = Date.now();
			if (cached && cached.cwd === cwd && now - cached.at < CONTEXT_STATE_CACHE_TTL_MS) return cached.state;
			const state: ContextState = { clioMd: resolveClioMdState(cwd), memoryCount: memoryCount() };
			cached = { cwd, at: now, state };
			return state;
		},
		invalidate(cwd) {
			if (!cached) return;
			if (!cwd || cached.cwd === cwd) cached = null;
		},
	};
}

export interface ContextBundleOptions {
	noContextFiles?: boolean;
	/**
	 * Headless runs have no slash commands, so the bootstrap hint names the CLI
	 * subcommand. `json` keeps stderr free of suggestions a machine consumer
	 * cannot act on; malformed-file and contract warnings still print.
	 */
	headless?: "text" | "json";
}

function collectStartupHints(cwd: string, options: ContextBundleOptions = {}): string[] {
	const initCommand = options.headless === undefined ? "/context init" : "clio-coder context init";
	// A scripted or piped headless run has no operator reading stderr, so the
	// bootstrap suggestion is only for an interactive session or a stderr TTY.
	const suggest = options.headless === undefined || (options.headless === "text" && process.stderr.isTTY === true);
	const hints: string[] = [];
	// Runs at session start with the TUI mounting. Use a root-only hint; an
	// indexed project answers from the type its state
	// already records; only a never-indexed directory pays for detection.
	const state = readClioState(cwd);
	let projectType: ReturnType<typeof detectProjectTypeHint>;
	try {
		projectType = state?.projectType ?? detectProjectTypeHint(cwd);
	} catch {
		projectType = "unknown";
	}
	const clio = loadProjectClioMd(cwd);
	if (
		clio.files.length === 0 &&
		clio.errors.length === 0 &&
		projectType !== "unknown" &&
		options.noContextFiles !== true &&
		suggest
	) {
		hints.push(`clio-coder: No CLIO-CODER.md detected. Run ${initCommand} to explore the repo and bootstrap context.`);
	}
	for (const issue of clio.errors) {
		hints.push(`clio-coder: malformed ${issue.path} ignored: ${issue.error}`);
	}
	// An invalid validation contract leaves rigor at normal; say so once here
	// rather than letting the finish gate quietly behave as if no contract existed.
	const contract = loadValidationContract(cwd);
	if (!contract.ok) {
		hints.push(`clio-coder: validation contract ignored, rigor stays normal: ${describeValidationContract(contract)}`);
	}
	if (!state) return hints;
	if (suggest && state.contextSources !== undefined && adoptionSourcesChanged(state.contextSources, { cwd })) {
		hints.push(`clio-coder: Imported agent context changed. Run ${initCommand} --adopt to refresh.`);
	}
	return hints;
}

export function createContextBundle(
	_context: DomainContext,
	options: ContextBundleOptions = {},
): DomainBundle<ContextContract> {
	let lastCwd = process.cwd();
	let stopping = false;
	let startupHints: string[] = [];
	const contextState = createContextStateReader();
	const semanticBackground = createSemanticBackgroundRefresh(() =>
		_context.getContract<ConfigContract>("config")?.get(),
	);
	const onStart = (): void => {
		lastCwd = process.cwd();
		void ensureCodewikiFresh(lastCwd)
			.then((indexed) => {
				if (indexed) semanticBackground.schedule(lastCwd);
			})
			.catch(() => {
				// Indexing is best-effort; a failed refresh must not block session start.
			});
		startupHints = collectStartupHints(lastCwd, options);
		if (process.env.CLIO_CODER_INTERACTIVE === "1") return;
		for (const hint of startupHints) process.stderr.write(`${hint}\n`);
	};

	// Incremental updates are read-modify-write on the artifact; overlapping runs
	// would compute from a stale base and drop each other's records, so batches
	// serialize through this queue and stop() drains it before the process exits.
	let incrementalQueue: Promise<void> = Promise.resolve();
	const noteFileChanges = (paths: ReadonlyArray<string>, cwd: string = lastCwd): void => {
		if (stopping) return;
		const workspace = resolve(cwd);
		incrementalQueue = incrementalQueue
			.then(async () => {
				if (paths.length === 0) return;
				const rel = paths
					.map((p) => (isAbsolute(p) ? relative(workspace, p) : p))
					.filter((p) => p.length > 0 && !p.startsWith(".."));
				// Fires after every write the agent makes, mid-turn, with the TUI
				// mounted; an edge rebuild here is the same cost as one at start.
				await coordinateCodewikiWrite(
					workspace,
					(current) =>
						current
							? {
									kind: "incremental",
									cwd: workspace,
									current,
									paths: rel,
									previous: readClioState(workspace)?.fingerprint ?? null,
								}
							: null,
					{
						requireExisting: true,
						afterCommit: ({ codewiki, fingerprint, changed }, committedWorkspace) => {
							if (!changed) return;
							persistState(
								committedWorkspace,
								fingerprint,
								new Date().toISOString(),
								readClioState(committedWorkspace),
								codewiki,
								codewiki.language,
							);
							semanticBackground.schedule(committedWorkspace);
						},
					},
				);
				contextState.invalidate(workspace);
			})
			.catch(() => {
				// Best-effort: never let incremental indexing surface as a tool error.
			});
	};

	let unsubscribeSessionStart: (() => void) | null = null;
	const extension: DomainExtension = {
		start() {
			unsubscribeSessionStart = _context.bus.on(BusChannels.SessionStart, onStart);
		},
		async stop() {
			stopping = true;
			await semanticBackground.stop();
			unsubscribeSessionStart?.();
			unsubscribeSessionStart = null;
			// Everything the session changed already went through noteFileChanges,
			// so the only work still owed at stop is the tail of that queue. Nothing
			// here re-indexes: a stop-time rebuild used to run the same full scan as
			// start on every exit, on the shutdown path, where one synchronous
			// tree-sitter parse of a large file holds the event loop past every
			// shutdown budget (issue #99). Out-of-band drift is start's job on the
			// next session, and a never-indexed cwd stays that way; indexing an
			// arbitrary directory because a process exited in it is not a favor.
			await Promise.all([incrementalQueue, drainCodewikiWrites(lastCwd)]);
			if (!readClioState(lastCwd)) return;
			await coordinateCodewikiExclusive(lastCwd, (workspace) => {
				// Read under the same lease as index publication: a late session
				// timestamp cannot overwrite another process's newer source snapshot.
				const state = readClioState(workspace);
				if (state) writeClioState(workspace, { ...state, lastSessionAt: new Date().toISOString() });
			});
		},
	};

	function promptSourceState(cwd: string): string | null {
		try {
			return JSON.stringify(renderPromptContext(cwd));
		} catch {
			// Enumeration can fail on unreadable or oversized trees. Bookkeeping
			// must not prevent clear/recovery or replace the operation's own error.
			return null;
		}
	}

	/**
	 * Explicit operations are snapshot boundaries. A rejected operation can still
	 * have published an index or handbook before failing; compare the actual
	 * project context so that failure refreshes when visible sources changed
	 * or could not be inspected.
	 * These disk reads happen at the command boundary, never on ordinary turns.
	 */
	async function withPromptSourceBoundary<T>(
		cwd: string,
		operation: () => Promise<T>,
		committed: (result: T) => boolean,
	): Promise<T> {
		const workspace = resolve(cwd);
		const before = promptSourceState(workspace);
		let refreshSources = false;
		try {
			const result = await operation();
			refreshSources = committed(result);
			return result;
		} finally {
			if (refreshSources || before === null || promptSourceState(workspace) !== before) {
				contextState.invalidate(workspace);
				_context.bus.emit(BusChannels.ContextSourcesChanged, { cwd: workspace });
			}
		}
	}

	let activeOperation: { id: string; sessionId: string | null; cwd: string; controller: AbortController } | null = null;
	function beginOperation(
		kind: "context-init" | "context-clear" | "context-refresh",
		cwd: string,
		signal?: AbortSignal,
	) {
		if (activeOperation !== null) throw new Error("Another project context operation is still running.");
		const session = _context.getContract<SessionContract>("session");
		if (session && !session.current()) session.create({ cwd });
		const sessionId = session?.current()?.id ?? null;
		const controller = new AbortController();
		const operation = createContextOperation(
			{ kind, cwd, sessionId, origin: "operator", reason: "operator command" },
			(event) => {
				if (event.operation?.outcome) activeOperation = null;
				_context.bus.emit(BusChannels.ContextActivity, event);
				if (
					event.operation?.outcome &&
					sessionId &&
					session?.current()?.id === sessionId &&
					resolve(process.cwd()) === resolve(cwd)
				) {
					try {
						session.appendEntry({
							kind: "custom",
							customType: CONTEXT_OPERATION_CUSTOM_TYPE,
							parentTurnId: session.tree(sessionId).leafId ?? null,
							data: event.operation,
						});
					} catch {
						// A ledger failure must not change a completed filesystem operation into a failure.
					}
				}
			},
		);
		activeOperation = { id: operation.operation.id, sessionId, cwd: resolve(cwd), controller };
		operation.start(
			kind === "context-init" ? "scan" : kind === "context-refresh" ? "codewiki" : "state",
			"Preparing project context",
		);
		return { ...operation, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal };
	}

	const contract: ContextContract = {
		cancelOperation(sessionId, cwd, operationId) {
			if (
				!activeOperation ||
				activeOperation.sessionId !== sessionId ||
				activeOperation.cwd !== resolve(cwd) ||
				(operationId !== undefined && activeOperation.id !== operationId)
			)
				return false;
			activeOperation.controller.abort();
			return true;
		},
		async runBootstrap(input) {
			const operation = beginOperation("context-init", input?.cwd ?? process.cwd(), input?.signal);
			const warnings: string[] = [];
			const io = {
				stdout: (text: string) => input?.io?.stdout(text),
				stderr: (text: string) => {
					warnings.push(boundedExternalDiagnostic(text, 1024));
					input?.io?.stderr(text);
				},
			};
			const emitProgress = (event: Omit<ContextActivityPayload, "kind" | "at">): void => {
				if (event.phase !== "done") operation.progress(event);
				input?.onProgress?.(event);
			};
			try {
				const result = await withPromptSourceBoundary(
					input?.cwd ?? process.cwd(),
					() => runBootstrap({ ...input, signal: operation.signal, io, onProgress: emitProgress }),
					(result) => result.summary.action !== "previewed",
				);
				const cwd = input?.cwd ?? process.cwd();
				contextState.invalidate(cwd);
				if (cwd === lastCwd) startupHints = collectStartupHints(cwd, options);
				if (result.summary.adoption.conflictCount)
					warnings.push(`${result.summary.adoption.conflictCount} import conflicts detected.`);
				if (result.preload.mode === "partial" || result.preload.mode === "synopsis")
					warnings.push(`Project instructions: ${result.preload.label}`);
				if (result.summary.action === "proposed") warnings.push("Review the proposal before /context init --apply.");
				operation.finish(result.summary.action === "previewed" ? "previewed" : "completed", "Context init finished", {
					facts: bootstrapOperationFacts(result),
					warnings: warnings.slice(0, 8),
				});
				return result;
			} catch (err) {
				operation.finish(
					err instanceof Error && err.name === "AbortError" ? "cancelled" : "failed",
					err instanceof Error ? err.message : String(err),
					{
						warnings: warnings.slice(0, 8),
						...(err instanceof ContextOperationAbortError
							? {
									facts: err.facts,
									warnings: [
										...warnings,
										...(err.facts.length ? ["Earlier committed context changes were retained."] : []),
									].slice(0, 8),
								}
							: {}),
					},
				);
				emitProgress({
					phase: "done",
					status: "failed",
					message: "context init failed",
					detail: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
		},
		async runContextClear(input) {
			const operation = beginOperation("context-clear", input?.cwd ?? process.cwd(), input?.signal);
			const warnings: string[] = [];
			const io = {
				stdout: (text: string) => input?.io?.stdout(text),
				stderr: (text: string) => {
					warnings.push(boundedExternalDiagnostic(text, 1024));
					input?.io?.stderr(text);
				},
			};
			const emitProgress = (event: Omit<ContextActivityPayload, "kind" | "at">): void => {
				if (event.phase !== "done") operation.progress(event);
			};
			emitProgress({ phase: "state", status: "started", message: "clearing accumulated project context" });
			try {
				const result = await withPromptSourceBoundary(
					input?.cwd ?? process.cwd(),
					() => runContextClear({ ...input, signal: operation.signal, io }),
					(result) => result.action === "cleared",
				);
				const cwd = input?.cwd ?? process.cwd();
				contextState.invalidate(cwd);
				if (cwd === lastCwd) startupHints = collectStartupHints(cwd, options);
				emitProgress({
					phase: "done",
					status: "completed",
					message: result.action === "cancelled" ? "context reset cancelled" : "context cleared",
				});
				operation.finish(
					result.action === "cancelled" ? "cancelled" : "completed",
					result.action === "cancelled" ? "Context reset cancelled" : "Context reset finished",
					{
						facts: clearOperationFacts(result),
						warnings: warnings.slice(0, 8),
					},
				);
				return result;
			} catch (err) {
				operation.finish(
					err instanceof Error && err.name === "AbortError" ? "cancelled" : "failed",
					err instanceof Error ? err.message : String(err),
					{
						warnings: warnings.slice(0, 8),
						...(err instanceof ContextOperationAbortError
							? {
									facts: err.facts,
									warnings: [
										...warnings,
										...(err.facts.length ? ["Earlier committed context changes were retained."] : []),
									].slice(0, 8),
								}
							: {}),
					},
				);
				emitProgress({
					phase: "done",
					status: "failed",
					message: "context clear failed",
					detail: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
		},
		async runContextRefresh(input) {
			const operation = beginOperation("context-refresh", input?.cwd ?? process.cwd(), input?.signal);
			const warnings: string[] = [];
			const io = {
				stdout: (text: string) => input?.io?.stdout(text),
				stderr: (text: string) => {
					warnings.push(boundedExternalDiagnostic(text, 1024));
					input?.io?.stderr(text);
				},
			};
			const emitProgress = (event: Omit<ContextActivityPayload, "kind" | "at">): void => {
				if (event.phase !== "done") operation.progress(event);
				input?.onProgress?.(event);
			};
			try {
				const result = await withPromptSourceBoundary(
					input?.cwd ?? process.cwd(),
					async () =>
						runContextRefresh({
							...input,
							signal: operation.signal,
							io,
							...(input?.wiki ? { decisions: input.decisions ?? (await currentDecisions(_context)) } : {}),
							onProgress: emitProgress,
						}),
					() => true,
				);
				const cwd = input?.cwd ?? process.cwd();
				contextState.invalidate(cwd);
				if (cwd === lastCwd) startupHints = collectStartupHints(cwd, options);
				operation.finish(
					result.wiki?.status === "failed" ? "failed" : "completed",
					result.wiki?.status === "failed" ? "Wiki refresh failed; index refreshed" : "Context refresh finished",
					{
						facts: refreshOperationFacts(result),
						warnings: [...warnings, ...(result.hint ? [result.hint] : []), ...(result.wiki?.problems ?? [])].slice(0, 8),
					},
				);
				return result;
			} catch (err) {
				operation.finish(
					err instanceof Error && err.name === "AbortError" ? "cancelled" : "failed",
					err instanceof Error ? err.message : String(err),
					{
						warnings: warnings.slice(0, 8),
						...(err instanceof ContextOperationAbortError
							? {
									facts: err.facts,
									warnings: [
										...warnings,
										...(err.facts.length ? ["Earlier committed context changes were retained."] : []),
									].slice(0, 8),
								}
							: {}),
					},
				);
				emitProgress({
					phase: "done",
					status: "failed",
					message: "context refresh failed",
					detail: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
		},
		renderPromptContext,
		contextState: contextState.read,
		startupHints: () => [...startupHints],
		noteFileChanges,
	};

	return { extension, contract };
}

async function currentDecisions(context: DomainContext) {
	const session = context.getContract<SessionContract>("session");
	const current = session?.current();
	if (!session || !current) return [];
	session.flushAppends?.();
	const read = await readSessionEntriesForId(clioStateDir(), current.id);
	return foldDecisionBoard(filterEntriesToActivePath(read.entries, session.tree(current.id).leafId ?? undefined));
}
