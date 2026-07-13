#!/usr/bin/env node
/**
 * Final fleet-dispatch live regression (opt-in, one read-only parent turn).
 *
 * This scenario exercises the model-authored lifecycle that deterministic
 * contracts cannot prove by themselves: Scout selection, bounded parent
 * spot-checks, singular detached dispatch with a real briefing, native
 * steering, monitoring, collection, and truthful terminal evidence labels.
 * It runs against a committed temporary copy and fails if that copy changes.
 *
 * Never runs in an ordinary test or CI lane: CLIO_LIVE_EVAL=1 is required.
 * Build first, then invoke with:
 *
 *   CLIO_LIVE_EVAL=1 npm run test:live-eval:fleet-dispatch
 *
 * Target conventions match the other live-eval scripts:
 *   CLIO_LIVE_TARGET / CLIO_LIVE_RUNTIME / CLIO_LIVE_MODEL / CLIO_LIVE_BASE_URL
 *   CLIO_LIVE_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *   CLIO_LIVE_THINKING             parent and worker thinking level (default medium)
 *   CLIO_LIVE_FLEET_TIMEOUT_MS     one-turn timeout (default 600000)
 *   CLIO_LIVE_KEEP=1               retain the isolated scratch tree on success
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { stringify } from "yaml";

if (process.env.CLIO_LIVE_EVAL !== "1") {
	console.log("CLIO_LIVE_EVAL is not set to '1'. Skipping the fleet-dispatch live regression.");
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
const thinkingLevel = process.env.CLIO_LIVE_THINKING || "medium";
const timeoutMs = Number.parseInt(process.env.CLIO_LIVE_FLEET_TIMEOUT_MS || "600000", 10);
const validThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
if (!validThinkingLevels.has(thinkingLevel)) {
	console.error(`Error: CLIO_LIVE_THINKING must be one of ${[...validThinkingLevels].join(", ")}.`);
	process.exit(1);
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000) {
	console.error("Error: CLIO_LIVE_FLEET_TIMEOUT_MS must be an integer of at least 30000.");
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
if (!apiKey && !keylessRuntimes.has(runtimeId)) {
	console.error(
		"Error: CLIO_LIVE_EVAL=1 is active, but no API key was found in CLIO_LIVE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
	);
	process.exit(1);
}

const BRIEFING_SENTINEL = "CLIO_FLEET_BRIEFING_SENTINEL_v6_20260713";
const STEERING_SENTINEL = "CLIO_FLEET_STEERING_SENTINEL_v6_20260713";
const SPECIALIST_TASK =
	"Read-only: verify the receipt v4/v5/v6 compatibility boundary and report two cited risks without quoting dynamic context or steering messages.";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const briefingBytes = Buffer.byteLength(BRIEFING_SENTINEL, "utf8");
const briefingHash = sha256(BRIEFING_SENTINEL);
const steeringBytes = Buffer.byteLength(STEERING_SENTINEL, "utf8");
const steeringHash = sha256(STEERING_SENTINEL);

const scratchDir = mkdtempSync(join(tmpdir(), "clio-live-fleet-dispatch-"));
const clioDataDir = join(scratchDir, "data");
const clioConfigDir = join(scratchDir, "config");
const clioStateDir = join(scratchDir, "state");
const clioCacheDir = join(scratchDir, "cache");
const workspaceDir = join(scratchDir, "workspace");
for (const dir of [clioDataDir, clioConfigDir, clioStateDir, clioCacheDir]) {
	mkdirSync(dir, { recursive: true });
}

const excludedRoots = new Set([".git", ".clio", ".superpowers", "coverage", "dist", "node_modules"]);
cpSync(REPO_ROOT, workspaceDir, {
	recursive: true,
	filter(source) {
		const path = relative(REPO_ROOT, source);
		if (path.length === 0) return true;
		const first = path.split(sep)[0];
		if (excludedRoots.has(first)) return false;
		// REPORT.md is pre-existing operator state, not part of this evaluation.
		return path !== "REPORT.md";
	},
});

function git(args) {
	return execFileSync("git", args, { cwd: workspaceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

git(["init", "--quiet"]);
git(["config", "user.email", "eval@clio.local"]);
git(["config", "user.name", "Clio Fleet Live Eval"]);
git(["add", "-A"]);
git(["commit", "--quiet", "-m", "eval: fleet-dispatch baseline"]);

/** Capture content, path, and symlink identity while deliberately excluding Git's own mutable database. */
function workspaceSnapshot() {
	const snapshot = new Map();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (dir === workspaceDir && entry.name === ".git") continue;
			const path = join(dir, entry.name);
			const key = relative(workspaceDir, path);
			if (entry.isDirectory()) {
				snapshot.set(`${key}/`, "directory");
				walk(path);
			} else if (entry.isSymbolicLink()) {
				snapshot.set(key, `symlink:${readlinkSync(path)}`);
			} else if (entry.isFile()) {
				snapshot.set(key, `file:${sha256(readFileSync(path))}`);
			} else {
				snapshot.set(key, "other");
			}
		}
	};
	walk(workspaceDir);
	return snapshot;
}

const beforeWorkspace = workspaceSnapshot();

const settings = {
	version: 1,
	identity: "clio",
	// Dispatch is itself denied at read-only autonomy. Auto-edit admits these
	// two singular local runs; read-only recipes plus the content snapshot below
	// enforce that this evaluation still cannot change the workspace.
	autonomy: "auto-edit",
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
	orchestrator: { target: targetId, model, thinkingLevel },
	workers: { default: { target: targetId, model, thinkingLevel }, profiles: {} },
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

const prompt = `Perform this bounded fleet-dispatch regression without modifying the workspace or creating a report file. The final report belongs only in your final assistant response.

1. Model-select and synchronously dispatch exactly one small Scout reconnaissance using the singular task form. Ask it for a concise index of the receipt-integrity and worker-steering implementation, with cited source locations.
2. Treat the successful Scout receipt as an index. Spot-check a risk-weighted subset of its citations with at least one and no more than six parent read/search calls.
3. Then launch exactly one detached read-only Debugger with the singular dispatch shape. Its task must be exactly:
${SPECIALIST_TASK}
Pass this distinct value through the real dispatch briefing field, not inside task:
${BRIEFING_SENTINEL}
4. Monitor the detached run. Send exactly one guide steer whose message is exactly ${STEERING_SENTINEL}. Then wait for it and collect its returned batch id before any synthesis.
5. Report the collected receipt evidence. Include distinct lines beginning receipt_integrity=, evidence_verification=, briefing=, and project_context=. Never call parent spot-checking independent specialist confirmation. Do not quote either sentinel in the final response.`;

function runCli(args, timeout) {
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
		}, timeout);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			finish({ code, signal, stdout, stderr, timedOut, error: null });
		});
	});
}

function redact(text) {
	return apiKey.length > 0 ? text.split(apiKey).join("[REDACTED]") : text;
}

function parseJsonLines(text) {
	const events = [];
	for (const [index, line] of text.split(/\r?\n/u).entries()) {
		if (line.trim().length === 0) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object" && !Array.isArray(value)) events.push({ index, event: value });
		} catch {
			// A main-agent JSONL stream may be followed by a pretty receipt on an
			// explicit agent path. This scenario uses the main path, so non-JSONL
			// lines are retained in the raw artifact and ignored here.
		}
	}
	return events;
}

function successfulToolCalls(events, toolName) {
	const ends = new Map();
	for (const row of events) {
		if (row.event.type === "tool_execution_end" && typeof row.event.toolCallId === "string") {
			ends.set(row.event.toolCallId, row);
		}
	}
	return events.flatMap((start) => {
		if (
			start.event.type !== "tool_execution_start" ||
			start.event.toolName !== toolName ||
			typeof start.event.toolCallId !== "string"
		) {
			return [];
		}
		const end = ends.get(start.event.toolCallId);
		const result = end?.event.result;
		const resultIsError = result && typeof result === "object" && result.kind === "error";
		return end && end.index > start.index && end.event.isError !== true && !resultIsError ? [{ ...start, end }] : [];
	});
}

function dispatchAgentIds(args) {
	if (!args || typeof args !== "object") return [];
	const topAgent = args.agent ?? args.agent_id ?? args.agentId;
	const ids = typeof topAgent === "string" ? [topAgent] : [];
	let tasks = args.tasks;
	if (typeof tasks === "string") {
		try {
			tasks = JSON.parse(tasks);
		} catch {
			tasks = [];
		}
	}
	if (Array.isArray(tasks)) {
		for (const task of tasks) {
			if (!task || typeof task !== "object") continue;
			const agent = task.agent ?? task.agent_id ?? task.agentId;
			if (typeof agent === "string") ids.push(agent);
		}
	}
	return ids;
}

function assistantText(events) {
	let latest = "";
	for (const row of events) {
		if (row.event.type !== "message_end" || row.event.message?.role !== "assistant") continue;
		const content = row.event.message.content;
		if (typeof content === "string") {
			latest = content;
			continue;
		}
		if (Array.isArray(content)) {
			latest = content
				.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("");
		}
	}
	return latest;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function receiptsFromState() {
	const dir = join(clioStateDir, "receipts");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readJson(join(dir, name)));
}

function snapshotDifferences(before, after) {
	const keys = new Set([...before.keys(), ...after.keys()]);
	return [...keys]
		.filter((key) => before.get(key) !== after.get(key))
		.sort()
		.map((key) => `${key}: ${before.has(key) ? "changed/removed" : "created"}`);
}

let passed = false;
try {
	console.log(
		`Running fleet-dispatch live regression (target=${targetId}, model=${model}, thinking=${thinkingLevel}, timeoutMs=${timeoutMs})...`,
	);
	const run = await runCli(
		[
			"run",
			"--json",
			"--target",
			targetId,
			"--model",
			model,
			"--thinking",
			thinkingLevel,
			"--autonomy",
			"auto-edit",
			"--no-skills",
			prompt,
		],
		timeoutMs,
	);
	writeFileSync(join(scratchDir, "stdout.jsonl"), redact(run.stdout), "utf8");
	writeFileSync(join(scratchDir, "stderr.log"), redact(run.stderr), "utf8");

	const failures = [];
	const check = (condition, message) => {
		if (!condition) failures.push(message);
	};
	check(run.error === null, `CLI could not start: ${run.error?.message ?? "unknown spawn error"}`);
	check(!run.timedOut, `CLI exceeded the ${timeoutMs}ms timeout and was killed`);
	check(run.code === 0, `CLI exited ${String(run.code)}${run.signal ? ` via ${run.signal}` : ""}`);

	const events = parseJsonLines(run.stdout);
	const dispatchCalls = successfulToolCalls(events, "dispatch");
	const scoutCalls = dispatchCalls.filter((call) => dispatchAgentIds(call.event.args).includes("scout"));
	check(
		scoutCalls.length === 1,
		`expected exactly one successful model-authored Scout dispatch, saw ${scoutCalls.length}`,
	);
	if (scoutCalls[0]) {
		check(scoutCalls[0].event.args?.detach !== true, "Scout dispatch must be synchronous");
	}

	const specialistCalls = dispatchCalls.filter(
		(call) =>
			dispatchAgentIds(call.event.args).includes("debugger") &&
			call.event.args?.task === SPECIALIST_TASK &&
			call.event.args?.briefing === BRIEFING_SENTINEL,
	);
	check(
		specialistCalls.length === 1,
		`expected one accepted singular Debugger dispatch with the exact briefing, saw ${specialistCalls.length}`,
	);
	const specialistCall = specialistCalls[0];
	if (specialistCall) {
		check(specialistCall.event.args?.detach === true, "specialist dispatch did not set detach=true");
		check(!SPECIALIST_TASK.includes(BRIEFING_SENTINEL), "briefing sentinel unexpectedly appears in the expected task");
		check(!Array.isArray(specialistCall.event.args?.tasks), "specialist did not use the singular task form");
	}

	if (scoutCalls[0] && specialistCall) {
		const explorationTools = new Set(["bash", "code_nav", "context", "find", "git", "grep", "ls", "read"]);
		const spotChecks = events.filter(
			(row) =>
				row.index > scoutCalls[0].end.index &&
				row.index < specialistCall.index &&
				row.event.type === "tool_execution_start" &&
				explorationTools.has(row.event.toolName),
		);
		check(
			spotChecks.length >= 1 && spotChecks.length <= 6,
			`expected 1..6 parent spot-check calls after Scout and before Debugger, saw ${spotChecks.length}`,
		);
	}

	const monitorCalls = successfulToolCalls(events, "monitor");
	const steeringCalls = successfulToolCalls(events, "steer").filter(
		(call) => call.event.args?.action === "guide" && call.event.args?.message === STEERING_SENTINEL,
	);
	check(
		steeringCalls.length === 1,
		`expected exactly one successful guide steer with the sentinel, saw ${steeringCalls.length}`,
	);
	const monitorStatus = monitorCalls.find(
		(call) =>
			(!call.event.args?.mode || call.event.args.mode === "status" || call.event.args.mode === "peek") &&
			(!specialistCall || call.index > specialistCall.end.index),
	);
	const steeringCall = steeringCalls[0];
	const monitorWait = monitorCalls.find(
		(call) => call.event.args?.mode === "wait" && (!steeringCall || call.index > steeringCall.end.index),
	);
	const monitorCollect = monitorCalls.find(
		(call) => call.event.args?.mode === "collect" && (!monitorWait || call.index > monitorWait.end.index),
	);
	check(Boolean(monitorStatus), "detached specialist was not monitored before steering");
	check(Boolean(monitorWait), "detached specialist was not waited on after steering");
	check(Boolean(monitorCollect), "detached specialist batch was not collected after wait");
	if (monitorStatus && steeringCall)
		check(monitorStatus.index < steeringCall.index, "steer occurred before the first monitor call");

	let runs = [];
	let receipts = [];
	let batches = [];
	try {
		runs = readJson(join(clioStateDir, "runs.json"));
		check(Array.isArray(runs), "runs.json was not an array");
		if (!Array.isArray(runs)) runs = [];
	} catch (error) {
		failures.push(`could not read runs.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		receipts = receiptsFromState();
	} catch (error) {
		failures.push(`could not read receipts: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const store = readJson(join(clioStateDir, "batches.json"));
		batches = Array.isArray(store?.batches) ? store.batches : [];
	} catch (error) {
		failures.push(`could not read batches.json: ${error instanceof Error ? error.message : String(error)}`);
	}

	const scoutReceipts = receipts.filter((receipt) => receipt.agentId === "scout");
	check(scoutReceipts.length === 1, `expected one Scout receipt, saw ${scoutReceipts.length}`);
	if (scoutReceipts[0]) {
		check(scoutReceipts[0].outcome === "succeeded", `Scout outcome was ${String(scoutReceipts[0].outcome)}`);
		check(
			scoutReceipts[0].output?.state === "final" && scoutReceipts[0].output.text?.trim().length > 0,
			"Scout receipt lacked nonempty final output",
		);
	}

	const specialistReceipts = receipts.filter(
		(receipt) => receipt.agentId === "debugger" && receipt.briefing?.contentHash === briefingHash,
	);
	check(
		specialistReceipts.length === 1,
		`expected one Debugger receipt with the briefing hash, saw ${specialistReceipts.length}`,
	);
	const receipt = specialistReceipts[0];
	if (receipt) {
		check(receipt.task === SPECIALIST_TASK, "specialist receipt task changed or absorbed briefing prose");
		check(!receipt.task.includes(BRIEFING_SENTINEL), "briefing prose leaked into receipt.task");
		check(receipt.briefing?.bytes === briefingBytes, `briefing byte count was ${String(receipt.briefing?.bytes)}`);
		check(receipt.briefing?.contentHash === briefingHash, `briefing hash was ${String(receipt.briefing?.contentHash)}`);
		check(
			receipt.projectContext?.contentHash !== briefingHash,
			"project-context provenance was populated with the briefing hash",
		);
		const steers = Array.isArray(receipt.steering) ? receipt.steering : [];
		const sentinelSteers = steers.filter((steer) => steer.contentHash === steeringHash);
		check(
			sentinelSteers.length === 1,
			`expected one steering provenance entry with the sentinel hash, saw ${sentinelSteers.length}`,
		);
		if (sentinelSteers[0]) {
			check(sentinelSteers[0].bytes === steeringBytes, `steering byte count was ${String(sentinelSteers[0].bytes)}`);
			check(sentinelSteers[0].acknowledged === true, "native worker did not acknowledge the sent steer");
		}
		check(receipt.output?.state === "final", `specialist output state was ${String(receipt.output?.state)}`);
		check(receipt.output?.text?.trim().length > 0, "specialist receipt lacked nonempty final output");
		check(receipt.outcome === "succeeded", `specialist outcome was ${String(receipt.outcome)}`);
		check(receipt.outcomeCode == null, `specialist outcomeCode was ${String(receipt.outcomeCode)}`);
		check(receipt.integrity?.version === 6, `new receipt integrity version was ${String(receipt.integrity?.version)}`);
		check(
			receipt.integrity?.algorithm === "sha256",
			`receipt integrity algorithm was ${String(receipt.integrity?.algorithm)}`,
		);

		const envelope = runs.find((runEnvelope) => runEnvelope.id === receipt.runId);
		check(Boolean(envelope), "specialist ledger envelope was missing");
		if (envelope) {
			check(envelope.outcome === receipt.outcome, "ledger and receipt outcomes differ");
			check((envelope.outcomeCode ?? null) === (receipt.outcomeCode ?? null), "ledger and receipt outcome codes differ");
			check(
				JSON.stringify(envelope.steering ?? []) === JSON.stringify(receipt.steering ?? []),
				"ledger and receipt steering provenance differ",
			);
		}
		const batch = batches.find((candidate) => candidate.runs?.some((batchRun) => batchRun.runId === receipt.runId));
		check(Boolean(batch), "specialist detached batch record was missing");
		if (batch) {
			check(
				typeof batch.collectedAt === "string" && batch.collectedAt.length > 0,
				"specialist batch was not marked collected",
			);
			if (monitorCollect?.event.args?.batch_id) {
				check(monitorCollect.event.args.batch_id === batch.id, "collect used a different batch id");
			}
		}
	}

	const serializedEvidence = JSON.stringify({ receipts, runs });
	check(!serializedEvidence.includes(STEERING_SENTINEL), "steering prose was persisted in receipt or ledger state");
	check(
		run.stdout.includes("receipt_integrity=verified/v6/sha256"),
		"collect output did not expose verified v6 receipt integrity",
	);
	check(run.stdout.includes("evidence_verification="), "collect output did not expose evidence verification separately");
	check(
		run.stdout.includes(`briefing=bytes:${briefingBytes} sha256:${briefingHash}`),
		"collect output did not expose the exact briefing provenance",
	);
	check(run.stdout.includes("project_context="), "collect output did not expose project-context provenance separately");

	const finalText = assistantText(events);
	for (const label of ["receipt_integrity=", "evidence_verification=", "briefing=", "project_context="]) {
		check(finalText.includes(label), `parent final response omitted ${label}`);
	}
	check(!finalText.includes(BRIEFING_SENTINEL), "parent final response quoted the briefing sentinel");
	check(!finalText.includes(STEERING_SENTINEL), "parent final response quoted the steering sentinel");

	const porcelain = git(["status", "--short", "--untracked-files=all"]);
	check(porcelain.trim().length === 0, `temporary workspace was not git-clean:\n${porcelain.trim()}`);
	const fileDifferences = snapshotDifferences(beforeWorkspace, workspaceSnapshot());
	check(fileDifferences.length === 0, `temporary workspace filesystem changed:\n${fileDifferences.join("\n")}`);

	if (failures.length > 0) {
		throw new Error(`fleet-dispatch live regression failed:\n- ${failures.join("\n- ")}`);
	}

	passed = true;
	console.log(
		`[fleet-live] PASS scoutReceipts=${scoutReceipts.length} specialistReceipts=${specialistReceipts.length} ` +
			`briefingBytes=${briefingBytes} steeringBytes=${steeringBytes}`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error(`[fleet-live] artifacts retained under ${scratchDir}`);
	process.exitCode = 1;
} finally {
	if (passed && process.env.CLIO_LIVE_KEEP !== "1") {
		rmSync(scratchDir, { recursive: true, force: true });
	} else if (passed) {
		console.log(`[fleet-live] CLIO_LIVE_KEEP=1; artifacts retained under ${scratchDir}`);
	}
}
