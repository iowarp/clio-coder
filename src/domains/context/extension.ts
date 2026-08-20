import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BusChannels, type ContextActivityPayload } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { clioDataDir } from "../../core/xdg.js";
import { loadMemoryRecordsSync } from "../memory/index.js";
import { detectProjectType, type ProjectType } from "../session/workspace/project-type.js";
import { adoptionSourcesChanged } from "./adoption.js";
import { runBootstrap } from "./bootstrap.js";
import { runContextClear } from "./clear.js";
import { loadProjectClioMd } from "./clio-md.js";
import { codewikiPath } from "./codewiki/artifact.js";
import { coordinateCodewikiWrite, drainCodewikiWrites } from "./codewiki/coordinator.js";
import type { ContextContract, ContextState } from "./contract.js";
import { renderPromptContext } from "./prompt-context.js";
import { runContextRefresh } from "./refresh.js";
import { type ClioProjectState, readClioState, writeClioState } from "./state.js";
import { runWikiGenerate } from "./wiki/generate.js";

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
	codewikiVersion: number,
	projectType: ProjectType,
): void {
	writeClioState(cwd, {
		version: 1,
		projectType: prev?.projectType ?? projectType,
		fingerprint,
		codewikiVersion,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		lastSessionAt: prev?.lastSessionAt ?? new Date().toISOString(),
		lastIndexedAt: indexedAt,
	});
}

/**
 * Rebuild the codewiki when it is missing or the working tree has drifted since
 * the last full index. Runs once at session start (catches branch switches, git
 * pulls, and out-of-session edits). Skips projects that were never indexed so we
 * never index an arbitrary directory unprompted. This is the only place a
 * session reconciles the index with the tree: in-session edits arrive through
 * `noteFileChanges`, and stop() deliberately does no indexing at all.
 *
 * Every phase runs through one shared slicer. This work overlaps a mounted TUI:
 * before slicing, a drifted tree on a 1100-file repository held the event loop
 * for roughly four seconds at session start, during which the prompt was on
 * screen and keystrokes queued silently. `void` on the promise never helped,
 * because nothing inside it awaited.
 */
async function ensureCodewikiFresh(cwd: string): Promise<void> {
	// The bootstrap model-generation child runs a headless session purely to draft
	// CLIO-CODER.md; it must not re-index while the parent context-init owns the rebuild.
	if (process.env.CLIO_CODER_BOOTSTRAP_GENERATE_CHILD === "1") return;
	const state = readClioState(cwd);
	if (!state && !existsSync(codewikiPath(cwd))) return;
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
				persistState(workspace, fingerprint, indexedAt, readClioState(workspace), codewiki.version, codewiki.language),
		},
	);
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
}

function collectStartupHints(cwd: string, options: ContextBundleOptions = {}): string[] {
	const hints: string[] = [];
	let projectType: ReturnType<typeof detectProjectType>;
	try {
		projectType = detectProjectType(cwd);
	} catch {
		projectType = "unknown";
	}
	const clio = loadProjectClioMd(cwd);
	if (
		clio.files.length === 0 &&
		clio.errors.length === 0 &&
		projectType !== "unknown" &&
		options.noContextFiles !== true
	) {
		hints.push("clio: No CLIO-CODER.md detected. Run /context init to explore the repo and bootstrap context.");
	}
	for (const issue of clio.errors) {
		hints.push(`clio: malformed ${issue.path} ignored: ${issue.error}`);
	}
	const state = readClioState(cwd);
	if (!state) return hints;
	if (state.contextSources !== undefined && adoptionSourcesChanged(state.contextSources, { cwd })) {
		hints.push("clio: Imported agent context changed. Run /context init --adopt to refresh.");
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
	const onStart = (): void => {
		lastCwd = process.cwd();
		void ensureCodewikiFresh(lastCwd).catch(() => {
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
					(current) => (current ? { kind: "incremental", cwd: workspace, current, paths: rel } : null),
					{
						requireExisting: true,
						afterCommit: ({ codewiki, fingerprint, changed }, committedWorkspace) => {
							if (!changed) return;
							persistState(
								committedWorkspace,
								fingerprint,
								new Date().toISOString(),
								readClioState(committedWorkspace),
								codewiki.version,
								codewiki.language,
							);
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
			const state = readClioState(lastCwd);
			if (!state) return;
			// The fingerprint is left as the last index wrote it. Stamping a fresh
			// one without re-indexing would hide drift from the next start.
			writeClioState(lastCwd, { ...state, lastSessionAt: new Date().toISOString() });
		},
	};

	const contract: ContextContract = {
		async runBootstrap(input) {
			const emitProgress = (event: Omit<ContextActivityPayload, "kind" | "at">): void => {
				_context.bus.emit(BusChannels.ContextActivity, { kind: "context-init", at: Date.now(), ...event });
				input?.onProgress?.(event);
			};
			try {
				const result = await runBootstrap(input ? { ...input, onProgress: emitProgress } : { onProgress: emitProgress });
				const cwd = input?.cwd ?? process.cwd();
				contextState.invalidate(cwd);
				if (cwd === lastCwd) startupHints = collectStartupHints(cwd, options);
				return result;
			} catch (err) {
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
			const emitProgress = (event: Omit<ContextActivityPayload, "kind" | "at">): void => {
				_context.bus.emit(BusChannels.ContextActivity, { kind: "context-clear", at: Date.now(), ...event });
			};
			emitProgress({ phase: "done", status: "started", message: "clearing context" });
			try {
				const result = await runContextClear(input);
				const cwd = input?.cwd ?? process.cwd();
				contextState.invalidate(cwd);
				if (cwd === lastCwd) startupHints = collectStartupHints(cwd, options);
				emitProgress({ phase: "done", status: "completed", message: "context cleared" });
				return result;
			} catch (err) {
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
			const emitProgress = (event: Omit<ContextActivityPayload, "kind" | "at">): void => {
				_context.bus.emit(BusChannels.ContextActivity, { kind: "context-refresh", at: Date.now(), ...event });
				input?.onProgress?.(event);
			};
			try {
				const result = await runContextRefresh(
					input ? { ...input, onProgress: emitProgress } : { onProgress: emitProgress },
				);
				const cwd = input?.cwd ?? process.cwd();
				contextState.invalidate(cwd);
				if (cwd === lastCwd) startupHints = collectStartupHints(cwd, options);
				return result;
			} catch (err) {
				emitProgress({
					phase: "done",
					status: "failed",
					message: "context refresh failed",
					detail: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
		},
		async runWikiGenerate(input) {
			const emitProgress = (event: Omit<ContextActivityPayload, "kind" | "at">): void => {
				_context.bus.emit(BusChannels.ContextActivity, { kind: "context-wiki", at: Date.now(), ...event });
				input?.onProgress?.(event);
			};
			try {
				return await runWikiGenerate(
					input ? { ...input, onProgress: emitProgress } : { model: "configured-clio-target", onProgress: emitProgress },
				);
			} catch (err) {
				emitProgress({
					phase: "done",
					status: "failed",
					message: "context wiki failed",
					detail: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
		},
		renderPromptContext,
		projectStructuredContext(cwd = process.cwd()) {
			const clio = loadProjectClioMd(cwd).value;
			if (!clio) return null;
			// Exact-title allowlist: "Verification expectations" is the only
			// custom section ever projected to workers (verification class only,
			// enforced dispatch-side). Same case-insensitive comparison as
			// clio-md's sectionBody().
			const verificationBody = clio.sections
				.filter((section) => section.title.toLowerCase() === "verification expectations")
				.map((section) => section.body.trim())
				.filter((body) => body.length > 0)
				.join("\n\n");
			return {
				projectName: clio.projectName,
				conventions: [...clio.conventions],
				invariants: [...clio.invariants],
				...(verificationBody.length > 0 ? { verificationExpectations: verificationBody } : {}),
			};
		},
		contextState: contextState.read,
		startupHints: () => [...startupHints],
		noteFileChanges,
	};

	return { extension, contract };
}
