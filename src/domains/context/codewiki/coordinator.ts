import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import { codewikiPath, readCodewiki, writeCodewiki } from "./artifact.js";
import type {
	CodewikiBuildWorkerMessage,
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

async function executeInWorker(request: CodewikiBuildWorkerRequest): Promise<CodewikiBuildWorkerResult> {
	// Do not inherit test-runner/application `--import` hooks. In particular,
	// `--import tsx` would be re-resolved from a hermetic fixture cwd before the
	// source bootstrap can install its absolute loader.
	const worker = new Worker(buildWorkerUrl(), { workerData: request, execArgv: [] });
	let exited = false;
	const exit = new Promise<void>((resolve) => {
		worker.once("exit", () => {
			exited = true;
			resolve();
		});
	});
	let timer: NodeJS.Timeout | undefined;
	try {
		return await new Promise<CodewikiBuildWorkerResult>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				callback();
			};
			timer = setTimeout(() => {
				finish(() => reject(new Error(`codewiki build worker exceeded ${BUILD_TIMEOUT_MS} ms`)));
			}, BUILD_TIMEOUT_MS);
			timer.unref();
			worker.once("message", (message: CodewikiBuildWorkerMessage) => {
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
				if (code !== 0)
					finish(() => {
						reject(new Error(`codewiki build worker exited with code ${code}`));
					});
			});
		});
	} finally {
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

function enqueueWorkspace<T>(cwd: string, task: () => Promise<T>): Promise<T> {
	const key = codewikiPath(cwd);
	const previous = workspaceTails.get(key) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(task);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	workspaceTails.set(key, tail);
	void tail.finally(() => {
		if (workspaceTails.get(key) === tail) workspaceTails.delete(key);
	});
	return result;
}

export interface CodewikiCoordinatedResult {
	codewiki: Codewiki;
	worker: CodewikiBuildWorkerResult;
	wrote: boolean;
}

export interface CodewikiCoordinateOptions {
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
	return enqueueWorkspace(workspace, () =>
		withStateFileLock(codewikiPath(workspace), async () => {
			if (options.requireExisting && !existsSync(codewikiPath(workspace))) return null;
			const current = options.readCurrent?.(workspace) ?? readCodewiki(workspace);
			const request = await select(current, workspace);
			if (!request) return null;
			const worker = await executeInWorker({ ...request, cwd: workspace });
			await options.beforeCommit?.(worker, workspace);
			const wrote = worker.changed || !existsSync(codewikiPath(workspace));
			if (wrote) writeCodewiki(workspace, worker.codewiki);
			await options.afterCommit?.(worker, workspace);
			return { codewiki: !worker.changed && current ? current : worker.codewiki, worker, wrote };
		}),
	);
}

/** Serialize a non-build artifact transaction such as reset with every writer. */
export function coordinateCodewikiExclusive<T>(cwd: string, task: (workspace: string) => T | Promise<T>): Promise<T> {
	const workspace = resolve(cwd);
	return enqueueWorkspace(workspace, () => withStateFileLock(codewikiPath(workspace), () => task(workspace)));
}

/** Build a preview candidate in the worker without acquiring a writer lease or touching disk. */
export function buildCodewikiCandidate(
	cwd: string,
	language: Codewiki["language"],
): Promise<CodewikiBuildWorkerResult> {
	return executeInWorker({ kind: "build", cwd: resolve(cwd), language });
}

/** Await every writer already admitted for one workspace, including idle refresh. */
export async function drainCodewikiWrites(cwd: string): Promise<void> {
	const workspace = resolve(cwd);
	for (;;) {
		const tail = workspaceTails.get(codewikiPath(workspace));
		if (!tail) return;
		await tail;
		if (workspaceTails.get(codewikiPath(workspace)) === tail) return;
	}
}
