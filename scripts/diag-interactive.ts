import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 1 Front 1 diag: interactive idle loop + shutdown sequence smoke.
 *
 * Spawns `node dist/cli/index.js` with CLIO_PHASE1_INTERACTIVE=1 and
 * CLIO_BUS_TRACE=1. Waits for the banner. Sends SIGINT. Asserts:
 *   (a) banner "◆ clio" appears on stdout,
 *   (b) "clio: received SIGINT, shutting down..." appears on stderr,
 *   (c) bus trace lines for shutdown.requested, shutdown.drained,
 *       shutdown.terminated, shutdown.persisted, session.end appear
 *       on stderr in that order (the "EXIT" of DRAIN -> TERMINATE ->
 *       PERSIST -> EXIT maps to session.end),
 *   (d) process exit code is 130 (SIGINT -> 130).
 *
 * Exits 0 on success. Any assertion failure dumps full stdout/stderr and
 * exits 1. A 5s hard timeout SIGKILLs the child and fails.
 */

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");

function log(msg: string): void {
	process.stdout.write(`[diag-interactive] ${msg}\n`);
}

function dumpAndFail(msg: string, stdout: string, stderr: string): never {
	process.stderr.write(`[diag-interactive] FAIL: ${msg}\n`);
	process.stderr.write(`[diag-interactive] --- stdout ---\n${stdout}\n`);
	process.stderr.write(`[diag-interactive] --- stderr ---\n${stderr}\n`);
	process.exit(1);
}

function ensureBuilt(): void {
	if (!existsSync(cliPath)) {
		log("dist/cli/index.js missing; running tsup build");
		execFileSync("npm", ["run", "build"], { stdio: "inherit" });
	}
}

function ensureInstalled(home: string): void {
	log(`ephemeral CLIO_HOME=${home}`);
	const env: NodeJS.ProcessEnv = { ...process.env, CLIO_HOME: home };
	try {
		execFileSync("node", [cliPath, "install"], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			stdout?: Buffer | string;
			stderr?: Buffer | string;
			status?: number;
		};
		process.stderr.write(`[diag-interactive] clio install failed (${e.status ?? "?"})\n`);
		if (e.stdout) process.stderr.write(`stdout:\n${e.stdout.toString()}\n`);
		if (e.stderr) process.stderr.write(`stderr:\n${e.stderr.toString()}\n`);
		process.exit(1);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
}

async function runInteractive(home: string): Promise<RunResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLIO_HOME: home,
		CLIO_PHASE1_INTERACTIVE: "1",
		CLIO_BUS_TRACE: "1",
	};

	const child: ChildProcessWithoutNullStreams = spawn("node", [cliPath], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});

	// Wait 200ms for the banner.
	await sleep(200);

	// Send SIGINT.
	child.kill("SIGINT");

	// Hard 5s timeout from SIGINT; on timeout SIGKILL and flag.
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, 5000);

	const { code, signal } = await exitPromise;
	clearTimeout(timeout);

	return { stdout, stderr, exitCode: code, signal, timedOut };
}

function assertOrdered(haystack: string, needles: string[], stdout: string, stderr: string): void {
	let cursor = 0;
	for (const needle of needles) {
		const idx = haystack.indexOf(needle, cursor);
		if (idx < 0) {
			dumpAndFail(
				`expected ordered substring not found: ${JSON.stringify(needle)} (at or after ${cursor})`,
				stdout,
				stderr,
			);
		}
		cursor = idx + needle.length;
	}
}

async function main(): Promise<void> {
	ensureBuilt();
	const home = mkdtempSync(join(tmpdir(), "clio-diag-interactive-"));
	ensureInstalled(home);

	const result = await runInteractive(home);

	if (result.timedOut) {
		dumpAndFail("child did not exit within 5s after SIGINT (SIGKILLed)", result.stdout, result.stderr);
	}

	// (a) banner on stdout
	if (!result.stdout.includes("◆ clio")) {
		dumpAndFail("banner marker '◆ clio' missing from stdout", result.stdout, result.stderr);
	}

	// (b) SIGINT notice on stderr
	if (!result.stderr.includes("clio: received SIGINT, shutting down...")) {
		dumpAndFail("SIGINT notice missing from stderr", result.stdout, result.stderr);
	}

	// (c) ordered bus trace lines on stderr (DRAIN -> TERMINATE -> PERSIST -> EXIT)
	assertOrdered(
		result.stderr,
		[
			"[clio:bus] shutdown.requested",
			"[clio:bus] shutdown.drained",
			"[clio:bus] shutdown.terminated",
			"[clio:bus] shutdown.persisted",
			"[clio:bus] session.end",
		],
		result.stdout,
		result.stderr,
	);

	// (d) exit code 130
	if (result.exitCode !== 130) {
		dumpAndFail(
			`expected exit code 130, got code=${result.exitCode} signal=${result.signal ?? "none"}`,
			result.stdout,
			result.stderr,
		);
	}

	log("PASS: banner, SIGINT notice, DRAIN→TERMINATE→PERSIST→EXIT bus trace, exit 130");
	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(`[diag-interactive] unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
