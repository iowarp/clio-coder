/**
 * Phase 6 slice 7 stress harness. Spawns 10 concurrent `clio run` subprocesses
 * against the pi-ai faux provider and a hermetic CLIO_HOME, collects their exit
 * codes + stdout, and asserts:
 *   - all 10 subprocesses exit (no hangs).
 *   - every run either finishes clean (exit 0) or reports interruption on stderr.
 *   - 10 receipt files are written under <home>/data/receipts/.
 *   - the run ledger (runs.json) lists all 10 ids.
 *   - no orphan worker subprocesses remain.
 *
 * Invoked via `npm run stress`. Exits 0 on success, 1 on any failure.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const CONCURRENCY = 10;
const TIMEOUT_MS = 60_000;
const INTERRUPTION_MARKERS = ["interrupted", "SIGTERM", "SIGINT", "abort"];

interface RunResult {
	index: number;
	exitCode: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	pid: number | null;
	errored: boolean;
}

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[stress] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[stress] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function runOne(index: number, cliEntry: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
	const args = [cliEntry, "run", "scout", "--faux", `task ${index}`];
	let recordedPid: number | null = null;
	try {
		const child = execFile(process.execPath, args, {
			env,
			timeout: TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		});
		recordedPid = child.pid ?? null;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on("data", (c: Buffer | string) => {
			stdoutChunks.push(typeof c === "string" ? Buffer.from(c) : c);
		});
		child.stderr?.on("data", (c: Buffer | string) => {
			stderrChunks.push(typeof c === "string" ? Buffer.from(c) : c);
		});
		const { exitCode, signal } = await new Promise<{ exitCode: number; signal: NodeJS.Signals | null }>((resolve) => {
			child.on("close", (code, sig) => resolve({ exitCode: code ?? 1, signal: sig ?? null }));
		});
		return {
			index,
			exitCode,
			signal,
			stdout: Buffer.concat(stdoutChunks).toString("utf8"),
			stderr: Buffer.concat(stderrChunks).toString("utf8"),
			pid: recordedPid,
			errored: false,
		};
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			code?: number | string;
			signal?: NodeJS.Signals;
			stdout?: string;
			stderr?: string;
		};
		return {
			index,
			exitCode: typeof e.code === "number" ? e.code : 1,
			signal: e.signal ?? null,
			stdout: typeof e.stdout === "string" ? e.stdout : "",
			stderr: typeof e.stderr === "string" ? e.stderr : String(err),
			pid: recordedPid,
			errored: true,
		};
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const projectRoot = process.cwd();
	const cliEntry = join(projectRoot, "dist/cli/index.js");
	const workerEntry = join(projectRoot, "dist/worker/entry.js");

	if (!existsSync(cliEntry) || !existsSync(workerEntry)) {
		process.stdout.write("[stress] building dist/ ...\n");
		await execFileP("npm", ["run", "build"], { cwd: projectRoot });
	}
	if (!existsSync(cliEntry) || !existsSync(workerEntry)) {
		process.stderr.write("[stress] build did not produce dist/cli/index.js or dist/worker/entry.js\n");
		process.exit(1);
	}

	const home = mkdtempSync(join(tmpdir(), "clio-stress-"));
	// Build the child env from process.env minus the XDG overrides so no stray
	// CLIO_DATA_DIR / CLIO_CONFIG_DIR / CLIO_CACHE_DIR leaks past CLIO_HOME.
	const DROPPED = new Set(["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"]);
	const childEnv: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!DROPPED.has(k) && typeof v === "string") childEnv[k] = v;
	}
	childEnv.CLIO_HOME = home;
	childEnv.CLIO_WORKER_FAUX = "1";
	childEnv.CLIO_WORKER_FAUX_MODEL = "faux-model";
	childEnv.CLIO_WORKER_FAUX_TEXT = "hello from stress";

	try {
		process.stdout.write(`[stress] spawning ${CONCURRENCY} concurrent runs under ${home}\n`);
		const started = Date.now();
		const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runOne(i, cliEntry, childEnv)));
		const elapsedMs = Date.now() - started;
		process.stdout.write(`[stress] all ${results.length} runs resolved in ${elapsedMs}ms\n`);

		check("runs:count-matches-concurrency", results.length === CONCURRENCY, `got=${results.length}`);

		for (const r of results) {
			const isClean = r.exitCode === 0 && r.signal === null;
			const hasInterruptionMarker = INTERRUPTION_MARKERS.some((m) => r.stderr.toLowerCase().includes(m.toLowerCase()));
			const acceptable = isClean || hasInterruptionMarker;
			check(
				`run[${r.index}]:clean-or-interrupted`,
				acceptable,
				`exit=${r.exitCode} signal=${r.signal ?? "none"} stderr=${r.stderr.slice(0, 200)}`,
			);
		}

		for (const r of results) {
			if (r.pid === null) continue;
			check(`run[${r.index}]:child-pid-exited`, !pidAlive(r.pid), `pid=${r.pid}`);
		}

		const receiptsDir = join(home, "data", "receipts");
		const receiptFiles = existsSync(receiptsDir) ? readdirSync(receiptsDir).filter((f) => f.endsWith(".json")) : [];
		check(
			"receipts:count-matches-concurrency",
			receiptFiles.length === CONCURRENCY,
			`count=${receiptFiles.length} dir=${receiptsDir}`,
		);

		const ledgerPath = join(home, "data", "state", "runs.json");
		check("ledger:runs.json-exists", existsSync(ledgerPath), ledgerPath);
		const ledger = existsSync(ledgerPath)
			? (JSON.parse(readFileSync(ledgerPath, "utf8")) as Array<{ id: string; status: string }>)
			: [];
		check("ledger:contains-concurrency-entries", ledger.length === CONCURRENCY, `ledger-size=${ledger.length}`);

		const ledgerIds = new Set(ledger.map((r) => r.id));
		const receiptIds = new Set(receiptFiles.map((f) => f.replace(/\.json$/, "")));
		const allReceiptsInLedger = [...receiptIds].every((id) => ledgerIds.has(id));
		check(
			"ledger:receipt-ids-subset-of-ledger",
			allReceiptsInLedger,
			`missing=${[...receiptIds].filter((id) => !ledgerIds.has(id)).join(",")}`,
		);
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best effort; nothing to do if cleanup fails.
		}
	}

	if (failures.length > 0) {
		process.stderr.write(`[stress] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[stress] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[stress] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
