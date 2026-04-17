/**
 * CLI worker subprocess entry point.
 *
 * Reads a CliWorkerSpec JSON document from stdin, spawns the configured
 * external CLI binary, pipes the task prompt to its stdin, captures stdout
 * and stderr, and emits wrapped NDJSON events (`agent_start`, `message_end`,
 * `cli_stderr` when present, `agent_end`) on stdout. Exits with the child's
 * exit code, or 1 if the child failed to start.
 *
 * This module is intentionally isolated: it imports ONLY from
 * `src/worker/ndjson.js`. It must never import pi-mono or any src/domains
 * module, because it runs out-of-process against arbitrary third-party
 * binaries (claude-code, codex, gemini, ...) whose lifecycle has nothing to
 * do with the Clio domain stack.
 */

import { spawn } from "node:child_process";
import { emitEvent } from "./ndjson.js";

interface CliWorkerSpec {
	/** Executable name or absolute path. */
	binary: string;
	/** Arguments passed to the binary. */
	binaryArgs: string[];
	/** Prompt/task text written to the child's stdin. */
	task: string;
	/** Working directory for the spawned process. */
	cwd?: string;
	/** Inclusive soft-kill timeout in milliseconds. */
	timeoutMs?: number;
}

async function readSpecFromStdin(): Promise<CliWorkerSpec> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			try {
				const parsed = JSON.parse(data) as CliWorkerSpec;
				if (typeof parsed.binary !== "string" || parsed.binary.length === 0) {
					reject(new Error("CliWorkerSpec.binary missing"));
					return;
				}
				if (!Array.isArray(parsed.binaryArgs)) {
					reject(new Error("CliWorkerSpec.binaryArgs must be an array"));
					return;
				}
				if (typeof parsed.task !== "string") {
					reject(new Error("CliWorkerSpec.task must be a string"));
					return;
				}
				resolve(parsed);
			} catch (err) {
				reject(err);
			}
		});
		process.stdin.on("error", reject);
	});
}

async function main(): Promise<number> {
	const spec = await readSpecFromStdin();
	emitEvent({ type: "agent_start", binary: spec.binary });

	const spawnOpts: Parameters<typeof spawn>[2] = {
		stdio: ["pipe", "pipe", "pipe"],
	};
	if (spec.cwd) spawnOpts.cwd = spec.cwd;

	const child = spawn(spec.binary, spec.binaryArgs, spawnOpts);

	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer | string) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer | string) => {
		stderr += chunk.toString();
	});

	try {
		child.stdin?.write(spec.task);
		child.stdin?.end();
	} catch (err) {
		emitEvent({ type: "cli_error", error: err instanceof Error ? err.message : String(err) });
	}

	let timeoutHandle: NodeJS.Timeout | null = null;
	if (typeof spec.timeoutMs === "number" && spec.timeoutMs > 0) {
		timeoutHandle = setTimeout(() => {
			emitEvent({ type: "cli_timeout", timeoutMs: spec.timeoutMs });
			try {
				child.kill("SIGTERM");
			} catch {
				// best-effort
			}
		}, spec.timeoutMs);
	}

	const exit: { code: number | null; signal: NodeJS.Signals | null } = await new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
		child.once("error", (err) => {
			emitEvent({ type: "cli_error", error: err instanceof Error ? err.message : String(err) });
			resolve({ code: 1, signal: null });
		});
	});

	if (timeoutHandle) clearTimeout(timeoutHandle);

	emitEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: stdout }] },
	});
	if (stderr) emitEvent({ type: "cli_stderr", text: stderr });
	emitEvent({ type: "agent_end", messages: [], exitCode: exit.code, signal: exit.signal });

	return exit.code ?? 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[worker-cli] fatal: ${msg}\n`);
		process.exit(2);
	},
);
