import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeScratchHome } from "../harness/scratch-env.js";

const fixture = fileURLToPath(new URL("../fixtures/shutdown/owner.ts", import.meta.url));
interface Identity {
	pid: number;
	group: number;
	start: string;
	state: string;
}
function identity(pid: number): Identity | null {
	try {
		const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.split(" ");
		if (!fields?.[19]) throw new Error("invalid process identity");
		return { pid, group: Number(fields[2]), start: fields[19], state: fields[0] ?? "" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
function live(owned: Identity): boolean {
	const current = identity(owned.pid);
	return current !== null && current.start === owned.start && current.state !== "Z";
}
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const end = performance.now() + timeoutMs;
	while (performance.now() < end) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

// These exercise real source process ownership with no provider or terminal boot.
// Linux start identities keep failure cleanup scoped even if a PID is recycled.
describe("operator shell and wiki shutdown", { concurrency: false, skip: process.platform !== "linux" }, () => {
	for (const mode of ["editor", "wiki"]) {
		for (const resistance of ["none", "group", "descendant", "descendant-silent"] as const) {
			const resistant = resistance !== "none";
			it(`${mode} awaits ${resistance} resistance termination of its owned group`, {
				timeout: 25_000,
			}, async (t) => {
				const home = makeScratchHome("clio-coder-shutdown-");
				const owned: Identity[] = [];
				writeFileSync(
					join(home.dir, "descendant.mjs"),
					[
						"import { readFileSync, writeFileSync } from 'node:fs';",
						"const identity = pid => { const f = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' '); return { pid, group: Number(f[2]), start: f[19], state: f[0] }; };",
						`process.on('SIGTERM', () => { writeFileSync('term-observed', 'yes'); ${resistant ? "" : "process.exit(0);"} });`,
						"writeFileSync('owned.json', JSON.stringify([identity(process.ppid), identity(process.pid)]));",
						"writeFileSync('descendant.pid', String(process.pid));",
						"setInterval(() => {}, 1000);",
					].join("\n"),
				);
				const command = `trap '${resistance === "group" ? "" : resistance.startsWith("descendant") ? "exit 17" : "exit 0"}' TERM; printf '%s' "$$" > shell.pid; node descendant.mjs ${resistance === "descendant-silent" ? ">/dev/null 2>&1 </dev/null" : ""} & wait`;
				const child = spawn(process.execPath, ["--import", "tsx", fixture, mode, home.dir, command], {
					env: { ...process.env, ...home.env, CLIO_CODER_SHUTDOWN_HOOK_MS: "500" },
					stdio: ["ignore", "ignore", "pipe"],
				});
				let stderr = "";
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				let closed = false;
				child.once("close", () => {
					closed = true;
				});
				const cleanupErrors: unknown[] = [];
				try {
					assert.ok(
						await waitFor(() => existsSync(join(home.dir, "descendant.pid")) || child.exitCode !== null, 10_000),
						stderr,
					);
					owned.push(...(JSON.parse(readFileSync(join(home.dir, "owned.json"), "utf8")) as Identity[]));
					assert.equal(owned.length, 2);
					assert.ok(owned.every(live));
					assert.equal(owned[0]?.group, owned[1]?.group);
					assert.notEqual(owned[0]?.group, identity(child.pid as number)?.group);
					const signaledAt = performance.now();
					let leaderExitObservedAfterMs: number | null = null;
					child.kill("SIGTERM");
					assert.ok(
						await waitFor(() => {
							const leader = owned[0];
							if (leader && !live(leader)) leaderExitObservedAfterMs ??= performance.now() - signaledAt;
							return child.exitCode !== null || child.signalCode !== null;
						}, 8000),
						`owner did not settle; ${stderr}`,
					);
					assert.ok(await waitFor(() => closed, 1000), "owner pipes did not close");
					assert.equal(child.exitCode, 143, stderr);
					t.diagnostic(
						JSON.stringify({
							mode,
							resistance,
							leaderExitObservedAfterMs,
							ownerExitObservedAfterMs: performance.now() - signaledAt,
							descendantStdio: resistance === "descendant-silent" ? "ignored" : "inherited",
							owned,
						}),
					);
					assert.ok(await waitFor(() => owned.every((pid) => !live(pid)), 1000), "owned descendant survived owner exit");
					assert.ok(existsSync(join(home.dir, "term-observed")));
					assert.ok(existsSync(join(home.dir, "persisted")));
					assert.doesNotMatch(stderr, /exceeded|failed/);
					if (mode === "editor") {
						const entry = JSON.parse(readFileSync(join(home.dir, "entry.json"), "utf8"));
						assert.equal(entry.cancelled, true);
						assert.equal(entry.kind, "bashExecution");
						const result = JSON.parse(readFileSync(join(home.dir, "bash-result.json"), "utf8"));
						assert.equal(result.aborted, true);
						assert.equal(result.exitCode, resistance === "group" ? null : resistance.startsWith("descendant") ? 17 : 0);
						assert.equal(result.signal, resistance === "group" ? "SIGKILL" : null);
						if (resistance === "group") {
							assert.equal(result.error.message, "command terminated by SIGKILL");
							assert.equal(result.error.signal, "SIGKILL");
						} else if (resistance.startsWith("descendant")) {
							assert.equal(result.error.message, "command exited with code 17");
							assert.equal(result.error.code, 17);
						} else assert.equal(result.error, null);
					} else {
						const result = JSON.parse(readFileSync(join(home.dir, "worker-result.json"), "utf8"));
						assert.equal(result.forcedKills, resistant ? 1 : 0);
						if (resistance.startsWith("descendant")) assert.equal(result.exitCode, 17);
						assert.equal(result.signal, resistance === "group" ? "SIGKILL" : null);
					}
				} finally {
					try {
						// The child recorded start identities itself, so recovery never
						// adopts an unrelated process that later reused one of its PIDs.
						const path = join(home.dir, "owned.json");
						if (owned.length === 0 && existsSync(path)) owned.push(...(JSON.parse(readFileSync(path, "utf8")) as Identity[]));
						for (const signal of ["SIGTERM", "SIGKILL"] as const) {
							for (const entry of owned) {
								try {
									if (live(entry)) process.kill(-entry.group, signal);
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupErrors.push(error);
								}
							}
							if (child.exitCode === null && child.signalCode === null) child.kill(signal);
							if (await waitFor(() => owned.every((entry) => !live(entry)) && closed, 1500)) break;
						}
						if (owned.some(live) || !closed) cleanupErrors.push(new Error("owned fixture cleanup did not settle"));
					} catch (error) {
						cleanupErrors.push(error);
					} finally {
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
						home.cleanup();
					}
				}
				if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "shutdown fixture cleanup failed");
			});
		}
	}
	for (const mode of ["budget", "domains"]) {
		it(`keeps per-hook limits within the ${mode} shutdown allowance`, { timeout: 10_000 }, async () => {
			const home = makeScratchHome("clio-coder-shutdown-budget-");
			const child = spawn(process.execPath, ["--import", "tsx", fixture, mode, home.dir, "unused"], {
				env: { ...process.env, ...home.env, CLIO_CODER_SHUTDOWN_HOOK_MS: "50" },
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			try {
				assert.ok(await waitFor(() => child.exitCode !== null, 5000));
				assert.equal(child.exitCode, 0);
				if (mode === "budget") {
					assert.match(stderr, /drain\[1\] exceeded 50ms budget/);
					assert.doesNotMatch(stderr, /drain\[0\] exceeded/);
				} else {
					assert.match(stderr, /slow.stop\(\) exceeded 50ms budget/);
					assert.doesNotMatch(stderr, /persist\[0\] exceeded/);
				}
				assert.ok(existsSync(join(home.dir, "persisted")));
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				home.cleanup();
			}
		});
	}
});
