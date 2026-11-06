import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { type H5Library, inspectHdf5, selectHdf5, statsHdf5 } from "./hdf5.js";
import { inspectNetcdf3, selectNetcdf3, statsNetcdf3 } from "./netcdf3.js";
import { inspectParquet, type ParquetLibrary, selectParquet, statsParquet } from "./parquet.js";
import type { ScientificReply, ScientificRequest, ScientificResult } from "./scientific-shared.js";
import { DataRefusalError, refusal } from "./shared.js";

/**
 * The reader worker: one thread per data call, so a long stats pass never
 * blocks the thread that renders the TUI, an abort or timeout is a
 * `terminate()`, and the reader's wasm heap is released with the thread. The
 * reader library is imported by file URL from Clio's cache, where
 * reader-assets.ts unpacked it after checking its pin.
 */

interface WorkerInput {
	request: ScientificRequest;
	/** Absolute path of the reader library's entry module; absent for NetCDF-3, which needs none. */
	entry?: string;
}

async function run(input: WorkerInput): Promise<ScientificResult> {
	const { request, entry } = input;
	if (request.container === "netcdf3") {
		if (request.op === "inspect") return inspectNetcdf3(request);
		if (request.op === "select") return selectNetcdf3(request);
		return statsNetcdf3(request);
	}
	if (entry === undefined) throw new Error(`no reader entry was given for ${request.container}`);
	if (request.container === "hdf5") {
		const lib = (await import(pathToFileURL(entry).href)) as H5Library;
		await lib.ready;
		if (request.op === "inspect") return inspectHdf5(lib, request);
		if (request.op === "select") return selectHdf5(lib, request);
		return statsHdf5(lib, request);
	}
	const lib = (await import(pathToFileURL(entry).href)) as ParquetLibrary;
	if (request.op === "inspect") return inspectParquet(lib, request);
	if (request.op === "select") return selectParquet(lib, request);
	return statsParquet(lib, request);
}

async function main(): Promise<void> {
	const input = workerData as WorkerInput;
	let reply: ScientificReply;
	try {
		reply = { ok: true, result: await run(input) };
	} catch (error) {
		if (error instanceof DataRefusalError) reply = { ok: false, refusal: { ...error.refusal, path: input.request.path } };
		else {
			// Message only: a stack from the HDF5 reader quotes its 4 MB single-line module.
			const message = error instanceof Error ? error.message : String(error);
			reply = {
				ok: false,
				refusal: refusal("read-error", `cannot read ${input.request.path}: ${message.slice(0, 500)}`, {
					path: input.request.path,
				}),
			};
		}
	}
	parentPort?.postMessage(reply);
}

await main();
