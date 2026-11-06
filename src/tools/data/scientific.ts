import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ensureScientificReader, ReaderUnavailableError, SCIENTIFIC_READERS } from "./reader-assets.js";
import type { ScientificReply, ScientificRequest, ScientificResult } from "./scientific-shared.js";
import { type DataRefusal, refusal } from "./shared.js";

/**
 * Main-thread side of the HDF5, NetCDF and Parquet readers: make sure the
 * pinned reader library is cached, then run the request in a reader worker
 * with a hard timeout, and turn every failure into a typed refusal. Nothing
 * here evaluates a reader library, so the data tool stays cheap to load.
 */

/** Hard ceiling for one call; stats returns partial figures at its own 60 s deadline well before this. */
const WORKER_TIMEOUT_MS = 120_000;
const STDERR_KEPT = 2048;
const require = createRequire(import.meta.url);

function workerUrl(): URL {
	if (!import.meta.url.endsWith(".ts")) return new URL("./data/scientific-worker.js", import.meta.url);
	// Source runs (tests, tsx) load the TypeScript entry through tsx's loader, resolved
	// absolutely so a fixture cwd cannot shadow it (the codewiki build worker does the same).
	const loaderApi = pathToFileURL(require.resolve("tsx/esm/api")).href;
	const source = new URL("./scientific-worker.ts", import.meta.url).href;
	return new URL(
		`data:text/javascript,${encodeURIComponent(`const { register } = await import(${JSON.stringify(loaderApi)}); register(); await import(${JSON.stringify(source)});`)}`,
	);
}

export async function runScientific(
	request: ScientificRequest,
	signal?: AbortSignal | undefined,
): Promise<ScientificResult | DataRefusal> {
	const path = request.path;
	let entry: string | undefined;
	if (request.container !== "netcdf3") {
		try {
			entry = await ensureScientificReader(SCIENTIFIC_READERS[request.container === "hdf5" ? "hdf5" : "parquet"]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return refusal(error instanceof ReaderUnavailableError ? "reader-unavailable" : "read-error", message, { path });
		}
	}
	if (signal?.aborted) return refusal("aborted", "aborted before the read started", { path });
	// Piped stdout and stderr: the HDF5 library prints diagnostics, and a worker
	// process's stdout is its NDJSON protocol lane, which one stray line corrupts.
	const worker = new Worker(workerUrl(), {
		workerData: { request, ...(entry !== undefined ? { entry } : {}) },
		execArgv: [],
		stdout: true,
		stderr: true,
	});
	let stderr = "";
	worker.stdout.resume();
	worker.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < STDERR_KEPT) stderr += chunk.toString("utf8").slice(0, STDERR_KEPT - stderr.length);
	});
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<ScientificResult | DataRefusal>((resolve) => {
			let settled = false;
			const finish = (value: ScientificResult | DataRefusal): void => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			onAbort = () => finish(refusal("aborted", "aborted before the read finished", { path }));
			signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(
				() =>
					finish(
						refusal("timed-out", `the read did not finish within ${WORKER_TIMEOUT_MS / 1000} s; narrow the selection`, {
							path,
						}),
					),
				WORKER_TIMEOUT_MS,
			);
			timer.unref();
			worker.once("message", (reply: ScientificReply) => finish(reply.ok ? reply.result : reply.refusal));
			worker.once("error", (error) =>
				finish(
					refusal(
						"read-error",
						`the reader failed on ${path}: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
						{ path },
					),
				),
			);
			worker.once("exit", (code) => {
				const detail = stderr.trim().length > 0 ? `: ${stderr.trim().slice(0, 500)}` : "";
				finish(refusal("read-error", `the reader exited with code ${code} before answering${detail}`, { path }));
			});
		});
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		await worker.terminate().catch(() => undefined);
	}
}
