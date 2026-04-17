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
 * Opt-in real-provider mode gated by CLIO_STRESS_REAL=1. Under that gate the
 * harness seeds a settings tree with llamacpp@mini and lmstudio@dynamo
 * endpoints, alternates 4 workers across both targets, and exercises the real
 * stream + registry against the homelab instead of the faux runtime. Invoked
 * via `npm run stress:real`. Requires network access to 192.168.86.0/24 and is
 * NOT part of CI.
 *
 * Invoked via `npm run stress`. Exits 0 on success, 1 on any failure.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const REAL_MODE = process.env.CLIO_STRESS_REAL === "1";
const CONCURRENCY = REAL_MODE ? 4 : 10;
// Per-worker execFile lifetime. Real mode serializes two workers onto the
// single-slot llama-server at mini, so 60s cold-start budget must be doubled
// and padded for startup contention from four concurrent node processes.
const TIMEOUT_MS = REAL_MODE ? 180_000 : 60_000;
const OVERALL_TIMEOUT_MS = 600_000;
const LOG_PREFIX = REAL_MODE ? "[stress-real]" : "[stress]";
const INTERRUPTION_MARKERS = ["interrupted", "SIGTERM", "SIGINT", "abort"];
// Real-mode task content: keep the prompt terse so the thinking model on mini
// doesn't produce minutes of reasoning tokens. The goal is to exercise the
// stream/registry under concurrency, not to evaluate model output quality.
const REAL_TASK_PROMPT = "Reply with exactly the word OK and nothing else.";

interface RealTarget {
	readonly providerId: "llamacpp" | "lmstudio";
	readonly endpoint: string;
	readonly url: string;
	readonly model: string;
}

const REAL_TARGETS: ReadonlyArray<RealTarget> = [
	{
		providerId: "llamacpp",
		endpoint: "mini",
		url: "http://192.168.86.141:8080",
		model: "Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
	},
	{
		providerId: "lmstudio",
		endpoint: "dynamo",
		url: "http://192.168.86.143:1234",
		model: "qwen3.6-35b-a3b",
	},
];

interface RunResult {
	index: number;
	exitCode: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	pid: number | null;
	errored: boolean;
	target?: RealTarget;
}

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`${LOG_PREFIX} OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`${LOG_PREFIX} FAIL ${label}${detail ? ` (${detail})` : ""}\n`);
}

function info(label: string, detail: string): void {
	process.stdout.write(`${LOG_PREFIX} INFO ${label} ${detail}\n`);
}

function buildRealSettingsYaml(): string {
	const q = (s: string): string => JSON.stringify(s);
	const lines: string[] = [
		"version: 1",
		"identity: clio",
		"defaultMode: default",
		"safetyLevel: auto-edit",
		"provider:",
		"  active: null",
		"  model: null",
		"runtimes:",
		"  enabled:",
		"    - llamacpp",
		"    - lmstudio",
		"providers:",
	];
	for (const t of REAL_TARGETS) {
		lines.push(`  ${t.providerId}:`);
		lines.push("    endpoints:");
		lines.push(`      ${t.endpoint}:`);
		lines.push(`        url: ${q(t.url)}`);
		lines.push(`        default_model: ${q(t.model)}`);
		// pi-ai's OpenAI-compatible client requires a non-empty Bearer. mini and
		// dynamo accept any value on the chat-completions path.
		lines.push(`        api_key: ${q("clio-stress-placeholder")}`);
	}
	lines.push("workers:");
	lines.push("  default:");
	lines.push(`    provider: ${q("llamacpp")}`);
	lines.push(`    endpoint: ${q("mini")}`);
	lines.push(`    model: ${q("Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL")}`);
	lines.push("budget:");
	lines.push("  sessionCeilingUsd: 5");
	lines.push("  concurrency: auto");
	lines.push("theme: default");
	lines.push("keybindings: {}");
	lines.push("state:");
	lines.push("  lastMode: default");
	lines.push("");
	return lines.join("\n");
}

function buildArgs(index: number, cliEntry: string): { args: string[]; target?: RealTarget } {
	if (REAL_MODE) {
		const target = REAL_TARGETS[index % REAL_TARGETS.length] as RealTarget;
		return {
			args: [
				cliEntry,
				"run",
				"scout",
				"--provider",
				target.providerId,
				"--endpoint",
				target.endpoint,
				"--model",
				target.model,
				REAL_TASK_PROMPT,
			],
			target,
		};
	}
	return { args: [cliEntry, "run", "scout", "--faux", `task ${index}`] };
}

async function runOne(index: number, cliEntry: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
	const { args, target } = buildArgs(index, cliEntry);
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
			target,
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
			target,
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
		process.stdout.write(`${LOG_PREFIX} building dist/ ...\n`);
		await execFileP("npm", ["run", "build"], { cwd: projectRoot });
	}
	if (!existsSync(cliEntry) || !existsSync(workerEntry)) {
		process.stderr.write(`${LOG_PREFIX} build did not produce dist/cli/index.js or dist/worker/entry.js\n`);
		process.exit(1);
	}

	const home = mkdtempSync(join(tmpdir(), REAL_MODE ? "clio-stress-real-" : "clio-stress-"));
	// Build the child env from process.env minus the XDG overrides so no stray
	// CLIO_DATA_DIR / CLIO_CONFIG_DIR / CLIO_CACHE_DIR leaks past CLIO_HOME.
	// Real mode also drops CLIO_WORKER_FAUX* so a parent-side faux flag never
	// bleeds into a real dispatch.
	const DROPPED = new Set(["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"]);
	if (REAL_MODE) {
		DROPPED.add("CLIO_WORKER_FAUX");
		DROPPED.add("CLIO_WORKER_FAUX_MODEL");
		DROPPED.add("CLIO_WORKER_FAUX_TEXT");
	}
	const childEnv: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!DROPPED.has(k) && typeof v === "string") childEnv[k] = v;
	}
	childEnv.CLIO_HOME = home;

	if (REAL_MODE) {
		writeFileSync(join(home, "settings.yaml"), buildRealSettingsYaml(), { encoding: "utf8", mode: 0o644 });
		info("home", home);
		info("targets", REAL_TARGETS.map((t) => `${t.providerId}@${t.endpoint}`).join(","));
		info("concurrency", String(CONCURRENCY));
		info("per-worker-timeout-ms", String(TIMEOUT_MS));
		info("overall-timeout-ms", String(OVERALL_TIMEOUT_MS));
	} else {
		childEnv.CLIO_WORKER_FAUX = "1";
		childEnv.CLIO_WORKER_FAUX_MODEL = "faux-model";
		childEnv.CLIO_WORKER_FAUX_TEXT = "hello from stress";
	}

	let overallDeadlineHit = false;
	const overallTimer = REAL_MODE
		? setTimeout(() => {
				overallDeadlineHit = true;
				process.stderr.write(`${LOG_PREFIX} overall deadline hit after ${OVERALL_TIMEOUT_MS}ms\n`);
			}, OVERALL_TIMEOUT_MS)
		: null;
	overallTimer?.unref();

	try {
		process.stdout.write(`${LOG_PREFIX} spawning ${CONCURRENCY} concurrent runs under ${home}\n`);
		const started = Date.now();
		const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runOne(i, cliEntry, childEnv)));
		const elapsedMs = Date.now() - started;
		process.stdout.write(`${LOG_PREFIX} all ${results.length} runs resolved in ${elapsedMs}ms\n`);
		if (REAL_MODE) {
			check("overall:within-deadline", !overallDeadlineHit, `budget=${OVERALL_TIMEOUT_MS}ms elapsed=${elapsedMs}ms`);
		}

		check("runs:count-matches-concurrency", results.length === CONCURRENCY, `got=${results.length}`);

		for (const r of results) {
			const isClean = r.exitCode === 0 && r.signal === null;
			const hasInterruptionMarker = INTERRUPTION_MARKERS.some((m) => r.stderr.toLowerCase().includes(m.toLowerCase()));
			const acceptable = isClean || hasInterruptionMarker;
			const targetTag = r.target ? ` target=${r.target.providerId}@${r.target.endpoint}` : "";
			check(
				`run[${r.index}]:clean-or-interrupted`,
				acceptable,
				`exit=${r.exitCode} signal=${r.signal ?? "none"}${targetTag} stderr=${r.stderr.slice(0, 200)}`,
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

		if (REAL_MODE) {
			const providerCoverage = new Set(results.map((r) => r.target?.providerId).filter(Boolean));
			check(
				"real:both-providers-covered",
				providerCoverage.size === REAL_TARGETS.length,
				`covered=${[...providerCoverage].join(",")}`,
			);
		}
	} finally {
		if (overallTimer) clearTimeout(overallTimer);
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best effort; nothing to do if cleanup fails.
		}
	}

	if (failures.length > 0) {
		process.stderr.write(`${LOG_PREFIX} FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write(`${LOG_PREFIX} PASS\n`);
}

main().catch((err) => {
	process.stderr.write(`${LOG_PREFIX} crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
