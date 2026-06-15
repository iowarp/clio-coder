import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { BusChannels, type ContextActivityPayload } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { clioDataDir } from "../../core/xdg.js";
import { loadMemoryRecordsSync } from "../memory/index.js";
import { detectProjectType } from "../session/workspace/project-type.js";
import { adoptionSourcesChanged } from "./adoption.js";
import { runBootstrap } from "./bootstrap.js";
import { runContextClear } from "./clear.js";
import {
	type ParsedClioMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
	tryReadClioMd,
} from "./clio-md.js";
import { buildCodewiki, codewikiPath, readCodewiki, updateCodewikiPaths, writeCodewiki } from "./codewiki/indexer.js";
import type { ContextContract, ContextState, ProjectPromptContext } from "./contract.js";
import { computeFingerprint } from "./fingerprint.js";
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
): void {
	writeClioState(cwd, {
		version: 1,
		projectType: prev?.projectType ?? detectProjectType(cwd),
		fingerprint,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		lastSessionAt: prev?.lastSessionAt ?? new Date().toISOString(),
		lastIndexedAt: indexedAt,
	});
}

/**
 * Rebuild the codewiki when it is missing or the working tree has drifted since
 * the last full index. Runs once at session start (catches branch switches, git
 * pulls, and out-of-session edits) and again at stop. Skips projects that were
 * never indexed so we never index an arbitrary directory unprompted.
 */
function ensureCodewikiFresh(cwd: string): void {
	// The bootstrap model-generation child runs a headless session purely to draft
	// CLIO.md; it must not re-index while the parent context-init owns the rebuild.
	if (process.env.CLIO_BOOTSTRAP_GENERATE_CHILD === "1") return;
	const state = readClioState(cwd);
	if (!state && !existsSync(codewikiPath(cwd))) return;
	const fingerprint = computeFingerprint(cwd);
	const stale =
		!state || state.fingerprint.treeHash !== fingerprint.treeHash || !existsSync(codewikiPath(cwd)) || !readCodewiki(cwd);
	if (!stale) return;
	const indexedAt = new Date().toISOString();
	const projectType = state?.projectType ?? detectProjectType(cwd);
	writeCodewiki(cwd, buildCodewiki({ cwd, language: projectType, generatedAt: indexedAt }));
	persistState(cwd, fingerprint, indexedAt, state);
}

function renderPromptContext(cwd: string): ProjectPromptContext {
	const projectType = detectProjectType(cwd);
	const pieces = [renderProjectTypeFragment(projectType)];
	const warnings: string[] = [];
	const clio = tryReadClioMd(cwd);
	let clioMd: ParsedClioMd | null = null;
	if (clio?.ok) {
		clioMd = clio.value;
		pieces.push(renderProjectContextFragment(clio.value));
	}
	if (clio && !clio.ok) warnings.push(`clio: malformed CLIO.md ignored: ${clio.error}`);
	if (readCodewiki(cwd)) {
		const state = readClioState(cwd);
		const stale = state ? state.fingerprint.treeHash !== computeFingerprint(cwd).treeHash : true;
		const suffix = stale ? " (stale; run /context-init to refresh)" : "";
		pieces.push(`<codewiki>available${suffix}; use code_nav</codewiki>`);
	}
	return { text: pieces.join("\n\n"), clioMd, warnings };
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
	const clio = tryReadClioMd(cwd);
	if (!clio) return "none";
	if (!clio.ok) return "malformed";
	const state = readClioState(cwd);
	if (state?.contextSources && state.contextSources.length > 0 && adoptionSourcesChanged(state.contextSources)) {
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

function collectStartupHints(cwd: string): string[] {
	const hints: string[] = [];
	let projectType: ReturnType<typeof detectProjectType>;
	try {
		projectType = detectProjectType(cwd);
	} catch {
		projectType = "unknown";
	}
	const clio = tryReadClioMd(cwd);
	if (!clio && projectType !== "unknown") {
		hints.push("clio: No CLIO.md detected. Run /context-init to explore the repo and bootstrap context.");
	}
	if (clio && !clio.ok) {
		hints.push(`clio: malformed CLIO.md ignored: ${clio.error}`);
	}
	const state = readClioState(cwd);
	if (!state) return hints;
	if (state.contextSources && state.contextSources.length > 0 && adoptionSourcesChanged(state.contextSources)) {
		hints.push("clio: Imported agent context changed. Run /context-init --adopt to refresh.");
	}
	return hints;
}

export function createContextBundle(_context: DomainContext): DomainBundle<ContextContract> {
	let lastCwd = process.cwd();
	let startupHints: string[] = [];
	const contextState = createContextStateReader();
	const onStart = (): void => {
		lastCwd = process.cwd();
		try {
			ensureCodewikiFresh(lastCwd);
		} catch {
			// Indexing is best-effort; a failed refresh must not block session start.
		}
		startupHints = collectStartupHints(lastCwd);
		if (process.env.CLIO_INTERACTIVE === "1") return;
		for (const hint of startupHints) process.stderr.write(`${hint}\n`);
	};

	const noteFileChanges = (paths: ReadonlyArray<string>, cwd: string = lastCwd): void => {
		try {
			if (paths.length === 0) return;
			const codewiki = readCodewiki(cwd);
			if (!codewiki) return; // Not indexed yet; session start/stop owns first build.
			const rel = paths
				.map((p) => (isAbsolute(p) ? relative(cwd, p) : p))
				.filter((p) => p.length > 0 && !p.startsWith(".."));
			const updated = updateCodewikiPaths(cwd, codewiki, rel);
			if (updated === codewiki) return; // No indexable file actually changed.
			writeCodewiki(cwd, updated);
			persistState(cwd, computeFingerprint(cwd), new Date().toISOString(), readClioState(cwd));
			contextState.invalidate(cwd);
		} catch {
			// Best-effort: never let incremental indexing surface as a tool error.
		}
	};

	let unsubscribeSessionStart: (() => void) | null = null;
	const extension: DomainExtension = {
		start() {
			unsubscribeSessionStart = _context.bus.on(BusChannels.SessionStart, onStart);
		},
		stop() {
			unsubscribeSessionStart?.();
			unsubscribeSessionStart = null;
			const projectType = detectProjectType(lastCwd);
			const state = readClioState(lastCwd);
			const fingerprint = computeFingerprint(lastCwd);
			let lastIndexedAt = state?.lastIndexedAt;
			if (!state || state.fingerprint.treeHash !== fingerprint.treeHash || !readCodewiki(lastCwd)) {
				lastIndexedAt = new Date().toISOString();
				writeCodewiki(lastCwd, buildCodewiki({ cwd: lastCwd, language: projectType, generatedAt: lastIndexedAt }));
			}
			writeClioState(lastCwd, {
				version: 1,
				projectType,
				fingerprint,
				...(state?.contextSources ? { contextSources: state.contextSources } : {}),
				...(state?.contextSourceHash ? { contextSourceHash: state.contextSourceHash } : {}),
				...(state?.lastInitAt ? { lastInitAt: state.lastInitAt } : {}),
				lastSessionAt: new Date().toISOString(),
				...(lastIndexedAt ? { lastIndexedAt } : {}),
			});
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
				if (cwd === lastCwd) startupHints = collectStartupHints(cwd);
				return result;
			} catch (err) {
				emitProgress({
					phase: "done",
					status: "failed",
					message: "context-init failed",
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
				if (cwd === lastCwd) startupHints = collectStartupHints(cwd);
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
		renderPromptContext,
		contextState: contextState.read,
		startupHints: () => [...startupHints],
		noteFileChanges,
	};

	return { extension, contract };
}
