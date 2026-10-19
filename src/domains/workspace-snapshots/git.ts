import { spawn } from "node:child_process";
import { buildSafeToolEnv } from "../../core/safe-exec.js";

/**
 * Git subprocesses for workspace snapshots. The environment is the safe-exec
 * allowlist, so an inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE from the
 * shell that started Clio never points a snapshot at the operator's own index;
 * the private index is named explicitly per call. These are not tool
 * subprocesses: they bypass `runCommandVector` because its commit-attribution
 * wrapper probes the repository with synchronous Git calls for every distinct
 * Git environment, which tripled snapshot latency, and snapshot plumbing runs
 * no hooks for attribution to reach.
 */

/** Raised for every condition that makes a snapshot or a rewind unavailable. */
export class SnapshotUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotUnavailableError";
	}
}

/** Listing a very large repository stays bounded; past this the snapshot is refused rather than held in memory. */
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_CHARS = 4096;

export interface GitCall {
	cwd: string;
	/** `performance.now()` instant after which the call is refused, so one snapshot shares one time budget. */
	deadline: number;
	/** Private index for this call; absent leaves Git on the repository's own index. */
	indexFile?: string;
	env?: Readonly<Record<string, string>>;
	input?: string;
	/** Non-zero exit codes the caller interprets itself instead of failing. */
	allowExit?: ReadonlyArray<number>;
	/** `-c key=value` pairs placed before the subcommand. */
	config?: ReadonlyArray<string>;
}

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function firstLine(text: string): string {
	return (
		text
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	);
}

export function runGit(args: ReadonlyArray<string>, call: GitCall): Promise<GitResult> {
	const name = args.find((arg) => !arg.startsWith("-")) ?? "git";
	const remaining = call.deadline - performance.now();
	if (remaining <= 0) return Promise.reject(new SnapshotUnavailableError("timed out"));
	return new Promise((resolve, reject) => {
		const child = spawn("git", [...(call.config ?? []).flatMap((pair) => ["-c", pair]), ...args], {
			cwd: call.cwd,
			env: buildSafeToolEnv({
				GIT_TERMINAL_PROMPT: "0",
				GIT_OPTIONAL_LOCKS: "0",
				...(call.indexFile !== undefined ? { GIT_INDEX_FILE: call.indexFile } : {}),
				...call.env,
			}),
			stdio: [call.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderr = "";
		let failure: SnapshotUnavailableError | null = null;
		const stop = (error: SnapshotUnavailableError): void => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => stop(new SnapshotUnavailableError(`git ${name} timed out`)), remaining);
		// Output is collected as bytes and decoded once: a path split across two
		// pipe chunks would otherwise decode as two replacement characters.
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes > MAX_GIT_OUTPUT_BYTES)
				stop(new SnapshotUnavailableError(`git ${name} output exceeded the snapshot limit`));
			else chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(
				new SnapshotUnavailableError(error.code === "ENOENT" ? "git is not installed" : `git ${name}: ${error.message}`),
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (failure !== null) return reject(failure);
			const exitCode = code ?? -1;
			if (exitCode !== 0 && !(call.allowExit ?? []).includes(exitCode)) {
				const detail = firstLine(stderr);
				return reject(
					new SnapshotUnavailableError(`git ${name} failed: ${detail.length > 0 ? detail : `exit ${exitCode}`}`),
				);
			}
			resolve({ stdout: Buffer.concat(chunks).toString("utf8"), stderr, exitCode });
		});
		if (call.input !== undefined && child.stdin) {
			child.stdin.on("error", () => {
				// Git exited before reading all of stdin; its exit status reports why.
			});
			child.stdin.end(call.input);
		}
	});
}

/** NUL-separated Git output (`-z`) as a list, without the empty trailing field. */
export function splitNul(text: string): string[] {
	return text.split("\0").filter((part) => part.length > 0);
}

export const GITLINK_MODE = "160000";

export interface RawDiffEntry {
	/** Mode and status read from `<from>` to `<to>`: A is only in `<to>`, D only in `<from>`. */
	fromMode: string;
	toMode: string;
	status: string;
	path: string;
	/** Which `--stdin` pair the entry belongs to, in input order; 0 for a single diff. */
	pair: number;
}

/**
 * Parse `git diff-tree -r -z` raw output. With `--stdin` each tree pair is
 * preceded by a header line naming the pair, so one call can diff many pairs.
 * Rename detection is off, so every status is one letter.
 */
export function parseRawDiff(output: string): RawDiffEntry[] {
	const entries: RawDiffEntry[] = [];
	let pair = 0;
	let headers = 0;
	let index = 0;
	while (index < output.length) {
		if (output[index] === ":") {
			const metaEnd = output.indexOf("\0", index);
			const pathEnd = metaEnd < 0 ? -1 : output.indexOf("\0", metaEnd + 1);
			if (metaEnd < 0 || pathEnd < 0) break;
			const [fromMode = "", toMode = "", , , status = ""] = output.slice(index + 1, metaEnd).split(" ");
			entries.push({ fromMode, toMode, status: status.slice(0, 1), path: output.slice(metaEnd + 1, pathEnd), pair });
			index = pathEnd + 1;
			continue;
		}
		// A pair header from --stdin: `<tree> <tree>` ended by a newline (or NUL).
		let end = index;
		while (end < output.length && output[end] !== "\n" && output[end] !== "\0") end += 1;
		pair = headers;
		headers += 1;
		index = end + 1;
	}
	return entries;
}
