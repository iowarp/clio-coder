import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CoveredRun {
	code: number | null;
	stdout: string;
	stderr: string;
	files: Set<string>;
}

/** Find emitted JavaScript by stable bundled provenance instead of hash or size. */
export function emittedJavaScriptContaining(root: string, needle: string): Set<string> {
	const matches = new Set<string>();
	for (const entry of readdirSync(join(root, "dist"), { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		const path = join(entry.parentPath, entry.name);
		if (readFileSync(path, "utf8").includes(needle)) matches.add(realpathSync(path));
	}
	return matches;
}

export function coveredFiles(directory: string): Set<string> {
	const files = new Set<string>();
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".json")) continue;
		const payload = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
			result?: Array<{ url?: string }>;
		};
		for (const script of payload.result ?? []) {
			if (!script.url?.startsWith("file:")) continue;
			try {
				files.add(realpathSync(fileURLToPath(script.url)));
			} catch {
				// Builtins, deleted temp files, and non-file coverage entries are irrelevant.
			}
		}
	}
	return files;
}

async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32" && child.pid !== undefined) {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve();
			};
			const timeout = setTimeout(() => {
				killer.kill();
				finish();
			}, 2_000);
			killer.once("error", finish);
			killer.once("close", finish);
		});
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		return;
	}
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// The child may not have established its process group yet.
		}
	}
	child.kill("SIGKILL");
}

/** Run the real built CLI in a fresh process and return its evaluated file set. */
export async function runCliWithCoverage(input: {
	bin: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	coverageDir: string;
	timeoutMs?: number;
}): Promise<CoveredRun> {
	mkdirSync(input.coverageDir, { recursive: true });
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		...input.env,
		NODE_V8_COVERAGE: input.coverageDir,
		NODE_DISABLE_COMPILE_CACHE: "1",
	};
	delete childEnv.CLIO_CODER_PACKAGE_ROOT;
	const child = spawn(process.execPath, [input.bin, ...input.args], {
		cwd: input.cwd,
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		let timedOut = false;
		let reapDeadline: ReturnType<typeof setTimeout> | undefined;
		const timeoutMs = input.timeoutMs ?? 30_000;
		const timeout = setTimeout(() => {
			timedOut = true;
			void terminateProcessTree(child).finally(() => {
				reapDeadline = setTimeout(() => {
					void terminateProcessTree(child).finally(() => {
						reject(new Error(`covered CLI could not be reaped after exceeding ${timeoutMs}ms: ${input.args.join(" ")}`));
					});
				}, 2_000);
			});
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timeout);
			if (reapDeadline) clearTimeout(reapDeadline);
			void terminateProcessTree(child).finally(() => reject(error));
		});
		child.once("close", (status) => {
			clearTimeout(timeout);
			if (reapDeadline) clearTimeout(reapDeadline);
			if (timedOut) {
				reject(new Error(`covered CLI exceeded ${timeoutMs}ms and was reaped: ${input.args.join(" ")}`));
				return;
			}
			resolve(status);
		});
	});
	return { code, stdout, stderr, files: coveredFiles(input.coverageDir) };
}
