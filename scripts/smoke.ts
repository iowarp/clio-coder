/**
 * End-to-end smoke cycle: boot → dispatch → shutdown against a hermetic
 * CLIO_HOME with a 60-second wall-clock ceiling. Each step has its own
 * per-step timeout and fails loudly with `[smoke] FAIL: <step>: <reason>`.
 *
 * The dispatch steps use the faux provider so no network or real credentials
 * are required. Step 8 exercises the safety audit writer in-process to ensure
 * at least one classified action lands in today's audit NDJSON, since the
 * faux worker itself does not invoke tools.
 *
 * Invoked via `npm run smoke`. Exits 0 on success, 1 on any failure.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TOTAL_BUDGET_MS = 60_000;
const PER_STEP_TIMEOUT_MS = 30_000;

const started = Date.now();
const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const workerPath = join(projectRoot, "dist", "worker", "entry.js");

function elapsed(): number {
	return Date.now() - started;
}

function fail(step: string, reason: string): never {
	process.stderr.write(`[smoke] FAIL: ${step}: ${reason}\n`);
	process.exit(1);
}

function checkBudget(step: string): void {
	if (elapsed() > TOTAL_BUDGET_MS) {
		fail(step, `smoke: timeout at step ${step} (elapsed ${elapsed()}ms > ${TOTAL_BUDGET_MS}ms)`);
	}
}

interface CliResult {
	stdout: string;
	stderr: string;
	code: number;
}

async function runCli(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Promise<CliResult> {
	try {
		const { stdout, stderr } = await execFileP(process.execPath, [cliPath, ...args], {
			env,
			timeout: PER_STEP_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		});
		return { stdout, stderr, code: 0 };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			code?: number | string;
			killed?: boolean;
		};
		const code = typeof e.code === "number" ? e.code : e.killed ? 124 : 1;
		const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
		const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? String(err));
		return { stdout, stderr, code };
	}
}

function extractLastJsonObject(stdout: string): unknown | null {
	// The `clio run --json` command streams one JSON event per line, then
	// writes a blank line followed by the pretty-printed receipt. We grab
	// the last top-level `{...}` block by scanning backwards for a line that
	// opens at column 0.
	const marker = "\n{\n";
	const idx = stdout.lastIndexOf(marker);
	const candidate = idx >= 0 ? stdout.slice(idx + 1).trim() : stdout.trim();
	if (!candidate.startsWith("{")) return null;
	try {
		return JSON.parse(candidate);
	} catch {
		return null;
	}
}

function extractReceiptRunId(stdout: string): string | null {
	const m = stdout.match(/receipt:\s+(\S+)/);
	return m ? (m[1] ?? null) : null;
}

function localDateString(d: Date): string {
	return new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);
}

async function triggerOneAuditRecord(home: string): Promise<void> {
	// Faux dispatches don't invoke tools, so no audit records get written
	// through the worker path. We load safety/modes/config against the same
	// CLIO_HOME and fire a single `safety.evaluate` call so the date-stamped
	// audit file picks up at least one classified action. This is the same
	// audit writer that dispatch tool calls would use in a real run.
	const prev = process.env.CLIO_HOME;
	process.env.CLIO_HOME = home;
	try {
		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");

		const result = await loadDomains([ConfigDomainModule, SafetyDomainModule, ModesDomainModule]);
		try {
			type SafetyContractType = import("../src/domains/safety/contract.js").SafetyContract;
			const safety = result.getContract<SafetyContractType>("safety");
			if (!safety) throw new Error("safety contract missing");
			safety.evaluate({ tool: "read", args: { path: "README.md" } }, "default");
		} finally {
			await result.stop();
		}
	} finally {
		if (prev === undefined) Reflect.deleteProperty(process.env, "CLIO_HOME");
		else process.env.CLIO_HOME = prev;
	}
}

async function ensureBuilt(): Promise<void> {
	if (existsSync(cliPath) && existsSync(workerPath)) return;
	process.stdout.write("[smoke] building dist/ (pre-step) ...\n");
	await execFileP("npm", ["run", "build"], { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 });
	if (!existsSync(cliPath)) fail("build", `missing ${cliPath} after build`);
	if (!existsSync(workerPath)) fail("build", `missing ${workerPath} after build`);
}

async function main(): Promise<void> {
	await ensureBuilt();

	const home = mkdtempSync(join(tmpdir(), "clio-smoke-"));
	const DROPPED = new Set(["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"]);
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!DROPPED.has(k) && typeof v === "string") env[k] = v;
	}
	env.CLIO_HOME = home;
	env.CLIO_WORKER_FAUX = "1";
	env.CLIO_WORKER_FAUX_MODEL = "faux-model";

	try {
		// Step 1: clio --version
		{
			const step = "step1:version";
			checkBudget(step);
			const r = await runCli(["--version"], env);
			if (r.code !== 0) fail(step, `exit ${r.code}: ${r.stderr.trim()}`);
			if (!r.stdout.includes("clio ")) fail(step, "stdout missing 'clio '");
			if (!r.stdout.includes("pi-agent-core")) fail(step, "stdout missing 'pi-agent-core'");
		}

		// Step 2: clio install (fresh + idempotent)
		{
			const step = "step2:install";
			checkBudget(step);
			const first = await runCli(["install"], env);
			if (first.code !== 0) fail(`${step}:first`, `exit ${first.code}: ${first.stderr.trim()}`);
			if (!first.stdout.includes("created")) fail(`${step}:first`, "stdout missing 'created'");
			const second = await runCli(["install"], env);
			if (second.code !== 0) fail(`${step}:second`, `exit ${second.code}: ${second.stderr.trim()}`);
			if (!second.stdout.includes("already installed")) fail(`${step}:second`, "stdout missing 'already installed'");
		}

		// Step 3: clio doctor
		{
			const step = "step3:doctor";
			checkBudget(step);
			const r = await runCli(["doctor"], env);
			if (r.code !== 0) fail(step, `exit ${r.code}: ${r.stderr.trim()}`);
			if (!r.stdout.includes(home)) fail(step, `stdout missing ephemeral CLIO_HOME path ${home}`);
		}

		// Step 4: clio providers --json
		{
			const step = "step4:providers-json";
			checkBudget(step);
			const r = await runCli(["providers", "--json"], env);
			if (r.code !== 0) fail(step, `exit ${r.code}: ${r.stderr.trim()}`);
			let parsed: unknown;
			try {
				parsed = JSON.parse(r.stdout);
			} catch (e) {
				fail(step, `stdout not JSON: ${(e as Error).message}`);
			}
			if (!Array.isArray(parsed) || parsed.length === 0) fail(step, "expected non-empty JSON array");
		}

		// Step 5: clio agents --json
		{
			const step = "step5:agents-json";
			checkBudget(step);
			const r = await runCli(["agents", "--json"], env);
			if (r.code !== 0) fail(step, `exit ${r.code}: ${r.stderr.trim()}`);
			let parsed: unknown;
			try {
				parsed = JSON.parse(r.stdout);
			} catch (e) {
				fail(step, `stdout not JSON: ${(e as Error).message}`);
			}
			if (!Array.isArray(parsed)) fail(step, "expected JSON array");
		}

		// Step 6: single faux run with JSON receipt
		{
			const step = "step6:run-json";
			checkBudget(step);
			const r = await runCli(["run", "scout", "hello", "--faux", "--json"], env);
			if (r.code !== 0) fail(step, `exit ${r.code}: ${r.stderr.trim()}`);
			const receipt = extractLastJsonObject(r.stdout) as { exitCode?: number; runId?: string } | null;
			if (!receipt) fail(step, "no trailing JSON receipt in stdout");
			if (receipt.exitCode !== 0) fail(step, `receipt.exitCode=${receipt.exitCode}`);
			if (typeof receipt.runId !== "string" || receipt.runId.length === 0) {
				fail(step, "receipt missing runId");
			}
		}

		// Step 7: three concurrent faux runs, all resolved and all in ledger
		{
			const step = "step7:stress-3";
			checkBudget(step);
			const results = await Promise.all(
				[0, 1, 2].map((i) => runCli(["run", "scout", "hello", "--faux"], env).then((r) => ({ i, r }))),
			);
			for (const { i, r } of results) {
				if (r.code !== 0) fail(`${step}[${i}]`, `exit ${r.code}: ${r.stderr.slice(0, 200).trim()}`);
				if (!r.stdout.includes("receipt:")) fail(`${step}[${i}]`, "no 'receipt:' line in stdout");
			}
			const ledgerPath = join(home, "data", "state", "runs.json");
			if (!existsSync(ledgerPath)) fail(step, `ledger missing: ${ledgerPath}`);
			const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Array<{ id: string }>;
			const ledgerIds = new Set(ledger.map((r) => r.id));
			for (const { i, r } of results) {
				const runId = extractReceiptRunId(r.stdout);
				if (!runId) fail(`${step}[${i}]`, "could not parse runId from receipt line");
				if (!ledgerIds.has(runId)) fail(`${step}[${i}]`, `runId=${runId} missing from ledger`);
			}
		}

		// Step 8: audit file exists with at least one classified action.
		{
			const step = "step8:audit";
			checkBudget(step);
			await triggerOneAuditRecord(home);
			const today = localDateString(new Date());
			const auditPath = join(home, "data", "audit", `${today}.jsonl`);
			if (!existsSync(auditPath)) fail(step, `missing ${auditPath}`);
			const content = readFileSync(auditPath, "utf8").trim();
			if (content.length === 0) fail(step, `audit file empty: ${auditPath}`);
			const firstLine = content.split("\n", 1)[0] ?? "";
			let record: { actionClass?: unknown; decision?: unknown } = {};
			try {
				record = JSON.parse(firstLine) as typeof record;
			} catch (e) {
				fail(step, `first audit line not JSON: ${(e as Error).message}`);
			}
			if (typeof record.actionClass !== "string" || record.actionClass.length === 0) {
				fail(step, "audit record missing actionClass");
			}
			if (typeof record.decision !== "string" || record.decision.length === 0) {
				fail(step, "audit record missing decision");
			}
		}

		const secs = (elapsed() / 1000).toFixed(2);
		process.stdout.write(`[smoke] PASS (${secs}s)\n`);
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

main().catch((err) => {
	process.stderr.write(`[smoke] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
