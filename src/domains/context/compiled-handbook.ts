/**
 * The handbook a repository without CLIO-CODER.md gets: compiled from its own
 * checkers, the verified rules of other harnesses' handbooks, its verification
 * commands and its tree facts, with no model call (`compileHandbookFromTree`).
 *
 * The compile lists and reads the tree, so it never runs on the prompt or
 * dispatch path. `refreshCompiledHandbook` runs it on a worker thread, which
 * leaves the result under `.clio-coder/state/` keyed by a fingerprint of its
 * inputs; a session starts one for its directory. `compiledProjectHandbook`
 * only reads that cache, and serves it while the files the compile read keep
 * the size and mtime it recorded, so prompt assembly and every bounded dispatch
 * pay a few stat calls. Until a cache exists the session runs as a repository
 * without a handbook. The Markdown file is what the prompt names as the
 * handbook's path, so a read of an omitted line resolves.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { clioProjectRoot, ensureProjectIgnore } from "../../core/project-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { ProjectPromptContext } from "./contract.js";
import { renderPromptContext } from "./prompt-context.js";

export interface CompiledProjectHandbook {
	/** Absolute path of the cached Markdown; the prompt cites it as the handbook's path. */
	path: string;
	source: string;
	/** Repository-relative files its rules came from. */
	sources: string[];
	rules: number;
}

/** Bumped when the compile's output changes for the same inputs, so an older cache is not reused. */
export const COMPILE_VERSION = 1;

/** A file the compile read, with the size and mtime it had when it was read. */
export interface InputStamp {
	path: string;
	stamp: string;
}

export interface CompiledHandbookSidecar {
	version: number;
	fingerprint: string;
	contentSha256: string;
	sources: string[];
	rules: number;
	/** Repository-relative files the compile read; a change to one retires the cache until the next compile. */
	inputs: InputStamp[];
}

export interface HandbookCompileWorkerData {
	root: string;
}

/**
 * `inputs` are absolute and end with the root itself, whose entry list changes when a file is added beside it.
 * `inputKey` arrives first, once the tree is listed, and names the input set a later timeout is reported against.
 */
export type HandbookCompileWorkerMessage =
	| { inputKey: string }
	| { ok: true; inputs: InputStamp[] }
	| { ok: false; error: string };

const DEFAULT_COMPILE_TIMEOUT_MS = 120_000;
let compileTimeoutMs = DEFAULT_COMPILE_TIMEOUT_MS;
const require = createRequire(import.meta.url);

export function compiledHandbookPath(root: string): string {
	return join(root, ".clio-coder", "state", "compiled-handbook.md");
}

export function compiledHandbookSidecarPath(root: string): string {
	return join(root, ".clio-coder", "state", "compiled-handbook.json");
}

/** The input set whose compile last ran out of time; the same set timing out again is not reported again. */
export function compileTimeoutMarkerPath(root: string): string {
	return join(root, ".clio-coder", "state", "compiled-handbook-timeout.json");
}

export function setCompileTimeoutForTesting(ms: number | null): void {
	compileTimeoutMs = ms ?? DEFAULT_COMPILE_TIMEOUT_MS;
}

class CompileTimeout extends Error {
	constructor(readonly inputKey: string) {
		super(`exceeded ${compileTimeoutMs} ms`);
	}
}

/** Until the worker lists the tree, the root's own entries, less Clio's state directory, stand in for the input set. */
function unlistedInputKey(root: string): string {
	try {
		const names = readdirSync(root)
			.filter((name) => name !== ".clio-coder")
			.sort();
		return `unlisted:${createHash("sha256").update(names.join("\n")).digest("hex")}`;
	} catch {
		return "unlisted";
	}
}

/** True the first time this input set times out; records it so later sessions and processes stay quiet. */
function firstTimeoutFor(root: string, inputKey: string): boolean {
	const path = compileTimeoutMarkerPath(root);
	try {
		if ((JSON.parse(readFileSync(path, "utf8")) as { inputKey?: unknown }).inputKey === inputKey) return false;
	} catch {
		// No marker, or a torn one: this timeout is news.
	}
	try {
		ensureProjectIgnore(root);
		safeResourceWrite(path, `${JSON.stringify({ inputKey })}\n`, { encoding: "utf8" });
	} catch {
		// Without the marker the next timeout warns again, which is the old behaviour.
	}
	return true;
}

export function stampOf(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "absent";
	}
}

function isStamp(entry: unknown): entry is InputStamp {
	const value = entry as Partial<InputStamp> | null;
	return typeof value?.path === "string" && typeof value.stamp === "string";
}

/** The cache as written by the last compile, or null when it is missing, from another version, or torn. */
export function readCompiledHandbookCache(
	root: string,
): { sidecar: CompiledHandbookSidecar; value: CompiledProjectHandbook } | null {
	try {
		const meta = JSON.parse(readFileSync(compiledHandbookSidecarPath(root), "utf8")) as Partial<CompiledHandbookSidecar>;
		if (
			meta.version !== COMPILE_VERSION ||
			typeof meta.fingerprint !== "string" ||
			typeof meta.contentSha256 !== "string" ||
			!Array.isArray(meta.sources) ||
			typeof meta.rules !== "number" ||
			!Array.isArray(meta.inputs) ||
			!meta.inputs.every(isStamp)
		)
			return null;
		const path = compiledHandbookPath(root);
		const source = readFileSync(path, "utf8");
		if (createHash("sha256").update(source).digest("hex") !== meta.contentSha256) return null;
		const sources = meta.sources.filter((entry): entry is string => typeof entry === "string");
		const sidecar: CompiledHandbookSidecar = {
			version: meta.version,
			fingerprint: meta.fingerprint,
			contentSha256: meta.contentSha256,
			sources,
			rules: meta.rules,
			inputs: meta.inputs,
		};
		return { sidecar, value: { path, source, sources, rules: meta.rules } };
	} catch {
		return null;
	}
}

/** Per repository root: the cache as last parsed, keyed by the stamps of its two files. */
const memo = new Map<string, { files: string; value: CompiledProjectHandbook | null; inputs: InputStamp[] }>();

interface Refresh {
	running: Promise<void> | null;
	queued: Promise<void> | null;
	worker: Worker | null;
	/** What the last compile read; a later change to one schedules the next compile. Null after a failure. */
	observed: InputStamp[] | null;
	closed: boolean;
}

/** Roots a session asked to keep compiled; only these recompile when an input changes. */
const owned = new Map<string, Refresh>();

function cachedHandbook(root: string): CompiledProjectHandbook | null {
	const files = `${stampOf(compiledHandbookSidecarPath(root))}|${stampOf(compiledHandbookPath(root))}`;
	let known = memo.get(root);
	if (known?.files !== files) {
		const cache = readCompiledHandbookCache(root);
		known = { files, value: cache?.value ?? null, inputs: cache?.sidecar.inputs ?? [] };
		memo.set(root, known);
	}
	// An input changed since the compile: its rules may no longer hold, so none is served until the next compile.
	return known.value && known.inputs.every(({ path, stamp }) => stampOf(join(root, path)) === stamp)
		? known.value
		: null;
}

/**
 * The compiled handbook for the repository holding `cwd`, read from the cache
 * the background compile left, or null when there is none or it no longer
 * matches its inputs. Callers ask only when no CLIO-CODER.md loaded.
 */
export function compiledProjectHandbook(cwd: string): CompiledProjectHandbook | null {
	const root = clioProjectRoot(cwd);
	const refresh = owned.get(root);
	if (
		refresh?.observed &&
		!refresh.running &&
		!refresh.queued &&
		refresh.observed.some(({ path, stamp }) => stampOf(path) !== stamp)
	)
		void scheduleRefresh(root, refresh);
	return cachedHandbook(root);
}

function buildWorkerUrl(): URL {
	if (!import.meta.url.endsWith(".ts")) return new URL("./context/handbook-compile-worker.js", import.meta.url);
	// Source execution: the same absolute-loader bootstrap as the codewiki build worker.
	const loaderApi = pathToFileURL(require.resolve("tsx/esm/api")).href;
	const source = new URL("./handbook-compile-worker.ts", import.meta.url).href;
	return new URL(
		`data:text/javascript,${encodeURIComponent(`const { tsImport } = await import(${JSON.stringify(loaderApi)}); await tsImport(${JSON.stringify(source)}, import.meta.url);`)}`,
	);
}

function compileInWorker(root: string, refresh: Refresh): Promise<InputStamp[]> {
	return new Promise((resolve, reject) => {
		const workerData: HandbookCompileWorkerData = { root };
		// A runaway walk fails the worker, not the host process.
		const worker = new Worker(buildWorkerUrl(), {
			workerData,
			execArgv: [],
			resourceLimits: { maxOldGenerationSizeMb: 512 },
		});
		refresh.worker = worker;
		let inputKey = unlistedInputKey(root);
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(() => {
			finish(() => reject(new CompileTimeout(inputKey)));
			void worker.terminate();
		}, compileTimeoutMs);
		timer.unref();
		worker.on("message", (message: HandbookCompileWorkerMessage) => {
			if ("inputKey" in message) inputKey = message.inputKey;
			else finish(() => (message.ok ? resolve(message.inputs) : reject(new Error(message.error))));
		});
		worker.once("error", (error) => finish(() => reject(error)));
		worker.once("exit", (code) => {
			if (refresh.worker === worker) refresh.worker = null;
			finish(() => reject(new Error(`worker exited with code ${code} before returning a result`)));
		});
	});
}

function startRefresh(root: string, refresh: Refresh): Promise<void> {
	if (refresh.closed) return Promise.resolve();
	const run = compileInWorker(root, refresh)
		.then(
			(inputs) => {
				refresh.observed = inputs;
				rmSync(compileTimeoutMarkerPath(root), { force: true });
			},
			(error: unknown) => {
				// Failing again on every prompt helps nobody; the next session start tries again.
				refresh.observed = null;
				if (refresh.closed) return;
				if (error instanceof CompileTimeout && !firstTimeoutFor(root, error.inputKey)) return;
				writeDiagnostic(
					`clio-coder: compiling the project handbook failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		)
		.finally(() => {
			memo.delete(root);
			refresh.running = null;
		});
	refresh.running = run;
	return run;
}

function scheduleRefresh(root: string, refresh: Refresh): Promise<void> {
	if (refresh.queued) return refresh.queued;
	if (!refresh.running) return startRefresh(root, refresh);
	// The running compile may have read a file before an edit; one follow-up covers every ask made meanwhile.
	const queued = refresh.running.then(() => {
		refresh.queued = null;
		return startRefresh(root, refresh);
	});
	refresh.queued = queued;
	return queued;
}

/**
 * Compile the handbook for the repository holding `cwd` on a worker thread and
 * keep it compiled while this process runs; settles when the compile has
 * landed or failed. A compile already running is followed by one more, since
 * it may have read the tree before the caller's change.
 */
export function refreshCompiledHandbook(cwd: string): Promise<void> {
	const root = clioProjectRoot(cwd);
	let refresh = owned.get(root);
	if (!refresh) {
		refresh = { running: null, queued: null, worker: null, observed: null, closed: false };
		owned.set(root, refresh);
	}
	return scheduleRefresh(root, refresh);
}

/** Stop every compile this process started; a cut-off compile leaves the previous cache. */
export async function stopCompiledHandbookRefreshes(): Promise<void> {
	const pending: Array<Promise<void>> = [];
	for (const refresh of owned.values()) {
		refresh.closed = true;
		void refresh.worker?.terminate();
		for (const run of [refresh.running, refresh.queued]) if (run) pending.push(run);
	}
	owned.clear();
	await Promise.all(pending);
}

/** The project prompt context every session surface and dispatch shares: the authored handbook, else the compiled one. */
export function renderEffectivePromptContext(cwd: string): ProjectPromptContext {
	return renderPromptContext(cwd, { compile: compiledProjectHandbook });
}
