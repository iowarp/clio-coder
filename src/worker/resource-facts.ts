/**
 * Node resource observation, taken by the worker process on the node that will
 * execute the run.
 *
 * CPU and memory come from the OS and are always observable. GPU count and
 * VRAM come from a bounded `nvidia-smi` probe: a node without the tool, without
 * a GPU, or with a probe that does not answer inside the window reports
 * unknown rather than zero. Model residency is reported unknown because a
 * worker only observes the models it loads itself, and inferring an endpoint's
 * resident set from a worker would be a guess dressed as a fact.
 *
 * Nothing here evicts or reshapes residency. Observation only.
 */

import { execFileSync } from "node:child_process";
import { cpus, freemem, hostname, totalmem } from "node:os";
import {
	knownResource,
	UNKNOWN_RESOURCE,
	WORKER_RESOURCE_LABEL_MAX,
	type WorkerResourceFacts,
	type WorkerResourceValue,
} from "./protocol.js";

/** Bound on the GPU probe so a wedged driver cannot delay the announce. */
const GPU_PROBE_TIMEOUT_MS = 1000;

function probeNvidiaGpus(): { gpuCount: WorkerResourceValue<number>; vramBytes: WorkerResourceValue<number> } {
	try {
		const stdout = execFileSync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], {
			timeout: GPU_PROBE_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const megabytes = stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => Number.parseInt(line, 10))
			.filter((value) => Number.isFinite(value) && value > 0);
		if (megabytes.length === 0) return { gpuCount: UNKNOWN_RESOURCE, vramBytes: UNKNOWN_RESOURCE };
		const totalBytes = megabytes.reduce((sum, value) => sum + value, 0) * 1024 * 1024;
		return { gpuCount: knownResource(megabytes.length), vramBytes: knownResource(totalBytes) };
	} catch {
		// No driver, no tool, or no answer inside the window. All three are
		// absence of evidence, never a proven absence of a GPU.
		return { gpuCount: UNKNOWN_RESOURCE, vramBytes: UNKNOWN_RESOURCE };
	}
}

function observeCpuCount(): WorkerResourceValue<number> {
	const count = cpus().length;
	return count > 0 ? knownResource(count) : UNKNOWN_RESOURCE;
}

function observeMemory(read: () => number): WorkerResourceValue<number> {
	const bytes = read();
	return Number.isFinite(bytes) && bytes > 0 ? knownResource(bytes) : UNKNOWN_RESOURCE;
}

/** Observe this node's bounded resource facts for the worker announcement. */
export function observeWorkerResourceFacts(labels: ReadonlyArray<string> = []): WorkerResourceFacts {
	const gpu = probeNvidiaGpus();
	return {
		labels: [...labels].slice(0, WORKER_RESOURCE_LABEL_MAX),
		cpuCount: observeCpuCount(),
		totalMemoryBytes: observeMemory(totalmem),
		freeMemoryBytes: observeMemory(freemem),
		gpuCount: gpu.gpuCount,
		vramBytes: gpu.vramBytes,
		residentModels: UNKNOWN_RESOURCE,
	};
}

/** Host identity as this node reports it, never as the orchestrator assumes it. */
export function observeHostIdentity(): string {
	const name = hostname();
	return name.length > 0 ? name : "unknown-host";
}
