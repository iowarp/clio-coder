import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { runCommandVector } from "../../core/safe-exec.js";
import type { MainSandboxPolicy } from "../../core/sandbox/main-session.js";
import type { JudgedInputRecord, ProvenanceProbeRecord } from "./numeric.js";

/**
 * Provenance a judged check declares: the input files it reads, hashed before
 * the first run and again after each one, and the probes that name what it
 * ran under (a library version, one environment variable). Inputs gate: a
 * file that is unreadable before the run fails the check before it runs, and
 * one that changed while it ran fails it, because the verdict could not name
 * the bytes the command read. Probes never gate.
 */

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_VERSION_CHARS = 120;

export async function sha256File(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
	const hash = createHash("sha256");
	let sizeBytes = 0;
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk as Buffer);
		sizeBytes += (chunk as Buffer).byteLength;
	}
	return { sha256: hash.digest("hex"), sizeBytes };
}

/** Hash each declared input; the first one that is not a readable regular file is the error. */
export async function hashJudgedInputs(
	inputs: ReadonlyArray<{ path: string; absolute: string }>,
): Promise<JudgedInputRecord[] | Error> {
	const records: JudgedInputRecord[] = [];
	for (const input of inputs) {
		try {
			if (!(await stat(input.absolute)).isFile()) throw new Error("not a regular file");
			records.push({ path: input.path, ...(await sha256File(input.absolute)) });
		} catch (error) {
			return new Error(`input '${input.path}' cannot be read (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	return records;
}

/** Hash the inputs again after a run and name every one whose bytes differ, or undefined when none does. */
export async function judgedInputDrift(
	before: ReadonlyArray<JudgedInputRecord>,
	inputs: ReadonlyArray<{ path: string; absolute: string }>,
): Promise<string | undefined> {
	const changed: string[] = [];
	for (const [index, input] of inputs.entries()) {
		const was = before[index]?.sha256 ?? "absent";
		let now = "absent";
		try {
			if ((await stat(input.absolute)).isFile()) now = (await sha256File(input.absolute)).sha256;
		} catch {
			// Removed or unreadable reads as absent.
		}
		if (now !== was) changed.push(`input '${input.path}' changed while the check ran (${was}→${now})`);
	}
	return changed.length === 0 ? undefined : changed.join("; ");
}

/** Run each probe once, in the check's directory and sandbox, and record what it printed. */
export async function runProvenanceProbes(
	probes: ReadonlyArray<ReadonlyArray<string>>,
	options: { cwd: string; workspaceRoot: string; shellSandbox?: MainSandboxPolicy; signal?: AbortSignal },
): Promise<ProvenanceProbeRecord[]> {
	const records: ProvenanceProbeRecord[] = [];
	for (const probe of probes) {
		const [file, ...args] = probe;
		const argv = [...probe];
		if (file === undefined) continue;
		try {
			const result = await runCommandVector(file, args, {
				cwd: options.cwd,
				workspaceRoot: options.workspaceRoot,
				timeoutMs: PROBE_TIMEOUT_MS,
				maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
				...(options.signal !== undefined ? { signal: options.signal } : {}),
				...(options.shellSandbox !== undefined ? { shellSandbox: options.shellSandbox } : {}),
			});
			const output = `${result.stdout}${result.stderr}`;
			const line = output
				.split("\n")
				.map((entry) => entry.trim())
				.find((entry) => entry.length > 0);
			const launched = result.launched !== false;
			records.push({
				argv,
				exitCode: !launched || result.timedOut || result.aborted ? null : result.exitCode,
				sha256: launched ? createHash("sha256").update(output).digest("hex") : null,
				version: !launched || line === undefined ? null : line.slice(0, PROBE_VERSION_CHARS),
			});
		} catch {
			records.push({ argv, exitCode: null, sha256: null, version: null });
		}
	}
	return records;
}
