#!/usr/bin/env node
/**
 * Bounded reconnaissance live eval (opt-in): the two scenarios that genuinely
 * need a real model, per the recon-evidence sprint decisions.
 *
 * L1 stale-wiki: a workspace whose codewiki was indexed before the answer
 * changed. PASS iff the model performs a live source read after its
 * `code_nav mode=wiki` lookup (metric `wiki.staleAcknowledged`), i.e. it does
 * not answer from the stale wiki alone. The final answer text is stored in
 * the eval artifact for manual review.
 *
 * L2 Scout routing: the natural transcript request against a temp copy of
 * this repo. PASS iff the main model dispatches Scout specifically instead of
 * performing repo-wide reads itself.
 *
 * Bounds: repeats=1, per-task timeouts, and a matrix maxCostUsd ceiling that
 * fails remaining items closed once known receipt cost exceeds it. Never runs
 * in the default test lane: requires CLIO_LIVE_EVAL=1.
 *
 * Environment (same conventions as live-smoke.mjs):
 *   CLIO_LIVE_EVAL=1                   enable
 *   CLIO_LIVE_TARGET / CLIO_LIVE_RUNTIME / CLIO_LIVE_MODEL / CLIO_LIVE_BASE_URL
 *   CLIO_LIVE_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *   CLIO_LIVE_EVAL_MAX_COST_USD        matrix cost ceiling (default 0.50)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

if (process.env.CLIO_LIVE_EVAL !== "1") {
	console.log("CLIO_LIVE_EVAL is not set to '1'. Skipping bounded reconnaissance live eval.");
	process.exit(0);
}

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
if (!existsSync(CLI_ENTRY)) {
	console.error(`Error: built CLI entry not found at ${CLI_ENTRY}. Run npm run build first.`);
	process.exit(1);
}

const targetId = process.env.CLIO_LIVE_TARGET || "live-target";
const runtimeId = process.env.CLIO_LIVE_RUNTIME || (process.env.CLIO_LIVE_BASE_URL ? "openai-compat" : "openai");
const model = process.env.CLIO_LIVE_MODEL || (runtimeId === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o-mini");
const url = process.env.CLIO_LIVE_BASE_URL || undefined;
const maxCostUsd = Number.parseFloat(process.env.CLIO_LIVE_EVAL_MAX_COST_USD || "0.50");

let envVarName = "CLIO_LIVE_API_KEY";
let apiKey = process.env.CLIO_LIVE_API_KEY || "";
if (!apiKey) {
	if (runtimeId === "openai" && process.env.OPENAI_API_KEY) {
		envVarName = "OPENAI_API_KEY";
		apiKey = process.env.OPENAI_API_KEY;
	} else if (runtimeId === "anthropic" && process.env.ANTHROPIC_API_KEY) {
		envVarName = "ANTHROPIC_API_KEY";
		apiKey = process.env.ANTHROPIC_API_KEY;
	}
}
const keylessRuntimes = new Set(["openai-compat", "llamacpp", "ollama", "lmstudio"]);
if (!apiKey && !keylessRuntimes.has(runtimeId)) {
	console.error(
		"Error: CLIO_LIVE_EVAL=1 is active, but no API key was found in CLIO_LIVE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
	);
	process.exit(1);
}

// Sandbox home so the live eval never touches the operator's real state.
const scratchDir = mkdtempSync(join(tmpdir(), "clio-live-eval-"));
const clioDataDir = join(scratchDir, "data");
const clioConfigDir = join(scratchDir, "config");
const clioStateDir = join(scratchDir, "state");
const clioCacheDir = join(scratchDir, "cache");
for (const dir of [clioDataDir, clioConfigDir, clioStateDir, clioCacheDir]) {
	mkdirSync(dir, { recursive: true });
}

const settings = {
	version: 1,
	identity: "clio",
	autonomy: "full-auto",
	targets: [
		{
			id: targetId,
			runtime: runtimeId,
			defaultModel: model,
			wireModels: [model],
			...(url ? { url } : {}),
			...(apiKey ? { auth: { apiKeyEnvVar: envVarName } } : {}),
		},
	],
	orchestrator: { target: targetId, model, thinkingLevel: "off" },
	workers: { default: { target: targetId, model, thinkingLevel: "off" }, profiles: {} },
};
writeFileSync(join(clioConfigDir, "settings.yaml"), stringify(settings), "utf8");

const childEnv = {
	...process.env,
	CLIO_HOME: scratchDir,
	CLIO_DATA_DIR: clioDataDir,
	CLIO_CONFIG_DIR: clioConfigDir,
	CLIO_STATE_DIR: clioStateDir,
	CLIO_CACHE_DIR: clioCacheDir,
	CLIO_REQUIRE_HOME_PREFIX: "1",
};
if (apiKey) childEnv[envVarName] = apiKey;

/**
 * Seed the L1 workspace: index the codewiki at the OLD answer, then change
 * the source and commit, so the wiki's gitHead no longer matches HEAD and
 * its content asserts a stale fact.
 */
function seedStaleWikiWorkspace() {
	const dir = mkdtempSync(join(tmpdir(), "clio-live-eval-stale-wiki-"));
	const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git(["init", "--quiet"]);
	git(["config", "user.email", "eval@clio.local"]);
	git(["config", "user.name", "Clio Live Eval"]);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "src", "answer.js"),
		'/** Source of truth for the live stale-wiki scenario. */\nexport function currentAnswer() {\n\treturn "OLD-ANSWER";\n}\n',
	);
	writeFileSync(join(dir, "README.md"), "# stale-wiki fixture\n\nsrc/answer.js holds currentAnswer().\n");
	git(["add", "-A"]);
	git(["commit", "--quiet", "-m", "seed: old answer"]);
	// Index the codewiki at the OLD state (offline, no model).
	execFileSync(process.execPath, [CLI_ENTRY, "context", "refresh"], { cwd: dir, env: childEnv, stdio: "pipe" });
	// Move the truth past the wiki.
	writeFileSync(
		join(dir, "src", "answer.js"),
		'/** Source of truth for the live stale-wiki scenario. */\nexport function currentAnswer() {\n\treturn "NEW-ANSWER";\n}\n',
	);
	git(["add", "-A"]);
	git(["commit", "--quiet", "-m", "change: new answer after wiki indexing"]);
	return dir;
}

console.log("Seeding stale-wiki workspace (offline codewiki index at the old answer)...");
const staleWikiDir = seedStaleWikiWorkspace();

const suite = {
	version: 2,
	suite: {
		id: "recon-live",
		title: "Bounded reconnaissance live suite",
		visibility: "local",
		description: "L1 stale-wiki grounding and L2 proactive Scout routing; env-gated, cost-bounded.",
	},
	matrix: { targets: [{ id: targetId, model }], repeats: 1, maxCostUsd },
	tasks: [
		{
			id: "stale-wiki",
			tags: ["live", "recon"],
			workspace: { kind: "local", path: staleWikiDir },
			runner: {
				kind: "clio-run",
				prompt:
					"Orient with code_nav mode=wiki first, then answer: what exact string does currentAnswer() in src/answer.js return?",
			},
			verify: {
				assertions: [{ metric: "wiki.staleAcknowledged", op: "eq", value: true }],
			},
			metrics: { collect: ["wiki.staleAcknowledged", "tools.totalCalls", "tokens.total", "cost.usd"] },
			timeoutMs: 120000,
		},
		{
			id: "scout-routing",
			tags: ["live", "recon"],
			workspace: {
				kind: "temp-copy",
				path: REPO_ROOT,
				excludes: ["node_modules", "dist", ".git", ".clio", ".superpowers", "coverage"],
			},
			runner: {
				kind: "clio-run",
				prompt:
					"Let's just explore this repo and context. Give me a concise orientation to its structure and key entry points.",
			},
			verify: {
				assertions: [
					{ metric: "dispatch.count", op: "gte", value: 1 },
					{ metric: "dispatch.scoutCount", op: "gte", value: 1 },
				],
			},
			metrics: {
				collect: ["dispatch.count", "dispatch.scoutCount", "tools.totalCalls", "tokens.total", "cost.usd"],
			},
			timeoutMs: 180000,
		},
	],
};

const suitePath = join(scratchDir, "recon-live-suite.yaml");
writeFileSync(suitePath, stringify(suite), "utf8");

function runCli(args, timeoutMs) {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [CLI_ENTRY, ...args], { env: childEnv, cwd: REPO_ROOT });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr });
		});
	});
}

const startedAt = Date.now();
console.log(
	`Running bounded reconnaissance live suite (target=${targetId}, model=${model}, maxCostUsd=$${maxCostUsd})...`,
);
const run = await runCli(["eval", "run", "--suite", suitePath], 420_000);
const durationMs = Date.now() - startedAt;
process.stdout.write(run.stdout);
if (run.stderr.trim().length > 0) process.stderr.write(run.stderr);

const evalIdMatch = /eval: (eval-[^\s]+)/.exec(run.stdout);
if (evalIdMatch) {
	const report = await runCli(["eval", "report", evalIdMatch[1], "--format", "json"], 60_000);
	try {
		const artifact = JSON.parse(report.stdout);
		let totalCost = 0;
		for (const result of artifact.results ?? []) {
			const cost = typeof result.metrics?.["cost.usd"] === "number" ? result.metrics["cost.usd"] : 0;
			totalCost += cost;
			console.log(
				`[recon-live] ${result.taskId}: pass=${result.pass} failureClass=${result.failureClass ?? "none"} ` +
					`staleAcknowledged=${String(result.metrics?.["wiki.staleAcknowledged"] ?? "n/a")} ` +
					`dispatchCount=${String(result.metrics?.["dispatch.count"] ?? "n/a")} ` +
					`scoutDispatchCount=${String(result.metrics?.["dispatch.scoutCount"] ?? "n/a")} costUsd=${cost}`,
			);
		}
		console.log(
			`[recon-live] duration=${(durationMs / 1000).toFixed(1)}s totalKnownCostUsd=$${totalCost.toFixed(4)} ` +
				`ceiling=$${maxCostUsd} artifact=${join(clioDataDir, "evals", `${evalIdMatch[1]}.json`)}`,
		);
	} catch {
		console.error("[recon-live] could not parse the JSON report; see raw output above.");
	}
}

rmSync(staleWikiDir, { recursive: true, force: true });
// Keep scratchDir when the run failed so the artifact and ledgers are inspectable.
if (run.code === 0) rmSync(scratchDir, { recursive: true, force: true });
else console.error(`[recon-live] failed (exit ${run.code}); artifacts kept under ${scratchDir}`);
process.exit(run.code ?? 1);
