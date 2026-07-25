#!/usr/bin/env node
/**
 * Dispatch routing P0 live verification (opt-in).
 *
 * The plan-admission P0s have deterministic contract tests, but those drive the
 * dispatch contract directly. This script drives the built CLI end to end
 * against a real model and a real SSH fleet node, so the whole chain is proven:
 * model-authored tool call -> plan resolution -> reservation -> admission ->
 * worker spawn -> receipt.
 *
 * Four scenarios, each with its own control:
 *
 *   1. quality  A pinned local Verifier records one typed `verify` result as a
 *                measured pass; a read-only Scout remains unmeasured and cold.
 *   2. capacity   Two parallel tasks pinned to a capacity-one node are denied
 *                 as one unit with one aggregate message naming the total. The
 *                 same two tasks, submitted as an explicit sequence, both run.
 *   3. budget     A plan whose aggregate conservative estimate crosses the cost
 *                 ceiling is denied at plan time, before any worker spawns. One
 *                 task of the same shape, under the same ceiling, is admitted.
 *   4. failover   A plan-approved two-step pipeline whose step-1 target answers
 *                 503 fails over to an approved candidate, and step 2 receives
 *                 the successful attempt's output, not the failed attempt's.
 *
 * Never runs in an ordinary test or CI lane: CLIO_LIVE_EVAL=1 is required.
 * Build first, then invoke with:
 *
 *   CLIO_LIVE_EVAL=1 npm run test:live-verify:dispatch-routing
 *
 * Requirements beyond the model target:
 *   - Passwordless SSH (BatchMode) to CLIO_LIVE_FLEET_HOST (default localhost).
 *     Scenario 1 needs a real per-node capacity cap, and only an SSH node has
 *     one; the implicit local node is bounded by the global gate instead.
 *   - A free TCP port for the always-503 target used by scenario 3.
 *
 * Environment:
 *   CLIO_LIVE_TARGET / CLIO_LIVE_RUNTIME / CLIO_LIVE_MODEL / CLIO_LIVE_BASE_URL
 *   CLIO_LIVE_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *   CLIO_LIVE_FLEET_HOST        SSH host for the capacity-one node (default localhost)
 *   CLIO_LIVE_DEAD_PORT         port for the always-503 target (default 8599)
 *   CLIO_LIVE_VERIFY_TIMEOUT_MS per-turn timeout (default 900000)
 *   CLIO_LIVE_VERIFY_SCENARIOS  comma list: quality,capacity,budget,failover (default all)
 *   CLIO_LIVE_KEEP=1            retain the isolated scratch tree on success
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

if (process.env.CLIO_LIVE_EVAL !== "1") {
	console.log("CLIO_LIVE_EVAL is not set to '1'. Skipping the dispatch routing live verification.");
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
const fleetHost = process.env.CLIO_LIVE_FLEET_HOST || "localhost";
const deadPort = Number.parseInt(process.env.CLIO_LIVE_DEAD_PORT || "8599", 10);
const timeoutMs = Number.parseInt(process.env.CLIO_LIVE_VERIFY_TIMEOUT_MS || "900000", 10);
const ALL_SCENARIOS = ["quality", "capacity", "budget", "failover"];
const scenarios = (process.env.CLIO_LIVE_VERIFY_SCENARIOS || ALL_SCENARIOS.join(","))
	.split(",")
	.map((name) => name.trim())
	.filter((name) => name.length > 0);
for (const name of scenarios) {
	if (!ALL_SCENARIOS.includes(name)) {
		console.error(`Error: CLIO_LIVE_VERIFY_SCENARIOS entry '${name}' is not one of ${ALL_SCENARIOS.join(", ")}.`);
		process.exit(1);
	}
}
if (!Number.isSafeInteger(deadPort) || deadPort < 1024 || deadPort > 65535) {
	console.error("Error: CLIO_LIVE_DEAD_PORT must be a port between 1024 and 65535.");
	process.exit(1);
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000) {
	console.error("Error: CLIO_LIVE_VERIFY_TIMEOUT_MS must be an integer of at least 60000.");
	process.exit(1);
}

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
if (scenarios.includes("quality") && !keylessRuntimes.has(runtimeId)) {
	console.error(
		"Error: the quality scenario requires a free local runtime (llamacpp, ollama, lmstudio, or openai-compat).",
	);
	process.exit(1);
}
if (!apiKey && !keylessRuntimes.has(runtimeId)) {
	console.error(
		"Error: CLIO_LIVE_EVAL=1 is active, but no API key was found in CLIO_LIVE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
	);
	process.exit(1);
}

const scratchDir = mkdtempSync(join(tmpdir(), "clio-live-dispatch-routing-"));
const clioDataDir = join(scratchDir, "data");
const clioConfigDir = join(scratchDir, "config");
const clioStateDir = join(scratchDir, "state");
const clioCacheDir = join(scratchDir, "cache");
const workspaceDir = join(scratchDir, "workspace");
for (const dir of [clioDataDir, clioConfigDir, clioStateDir, clioCacheDir, workspaceDir]) {
	mkdirSync(dir, { recursive: true });
}

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
 * The remote worker entry. The SSH transport exports a fixed env whitelist and
 * nothing of the orchestrator's process.env, so the scratch isolation has to
 * ride on the entry command itself or the remote worker would write into the
 * operator's real Clio home. `process.execPath` is absolute because a
 * non-interactive SSH login usually has no version-managed node on PATH.
 */
const remoteEntry =
	`env CLIO_HOME=${scratchDir} CLIO_DATA_DIR=${clioDataDir} CLIO_CONFIG_DIR=${clioConfigDir} ` +
	`CLIO_STATE_DIR=${clioStateDir} CLIO_CACHE_DIR=${clioCacheDir} CLIO_REQUIRE_HOME_PREFIX=1 ` +
	`${process.execPath} ${CLI_ENTRY} worker`;

const liveTarget = {
	id: targetId,
	runtime: runtimeId,
	defaultModel: model,
	wireModels: [model],
	...(url ? { url } : {}),
	...(apiKey ? { auth: { apiKeyEnvVar: envVarName } } : {}),
};

function baseSettings() {
	return {
		version: 1,
		identity: "clio",
		// Plan-scale dispatch needs either an authenticated operator approval or
		// full-auto. Headless has no operator, so the plan is auto-approved and the
		// read-only scout recipe plus the throwaway workspace bound the blast radius.
		autonomy: "full-auto",
		targets: [structuredClone(liveTarget)],
		orchestrator: { target: targetId, model, thinkingLevel: "off" },
		workers: { default: { target: targetId, model, thinkingLevel: "off" }, profiles: {} },
	};
}

function writeSettings(settings) {
	writeFileSync(join(clioConfigDir, "settings.yaml"), stringify(settings), "utf8");
}

function git(args) {
	return execFileSync("git", args, { cwd: workspaceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

writeFileSync(join(workspaceDir, "README.md"), "live dispatch routing verification workspace\n", "utf8");
writeFileSync(
	join(workspaceDir, "package.json"),
	`${JSON.stringify({ private: true, scripts: { typecheck: "node --check src/alpha.ts" } }, null, 2)}\n`,
	"utf8",
);
mkdirSync(join(workspaceDir, "src"), { recursive: true });
mkdirSync(join(workspaceDir, "tests"), { recursive: true });
writeFileSync(join(workspaceDir, "src", "alpha.ts"), "export const alpha = 1;\n", "utf8");
writeFileSync(join(workspaceDir, "tests", "beta.test.ts"), "export const beta = 2;\n", "utf8");
git(["init", "--quiet"]);
git(["config", "user.email", "verify@clio.local"]);
git(["config", "user.name", "Clio Dispatch Routing Verification"]);
git(["add", "-A"]);
git(["commit", "--quiet", "-m", "verify: dispatch routing baseline"]);

const PREAMBLE =
	"You are the orchestrator in a Clio dispatch regression check. Each turn exercises one admission or " +
	"failover path so the harness can assert on the tool result. The tasks are deliberately tiny: the " +
	"regression is in the dispatch plumbing, not in the work. Author exactly the dispatch call described " +
	"below, report its result verbatim, and stop. Include only the fields the instruction spells out: never " +
	"invent a target, model, or node from the surrounding prose, and never send both task and tasks in one " +
	"call. Do not retry and do not substitute a different call.\n\n";

function runCli(args, phase) {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
			cwd: workspaceDir,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			writeFileSync(join(scratchDir, `${phase}.jsonl`), redact(result.stdout), "utf8");
			writeFileSync(join(scratchDir, `${phase}.stderr.log`), redact(result.stderr), "utf8");
			resolvePromise(result);
		};
		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, error }));
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			finish({ code, signal, stdout, stderr, timedOut, error: null });
		});
	});
}

function redact(text) {
	return apiKey.length > 0 ? text.split(apiKey).join("[REDACTED]") : text;
}

function turn(prompt, phase) {
	return runCli(["run", "--json", "--no-skills", "--autonomy", "full-auto", `${PREAMBLE}${prompt}`], phase);
}

function parseJsonLines(text) {
	const events = [];
	for (const line of text.split(/\r?\n/u)) {
		if (line.trim().length === 0) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object" && !Array.isArray(value)) events.push(value);
		} catch {
			// A main-agent JSONL stream may carry non-JSONL trailer lines; the raw
			// artifact keeps them and the assertions below only need the events.
		}
	}
	return events;
}

/** Every dispatch tool call in the turn, paired with its result text. */
function dispatchCalls(events) {
	const results = new Map();
	for (const event of events) {
		if (event.type !== "tool_execution_end" || typeof event.toolCallId !== "string") continue;
		const blocks = Array.isArray(event.result?.content) ? event.result.content : [];
		results.set(event.toolCallId, {
			text: blocks
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join(""),
			details: event.result?.details ?? {},
			isError: event.isError === true || event.result?.kind === "error",
		});
	}
	return events
		.filter(
			(event) =>
				event.type === "tool_execution_start" && event.toolName === "dispatch" && typeof event.toolCallId === "string",
		)
		.map((event) => ({ args: event.args ?? {}, result: results.get(event.toolCallId) ?? null }));
}

function taskCount(args) {
	return Array.isArray(args.tasks) ? args.tasks.length : args.task !== undefined ? 1 : 0;
}

function receipts() {
	const dir = join(clioStateDir, "receipts");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

function workerReceipts() {
	return receipts().filter((receipt) => receipt.agentId !== "main-agent");
}

function clearState() {
	rmSync(clioStateDir, { recursive: true, force: true });
	mkdirSync(clioStateDir, { recursive: true });
}

const failures = [];
let currentScenario = "";
function check(condition, message) {
	if (!condition) failures.push(`[${currentScenario}] ${message}`);
}

function describeCalls(calls) {
	return calls.map((call) => `${JSON.stringify(call.args)} -> ${call.result?.text ?? "<no result>"}`).join(" | ");
}

/**
 * Assert the model actually authored the call the scenario needs before judging
 * Clio. A model that fumbles a call and then authors it correctly has still
 * exercised the path, so an accepted call outranks a rejected one.
 */
function requireCall(calls, predicate, description) {
	const matching = calls.filter((entry) => predicate(entry.args));
	const call = matching.find((entry) => entry.result?.isError !== true) ?? matching[0];
	if (!call) {
		failures.push(
			`[${currentScenario}] the model never authored ${description}; observed: ${describeCalls(calls) || "no dispatch calls"}`,
		);
		return null;
	}
	return call;
}

async function scenarioQuality() {
	currentScenario = "quality";
	clearState();
	const settings = baseSettings();
	// Pin both agent runs to the one isolated local route. The scenario never
	// consults operator settings and rejects a paid runtime before this point.
	settings.workers.default = { target: targetId, model, thinkingLevel: "off" };
	writeSettings(settings);
	const verifier = await runCli(
		[
			"run",
			"--agent",
			"verifier",
			"--target",
			targetId,
			"--model",
			model,
			"--autonomy",
			"full-auto",
			"Use the verify tool to run the declared typecheck in the scratch project. Report the result and stop.",
		],
		"quality-verifier",
	);
	check(!verifier.timedOut && verifier.code === 0, `typed verifier run failed: ${verifier.stderr}`);
	const verifierReceipt = workerReceipts().find((receipt) => receipt.agentId === "verifier");
	check(Boolean(verifierReceipt), "no Verifier receipt was written");
	if (verifierReceipt) {
		check(
			verifierReceipt.quality?.typedValidations?.some((fact) => fact.sourceId === "tool:verify" && fact.passed === true),
			`Verifier receipt did not seal a typed passing validation: ${JSON.stringify(verifierReceipt.quality)}`,
		);
	}

	// Scout is intentionally a shadow agent, so use the production internal
	// bootstrap path rather than weakening user-origin admission for this check.
	const scout = await runCli(
		["context", "init", "--yes", "--target", targetId, "--model", model, "--thinking", "off"],
		"quality-scout",
	);
	check(!scout.timedOut && scout.code === 0, `read-only Scout run failed: ${scout.stderr}`);
	const scoutReceipt = workerReceipts().find((receipt) => receipt.agentId === "scout");
	check(Boolean(scoutReceipt), "no Scout receipt was written");
	if (scoutReceipt) {
		check(
			scoutReceipt.verification?.state === "not_applicable" && scoutReceipt.quality?.typedValidations?.length === 0,
			`read-only Scout must remain unmeasured: ${JSON.stringify(scoutReceipt.quality)}`,
		);
	}
	const labeled = workerReceipts().filter((receipt) => receipt.quality?.typedValidations?.length > 0).length;
	check(labeled < 6, `cold isolated history unexpectedly meets active readiness (${labeled} labeled outcomes)`);
}

async function scenarioCapacity() {
	currentScenario = "capacity";
	clearState();
	const settings = baseSettings();
	// Global concurrency stays wide so the denial can only come from the node's
	// own cap, and the node cap is the thing the plan has to reserve against.
	settings.budget = { concurrency: 4 };
	settings.fleet = { nodes: [{ id: "solo", host: fleetHost, maxWorkers: 1, clioEntry: remoteEntry }] };
	// The node pin lives in settings, not in the prompt. What is under test is
	// Clio's plan admission, so the harness must not depend on a model reliably
	// repeating a `node` field; a dropped pin would silently run the scenario on
	// the wrong node and report a Clio regression that did not happen.
	const soloProfile = { target: targetId, model, thinkingLevel: "off", node: "solo" };
	settings.workers.profiles = { solo: soloProfile };
	settings.workers.agentBindings = Object.fromEntries(
		["coder", "scout", "debugger", "verifier", "researcher", "architect", "tester", "documenter"].map((agent) => [
			agent,
			"solo",
		]),
	);
	writeSettings(settings);

	const doctor = await runCli(["doctor"], "capacity-doctor");
	const eligible = /fleet node solo\s+eligible/.test(doctor.stdout);
	check(
		eligible,
		`fleet node 'solo' did not pass the doctor preflight over ${fleetHost}; the scenario needs passwordless SSH. doctor said: ${
			doctor.stdout.split("\n").find((line) => line.includes("solo")) ?? "<no line>"
		}`,
	);
	if (!eligible) return;

	const parallel = await turn(
		'Check that two tasks the fleet cannot hold at once are denied as one unit. Use mode "parallel" and a ' +
			'tasks array with exactly two entries, each {"agent":"scout","task":"..."}: the first task "Name one file ' +
			'under src/ and stop.", the second task "Name one file under tests/ and stop.".',
		"capacity-parallel",
	);
	check(!parallel.timedOut, `parallel turn exceeded ${timeoutMs}ms`);
	const parallelCalls = dispatchCalls(parseJsonLines(parallel.stdout));
	const parallelCall = requireCall(
		parallelCalls,
		(args) => args.mode === "parallel" && taskCount(args) === 2,
		"a two-task parallel dispatch",
	);
	if (parallelCall) {
		const text = parallelCall.result?.text ?? "";
		check(
			/reservation denied: node 'solo' capacity exceeded \(2\/1\)/.test(text),
			`parallel plan was not denied as a unit naming the total; result was: ${text}`,
		);
		check(text.split("reservation denied").length === 2, `denial was not one aggregate message; result was: ${text}`);
	}
	check(
		workerReceipts().length === 0,
		`a worker ran despite the plan denial: ${workerReceipts().map((receipt) => receipt.runId)}`,
	);

	const sequential = await turn(
		'Check that the same two tasks run when submitted as an explicit sequence. Use mode "sequential" and a ' +
			'tasks array with exactly two entries, each {"agent":"scout","task":"..."}: the first task "Name one file ' +
			'under src/ and stop.", the second task "Name one file under tests/ and stop.".',
		"capacity-sequential",
	);
	check(!sequential.timedOut, `sequential turn exceeded ${timeoutMs}ms`);
	const sequentialCalls = dispatchCalls(parseJsonLines(sequential.stdout));
	const sequentialCall = requireCall(
		sequentialCalls,
		(args) => args.mode === "sequential" && taskCount(args) === 2,
		"a two-task sequential dispatch",
	);
	if (sequentialCall) {
		check(
			sequentialCall.result?.isError !== true,
			`the same two tasks were refused as a sequence: ${sequentialCall.result?.text}`,
		);
		check(
			sequentialCall.result?.details?.failedCount === 0 && sequentialCall.result?.details?.receiptCount === 2,
			`sequential run did not complete both tasks: ${JSON.stringify(sequentialCall.result?.details)}`,
		);
	}
	const remote = workerReceipts();
	check(remote.length === 2, `expected two worker receipts from the sequence, saw ${remote.length}`);
	for (const receipt of remote) {
		check(receipt.outcome === "succeeded", `sequenced run ${receipt.runId} ended ${receipt.outcome}`);
		check(receipt.node?.id === "solo", `sequenced run ${receipt.runId} ran on node ${receipt.node?.id}`);
	}
}

async function scenarioBudget() {
	currentScenario = "budget";
	clearState();
	// Rates chosen so one task's conservative admission estimate sits under the
	// ceiling and two cross it: only the aggregate can deny the plan.
	const settings = baseSettings();
	settings.targets[0].pricing = { input: 10, output: 30 };
	settings.budget = { concurrency: 4, sessionCeilingUsd: 1.5 };
	writeSettings(settings);

	const pair = await turn(
		"Check that a plan whose aggregate cost estimate crosses the ceiling is denied at plan time. Use mode " +
			'"parallel" and a tasks array with exactly two entries, each {"agent":"scout","task":"..."}: the first ' +
			'task "Name one file under src/ and stop.", the second task "Name one file under tests/ and stop.".',
		"budget-pair",
	);
	check(!pair.timedOut, `two-task turn exceeded ${timeoutMs}ms`);
	const pairCall = requireCall(
		dispatchCalls(parseJsonLines(pair.stdout)),
		(args) => args.mode === "parallel" && taskCount(args) === 2,
		"a two-task parallel dispatch",
	);
	if (pairCall) {
		const text = pairCall.result?.text ?? "";
		check(
			/reservation denied: aggregate budget exceeded \(\$2\.0480 \/ \$1\.5000; batch upper bound \$2\.0480\)/.test(text),
			`plan was not denied on the aggregate conservative estimate; result was: ${text}`,
		);
	}
	check(
		workerReceipts().length === 0,
		`a worker spawned before the budget denial: ${workerReceipts().map((receipt) => receipt.runId)}`,
	);
	check(
		!existsSync(join(clioStateDir, "runs.json")) ||
			JSON.parse(readFileSync(join(clioStateDir, "runs.json"), "utf8")).every((row) => row.agentId === "main-agent"),
		"the denied plan left a worker run row in the ledger",
	);

	const single = await turn(
		"Check the control for the previous case: one task of the same shape under the same ceiling is admitted. " +
			'Use the singular form {"agent":"scout","task":"Name one file under src/ and stop."}.',
		"budget-single",
	);
	check(!single.timedOut, `single-task turn exceeded ${timeoutMs}ms`);
	const singleCall = requireCall(
		dispatchCalls(parseJsonLines(single.stdout)),
		(args) => taskCount(args) === 1,
		"a one-task dispatch",
	);
	if (singleCall) {
		check(
			singleCall.result?.isError !== true,
			`one task of the same shape was denied under the same ceiling: ${singleCall.result?.text}`,
		);
		check(
			singleCall.result?.details?.failedCount === 0,
			`the control task did not run: ${JSON.stringify(singleCall.result?.details)}`,
		);
	}
}

function startDeadTarget() {
	const server = createServer((_req, res) => {
		res.writeHead(503, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Service Unavailable", type: "server_error", code: 503 } }));
	});
	return new Promise((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(deadPort, "127.0.0.1", () => resolvePromise(server));
	});
}

async function scenarioFailover() {
	currentScenario = "failover";
	clearState();
	const settings = baseSettings();
	// The dead target is the worker default, so every step resolves to it first
	// and the live target is the approved alternate the envelope must reach.
	settings.targets = [
		{
			id: "dead-target",
			runtime: runtimeId,
			url: `http://127.0.0.1:${deadPort}`,
			defaultModel: model,
			wireModels: [model],
		},
		structuredClone(liveTarget),
	];
	settings.workers.default = { target: "dead-target", model, thinkingLevel: "off" };
	settings.budget = { concurrency: 4 };
	writeSettings(settings);

	const server = await startDeadTarget();
	try {
		const run = await turn(
			"Check that a pipeline step hands its output to the next step. The token below is the tracer that " +
				"proves which attempt step 2 consumed, so pass the tasks through exactly as written. Use mode " +
				'"pipeline" and a tasks array with exactly two entries, each ' +
				'{"agent":"scout","task":"..."}: the first task "Reply with exactly the token STEP1_TOKEN_OK and ' +
				'nothing else.", the second task "Repeat verbatim the input data you were given, then stop.".',
			"failover-pipeline",
		);
		check(!run.timedOut, `pipeline turn exceeded ${timeoutMs}ms`);
		const call = requireCall(
			dispatchCalls(parseJsonLines(run.stdout)),
			(args) => args.mode === "pipeline" && taskCount(args) === 2 && args.task === undefined,
			"a two-step pipeline dispatch",
		);
		if (!call) return;
		check(call.result?.isError !== true, `pipeline did not complete: ${call.result?.text}`);
		check(
			call.result?.details?.failedCount === 0 && call.result?.details?.receiptCount === 2,
			`pipeline did not report two successful steps: ${JSON.stringify(call.result?.details)}`,
		);
		// The receipt assertions below describe one accepted pipeline. A rejected
		// call leaves a ledger that says nothing about failover, so reporting on it
		// would blame Clio for the model's malformed call.
		if (call.result?.isError === true) return;

		// Scope every assertion to the accepted pipeline's own assignments. A model
		// that authors an extra dispatch beyond the one asked for would otherwise
		// show up as a Clio defect in a ledger-wide count. The reported ids are the
		// terminal attempt of each step, so the scope is their assignment roots and
		// everything else that shares those roots.
		const all = workerReceipts();
		const reported = new Set(Array.isArray(call.result?.details?.runIds) ? call.result.details.runIds : []);
		const assignments = new Set(
			all.filter((receipt) => reported.has(receipt.runId)).map((receipt) => receipt.lineage?.rootRunId),
		);
		check(assignments.size === 2, `pipeline did not report two assignments: ${[...assignments]}`);
		const workers = all.filter((receipt) => assignments.has(receipt.lineage?.rootRunId));
		const failed = workers.filter((receipt) => receipt.targetId === "dead-target");
		const succeeded = workers.filter((receipt) => receipt.targetId === targetId && receipt.outcome === "succeeded");
		check(failed.length >= 1, "no attempt ever hit the 503 target");
		for (const receipt of failed) {
			check(receipt.outcome === "failed", `503 attempt ${receipt.runId} ended ${receipt.outcome}`);
		}
		check(succeeded.length === 2, `expected two successful attempts on '${targetId}', saw ${succeeded.length}`);

		const step1Root = failed[0]?.lineage?.rootRunId;
		const step1Winner = workers.find(
			(receipt) => receipt.lineage?.rootRunId === step1Root && receipt.outcome === "succeeded",
		);
		check(Boolean(step1Winner), "the failed step-1 attempt never produced a successful sibling in its assignment");
		const step2 = workers.find((receipt) => receipt.pipeline !== null && receipt.pipeline !== undefined);
		check(Boolean(step2), "no receipt carried pipeline provenance");
		if (step1Winner && step2) {
			check(
				step2.pipeline.fromRunId === step1Winner.runId,
				`step 2 consumed run ${step2.pipeline.fromRunId}; the successful step-1 attempt was ${step1Winner.runId}`,
			);
			check(step2.pipeline.fromRunId !== step1Root, `step 2 consumed the failed attempt ${step1Root}`);
			check(step2.targetId === targetId, `step 2 ran on ${step2.targetId} instead of the healthy target`);
		}
		const planHashes = new Set(workers.map((receipt) => receipt.plan?.hash));
		check(
			planHashes.size === 1 && !planHashes.has(undefined),
			`attempts did not share one approved plan hash: ${[...planHashes]}`,
		);
	} finally {
		await new Promise((resolvePromise) => server.close(resolvePromise));
	}
}

const runners = {
	quality: scenarioQuality,
	capacity: scenarioCapacity,
	budget: scenarioBudget,
	failover: scenarioFailover,
};

let passed = false;
try {
	console.log(
		`Running dispatch routing live verification (target=${targetId}, model=${model}, fleetHost=${fleetHost}, scenarios=${scenarios.join(",")})...`,
	);
	for (const name of scenarios) {
		console.log(`[dispatch-routing] scenario ${name}`);
		await runners[name]();
	}
	if (failures.length > 0) throw new Error(`dispatch routing live verification failed:\n- ${failures.join("\n- ")}`);
	passed = true;
	console.log(`[dispatch-routing] PASS scenarios=${scenarios.join(",")}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error(`[dispatch-routing] artifacts retained under ${scratchDir}`);
	process.exitCode = 1;
} finally {
	if (passed && process.env.CLIO_LIVE_KEEP !== "1") {
		rmSync(scratchDir, { recursive: true, force: true });
	} else if (passed) {
		console.log(`[dispatch-routing] CLIO_LIVE_KEEP=1; artifacts retained under ${scratchDir}`);
	}
}
