import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { BusChannels, type ContextActivityPayload } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { clioDataDir } from "../../core/xdg.js";
import { loadMemoryRecordsSync } from "../memory/index.js";
import { detectProjectType } from "../session/workspace/project-type.js";
import { adoptionSourcesChanged } from "./adoption.js";
import { runBootstrap } from "./bootstrap.js";
import { runContextClear } from "./clear.js";
import { tryReadClioMd } from "./clio-md.js";
import {
	buildCodewiki,
	type Codewiki,
	codewikiNeedsBackfill,
	codewikiPath,
	parseCodewikiRaw,
	readCodewiki,
	updateCodewikiPaths,
	writeCodewiki,
} from "./codewiki/indexer.js";
import type { ContextContract, ContextState } from "./contract.js";
import { computeFingerprint, isStale } from "./fingerprint.js";
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
): void {
	writeClioState(cwd, {
		version: 1,
		projectType: prev?.projectType ?? detectProjectType(cwd),
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
 * pulls, and out-of-session edits) and again at stop. Skips projects that were
 * never indexed so we never index an arbitrary directory unprompted.
 */
async function ensureCodewikiFresh(cwd: string): Promise<void> {
	// The bootstrap model-generation child runs a headless session purely to draft
	// CLIO.md; it must not re-index while the parent context-init owns the rebuild.
	if (process.env.CLIO_BOOTSTRAP_GENERATE_CHILD === "1") return;
	const state = readClioState(cwd);
	if (!state && !existsSync(codewikiPath(cwd))) return;
	const codewiki = readCodewiki(cwd);
	const fingerprint = computeFingerprint(cwd, codewiki);
	const stale =
		!state ||
		isStale(state.fingerprint, fingerprint) ||
		!existsSync(codewikiPath(cwd)) ||
		!codewiki ||
		codewikiNeedsBackfill(codewiki);
	if (!stale) return;
	const indexedAt = new Date().toISOString();
	const projectType = state?.projectType ?? detectProjectType(cwd);
	const rebuilt = await buildCodewiki({ cwd, language: projectType, generatedAt: indexedAt });
	writeCodewiki(cwd, rebuilt);
	persistState(cwd, computeFingerprint(cwd, rebuilt), indexedAt, state, rebuilt.version);
}

const CONTEXT_STATE_CACHE_TTL_MS = 1500;
const CODEWIKI_CACHE_LIMIT = 4;

interface CachedCodewiki {
	hash: string;
	codewiki: Codewiki;
}

function codewikiContentHash(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

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
	if (state?.contextSources !== undefined && adoptionSourcesChanged(state.contextSources, { cwd })) {
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
	const clio = tryReadClioMd(cwd);
	if (!clio && projectType !== "unknown" && options.noContextFiles !== true) {
		hints.push("clio: No CLIO.md detected. Run /context init to explore the repo and bootstrap context.");
	}
	if (clio && !clio.ok) {
		hints.push(`clio: malformed CLIO.md ignored: ${clio.error}`);
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
	let startupHints: string[] = [];
	const contextState = createContextStateReader();
	const codewikiCache = new Map<string, CachedCodewiki>();
	const rememberCodewiki = (cwd: string, hash: string, codewiki: Codewiki): void => {
		codewikiCache.delete(cwd);
		codewikiCache.set(cwd, { hash, codewiki });
		while (codewikiCache.size > CODEWIKI_CACHE_LIMIT) {
			const oldest = codewikiCache.keys().next().value;
			if (oldest === undefined) break;
			codewikiCache.delete(oldest);
		}
	};
	const readCachedCodewiki = (cwd: string): Codewiki | null => {
		let raw: string;
		try {
			raw = readFileSync(codewikiPath(cwd), "utf8");
		} catch {
			codewikiCache.delete(cwd);
			return null;
		}
		const hash = codewikiContentHash(raw);
		const cached = codewikiCache.get(cwd);
		if (cached && cached.hash === hash) {
			rememberCodewiki(cwd, hash, cached.codewiki);
			return cached.codewiki;
		}
		const codewiki = parseCodewikiRaw(raw);
		if (!codewiki) {
			codewikiCache.delete(cwd);
			return null;
		}
		rememberCodewiki(cwd, hash, codewiki);
		return codewiki;
	};
	const writeCachedCodewiki = (cwd: string, codewiki: Codewiki): void => {
		const serialized = writeCodewiki(cwd, codewiki);
		rememberCodewiki(cwd, codewikiContentHash(serialized), codewiki);
	};
	const onStart = (): void => {
		lastCwd = process.cwd();
		void ensureCodewikiFresh(lastCwd).catch(() => {
			// Indexing is best-effort; a failed refresh must not block session start.
		});
		startupHints = collectStartupHints(lastCwd, options);
		if (process.env.CLIO_INTERACTIVE === "1") return;
		for (const hint of startupHints) process.stderr.write(`${hint}\n`);
	};

	// Incremental updates are read-modify-write on the artifact; overlapping runs
	// would compute from a stale base and drop each other's records, so batches
	// serialize through this queue and stop() drains it before its final rebuild.
	let incrementalQueue: Promise<void> = Promise.resolve();
	const noteFileChanges = (paths: ReadonlyArray<string>, cwd: string = lastCwd): void => {
		incrementalQueue = incrementalQueue
			.then(async () => {
				if (paths.length === 0) return;
				const codewiki = readCachedCodewiki(cwd);
				if (!codewiki) return; // Not indexed yet; session start/stop owns first build.
				const rel = paths
					.map((p) => (isAbsolute(p) ? relative(cwd, p) : p))
					.filter((p) => p.length > 0 && !p.startsWith(".."));
				const updated = await updateCodewikiPaths(cwd, codewiki, rel);
				if (updated === codewiki) return; // No indexable file actually changed.
				writeCachedCodewiki(cwd, updated);
				persistState(cwd, computeFingerprint(cwd, updated), new Date().toISOString(), readClioState(cwd), updated.version);
				contextState.invalidate(cwd);
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
			unsubscribeSessionStart?.();
			unsubscribeSessionStart = null;
			await incrementalQueue;
			const projectType = detectProjectType(lastCwd);
			const state = readClioState(lastCwd);
			let codewiki = readCachedCodewiki(lastCwd);
			let fingerprint = computeFingerprint(lastCwd, codewiki);
			let lastIndexedAt = state?.lastIndexedAt;
			if (!state || isStale(state.fingerprint, fingerprint) || !codewiki || codewikiNeedsBackfill(codewiki)) {
				lastIndexedAt = new Date().toISOString();
				codewiki = await buildCodewiki({ cwd: lastCwd, language: projectType, generatedAt: lastIndexedAt });
				writeCachedCodewiki(lastCwd, codewiki);
				fingerprint = computeFingerprint(lastCwd, codewiki);
			}
			writeClioState(lastCwd, {
				version: 1,
				projectType,
				fingerprint,
				...(codewiki ? { codewikiVersion: codewiki.version } : {}),
				...(state?.contextSources ? { contextSources: state.contextSources } : {}),
				...(state?.contextSourceHash ? { contextSourceHash: state.contextSourceHash } : {}),
				...(state?.lastBootstrap ? { lastBootstrap: state.lastBootstrap } : {}),
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
			const clio = tryReadClioMd(cwd);
			if (!clio?.ok) return null;
			// Exact-title allowlist: "Verification expectations" is the only
			// custom section ever projected to workers (verification class only,
			// enforced dispatch-side). Same case-insensitive comparison as
			// clio-md's sectionBody().
			const verification = clio.value.sections.find(
				(section) => section.title.toLowerCase() === "verification expectations",
			);
			const verificationBody = verification?.body.trim() ?? "";
			return {
				projectName: clio.value.projectName,
				conventions: [...clio.value.conventions],
				invariants: [...clio.value.invariants],
				...(verificationBody.length > 0 ? { verificationExpectations: verificationBody } : {}),
			};
		},
		contextState: contextState.read,
		startupHints: () => [...startupHints],
		noteFileChanges,
	};

	return { extension, contract };
}
