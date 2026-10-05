import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import {
	codemapPath,
	codewikiNeedsBackfill,
	codewikiPath,
	legacyCodewikiPath,
	readCodewiki,
	writeCodewiki,
} from "./artifact.js";
import type {
	CodewikiArtifactRef,
	CodewikiBuildProgress,
	CodewikiBuildWorkerMessage,
	CodewikiBuildWorkerOutcome,
	CodewikiBuildWorkerRequest,
	CodewikiBuildWorkerResult,
} from "./build-worker-protocol.js";
import type { Codewiki } from "./schema.js";

const BUILD_TIMEOUT_MS = 120_000;
const workspaceTails = new Map<string, Promise<void>>();
const require = createRequire(import.meta.url);

function buildWorkerUrl(): URL {
	if (!import.meta.url.endsWith(".ts")) return new URL("./codewiki/build-worker.js", import.meta.url);
	// Test/source execution changes cwd for hermetic fixtures. A tiny JavaScript
	// bootstrap imports the absolute TypeScript loader before dynamically loading
	// the source worker; relying on inherited `--import tsx` would resolve `tsx`
	// from the fixture and Node 24 would otherwise strip the entry's types without
	// remapping its internal `.js` specifiers back to `.ts`.
	const loaderApi = pathToFileURL(require.resolve("tsx/esm/api")).href;
	const source = new URL("./build-worker.ts", import.meta.url).href;
	return new URL(
		`data:text/javascript,${encodeURIComponent(`const { tsImport } = await import(${JSON.stringify(loaderApi)}); await tsImport(${JSON.stringify(source)}, import.meta.url);`)}`,
	);
}

function artifactRef(current: Codewiki): CodewikiArtifactRef {
	return {
		source: "artifact",
		needsBackfill: codewikiNeedsBackfill(current),
		loc: current.files.reduce((sum, file) => (file.lang === "config" ? sum : sum + file.loc), 0),
	};
}

/**
 * Hand the worker a reference to the committed artifact instead of the parsed
 * object. Cloning the object serializes it on this thread, deserializes it on
 * the worker, and repeats both on the way back, so the cost grows with index
 * size and lands on the thread that renders the TUI. The substitution is made
 * only when the selector returned the very object this transaction read under
 * the lease (`held`), which is the committed file by construction; any other
 * object is shipped as it was given.
 */
function byReference(request: CodewikiBuildWorkerRequest, held: Codewiki | null): CodewikiBuildWorkerRequest {
	if (request.kind === "build" || request.current === null || "source" in request.current) return request;
	if (held === null || request.current !== held) return request;
	return { ...request, current: artifactRef(held) };
}

async function executeInWorker(
	request: CodewikiBuildWorkerRequest,
	onProgress?: (progress: CodewikiBuildProgress) => void,
	signal?: AbortSignal,
): Promise<CodewikiBuildWorkerOutcome> {
	// Do not inherit test-runner/application `--import` hooks. In particular,
	// `--import tsx` would be re-resolved from a hermetic fixture cwd before the
	// source bootstrap can install its absolute loader.
	signal?.throwIfAborted();
	const worker = new Worker(buildWorkerUrl(), { workerData: request, execArgv: [] });
	let exited = false;
	const exit = new Promise<void>((resolve) => {
		worker.once("exit", () => {
			exited = true;
			resolve();
		});
	});
	let timer: NodeJS.Timeout | undefined;
	let lastProgress: CodewikiBuildProgress | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<CodewikiBuildWorkerOutcome>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				callback();
			};
			onAbort = () =>
				finish(() => reject(signal?.reason ?? new DOMException("Context operation cancelled", "AbortError")));
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			timer = setTimeout(() => {
				const detail = lastProgress
					? ` during ${lastProgress.stage}${lastProgress.path ? `; last reported file: ${lastProgress.path}` : ""}`
					: " before reporting progress";
				finish(() => reject(new Error(`codewiki build worker exceeded ${BUILD_TIMEOUT_MS} ms${detail}`)));
			}, BUILD_TIMEOUT_MS);
			timer.unref();
			worker.on("message", (message: CodewikiBuildWorkerMessage) => {
				if (settled) return;
				if ("progress" in message) {
					lastProgress = message.progress;
					onProgress?.(message.progress);
					return;
				}
				finish(() => {
					if (message.ok) resolve(message.result);
					else {
						const error = new Error(message.error);
						if (message.stack) error.stack = message.stack;
						reject(error);
					}
				});
			});
			worker.once("error", (error) =>
				finish(() => {
					reject(error);
				}),
			);
			worker.once("exit", (code) => {
				finish(() => reject(new Error(`codewiki build worker exited with code ${code} before returning a result`)));
			});
		});
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		if (signal?.aborted && !exited) await worker.terminate().catch(() => undefined);
		if (timer) clearTimeout(timer);
		if (!exited) {
			await Promise.race([
				exit,
				new Promise<void>((resolve) => {
					const grace = setTimeout(resolve, 250);
					grace.unref();
				}),
			]);
		}
		if (!exited) await worker.terminate().catch(() => undefined);
	}
}

function enqueueWorkspace<T>(cwd: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const key = legacyCodewikiPath(cwd);
	const previous = workspaceTails.get(key) ?? Promise.resolve();
	let entered = false;
	const result = previous
		.catch(() => undefined)
		.then(() => {
			entered = true;
			signal?.throwIfAborted();
			return task();
		});
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	workspaceTails.set(key, tail);
	void tail.finally(() => {
		if (workspaceTails.get(key) === tail) workspaceTails.delete(key);
	});
	if (!signal) return result;
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			if (!entered) reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export interface CodewikiCoordinatedResult {
	codewiki: Codewiki;
	worker: CodewikiBuildWorkerResult;
	wrote: boolean;
}

export interface CodewikiCoordinateOptions {
	signal?: AbortSignal;
	onProgress?: (progress: CodewikiBuildProgress) => void;
	/** Never create an artifact merely because a background session happened to start. */
	requireExisting?: boolean;
	/** Optional identity-checked cache, evaluated only after the cross-process lease is held. */
	readCurrent?: (workspace: string) => Codewiki | undefined;
	beforeCommit?: (result: CodewikiBuildWorkerResult, workspace: string) => void | Promise<void>;
	afterCommit?: (result: CodewikiBuildWorkerResult, workspace: string) => void | Promise<void>;
}

/**
 * The only production codewiki commit transaction. The in-process queue gives
 * demand, idle, incremental, and explicit operations one generation order; the
 * file lease extends the same order across Clio processes. The request is
 * selected after the lease is held and the artifact has been re-read, so an
 * incremental update can never be based on a generation that another writer
 * already replaced.
 */
export function coordinateCodewikiWrite(
	cwd: string,
	select: (
		current: Codewiki | null,
		workspace: string,
	) => CodewikiBuildWorkerRequest | null | Promise<CodewikiBuildWorkerRequest | null>,
	options: CodewikiCoordinateOptions = {},
): Promise<CodewikiCoordinatedResult | null> {
	const workspace = resolve(cwd);
	options.signal?.throwIfAborted();
	options.onProgress?.({ stage: "queue" });
	return enqueueWorkspace(
		workspace,
		() => {
			// Taking the lease creates the lock's parent, so a project that was never
			// indexed gained an empty `.clio-coder/` from every successful write: the
			// incremental refresh is contractually a no-op there, and it was
			// materializing state before it could say so (issue #248). The check runs
			// inside the queue, so a writer that built the codewiki ahead of this task
			// has already finished and this one sees it. The recheck under the lock
			// stays, and is what still decides the race.
			if (options.requireExisting && !existsSync(codewikiPath(workspace))) return Promise.resolve(null);
			return withStateFileLock(
				legacyCodewikiPath(workspace),
				async () => {
					if (options.requireExisting && !existsSync(codewikiPath(workspace))) return null;
					const current = options.readCurrent?.(workspace) ?? readCodewiki(workspace);
					options.signal?.throwIfAborted();
					const request = await select(current, workspace);
					if (!request) return null;
					const outcome = await executeInWorker(
						byReference({ ...request, cwd: workspace }, current),
						options.onProgress,
						options.signal,
					);
					const codewiki = outcome.codewiki ?? current;
					if (!codewiki) throw new Error("codewiki reconciliation returned no artifact");
					const worker: CodewikiBuildWorkerResult = { codewiki, fingerprint: outcome.fingerprint, changed: outcome.changed };
					options.signal?.throwIfAborted();
					await options.beforeCommit?.(worker, workspace);
					options.signal?.throwIfAborted();
					const wrote = worker.changed || !existsSync(codemapPath(workspace));
					if (wrote) writeCodewiki(workspace, worker.codewiki);
					await options.afterCommit?.(worker, workspace);
					return { codewiki: !worker.changed && current ? current : worker.codewiki, worker, wrote };
				},
				options.signal ? { signal: options.signal } : {},
			);
		},
		options.signal,
	);
}

/** Serialize a non-build artifact transaction such as reset with every writer. */
export function coordinateCodewikiExclusive<T>(
	cwd: string,
	task: (workspace: string) => T | Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const workspace = resolve(cwd);
	return enqueueWorkspace(
		workspace,
		() =>
			withStateFileLock(
				legacyCodewikiPath(workspace),
				() => {
					signal?.throwIfAborted();
					return task(workspace);
				},
				signal ? { signal } : {},
			),
		signal,
	);
}

/** Reconcile a read tool's private snapshot without a writer lease or workspace mutation. */
export async function reconcileCodewikiCandidate(
	request: Extract<CodewikiBuildWorkerRequest, { kind: "ensure" }> & { current: Codewiki | null },
): Promise<CodewikiBuildWorkerResult> {
	const outcome = await executeInWorker(request);
	const codewiki = outcome.codewiki ?? request.current;
	if (!codewiki) throw new Error("codewiki reconciliation returned no artifact");
	return { codewiki, fingerprint: outcome.fingerprint, changed: outcome.changed };
}

/** Build a preview candidate in the worker without acquiring a writer lease or touching disk. */
export async function buildCodewikiCandidate(
	cwd: string,
	language: Codewiki["language"],
	onProgress?: (progress: CodewikiBuildProgress) => void,
	signal?: AbortSignal,
): Promise<CodewikiBuildWorkerResult> {
	const outcome = await executeInWorker({ kind: "build", cwd: resolve(cwd), language }, onProgress, signal);
	if (!outcome.codewiki) throw new Error("codewiki build returned no artifact");
	return { codewiki: outcome.codewiki, fingerprint: outcome.fingerprint, changed: outcome.changed };
}

/** Await every writer already admitted for one workspace, including idle refresh. */
export async function drainCodewikiWrites(cwd: string): Promise<void> {
	const workspace = resolve(cwd);
	for (;;) {
		const tail = workspaceTails.get(legacyCodewikiPath(workspace));
		if (!tail) return;
		await tail;
		if (workspaceTails.get(legacyCodewikiPath(workspace)) === tail) return;
	}
}
