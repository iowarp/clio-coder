/**
 * Live fleet-dispatch regression: one read-only parent turn, real model.
 *
 * Proves the model-authored lifecycle that deterministic contracts cannot:
 * Scout selection, bounded parent spot-checks, one detached Debugger dispatch
 * with a real briefing, one native guide steer, monitor/wait/collect in that
 * order, and truthful terminal evidence labels. It runs in a committed copy of
 * this repository and fails if that copy changes in any way.
 *
 * Everything asserted is read from the JSONL event stream of `run --json` and
 * from the scratch home's receipts, runs.json, and batches.json. The stream is
 * written to the home as stdout.jsonl even when the turn hits its timeout, so
 * a retained tree always says how far the lifecycle got.
 *
 *   npm run live:fleet-dispatch -- --target <id> [--model <id>] [--thinking medium] [--timeout-ms 600000] [--keep]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	clio,
	LiveUsageError,
	parseLiveArgs,
	REPO_ROOT,
	rejectUnknown,
	requireBuild,
	runDriver,
	settleRun,
	takeFlag,
	withLiveHome,
} from "./live-target.js";
import { workspaceChanges, workspaceSnapshot } from "./workspace-snapshot.js";

const USAGE = `usage: npm run live:fleet-dispatch -- --target <id> [--model <wireId>] [--thinking <level>] [--timeout-ms <ms>] [--keep]

One model-authored Scout -> spot-check -> detached Debugger -> steer -> wait -> collect
turn in a committed copy of this repository. Needs dist/ (npm run build).
Default thinking is medium; default turn timeout is 600000 ms.
`;

const BRIEFING_SENTINEL = "CLIO_CODER_FLEET_BRIEFING_SENTINEL_v6_20260713";
const STEERING_SENTINEL = "CLIO_CODER_FLEET_STEERING_SENTINEL_v6_20260713";
const SPECIALIST_TASK =
	"Read-only: verify the receipt v4/v5/v6 compatibility boundary and report two cited risks without quoting dynamic context or steering messages.";
const EXPLORATION_TOOLS = new Set(["bash", "code_nav", "context", "find", "git", "grep", "ls", "read"]);
const EXCLUDED_ROOTS = new Set([".git", ".clio-coder", ".superpowers", "coverage", "dist", "node_modules"]);

const PROMPT = `Perform this bounded fleet-dispatch regression without modifying the workspace or creating a report file. The final report belongs only in your final assistant response.

1. Model-select and synchronously dispatch exactly one small Scout reconnaissance using the singular task form. Ask it for a concise index of the receipt-integrity and worker-steering implementation, with cited source locations.
2. Treat the successful Scout receipt as an index. Spot-check a risk-weighted subset of its citations with at least one and no more than six parent read/search calls.
3. Then launch exactly one detached read-only Debugger with the singular dispatch shape. Its task must be exactly:
${SPECIALIST_TASK}
Pass this distinct value through the real dispatch briefing field, not inside task:
${BRIEFING_SENTINEL}
4. Monitor the detached run. Send exactly one guide steer whose message is exactly ${STEERING_SENTINEL}. Then wait for it and collect its returned batch id before any synthesis.
5. Report the collected receipt evidence. Include distinct lines beginning receipt_integrity=, evidence_verification=, briefing=, and project_context=. Never call parent spot-checking independent specialist confirmation. Do not quote either sentinel in the final response.`;

type Json = Record<string, unknown>;
interface Row {
	index: number;
	event: Json;
}
interface Call extends Row {
	end: Row;
}

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const rec = (value: unknown, key: string): Json | undefined =>
	isJson(value) && isJson(value[key]) ? value[key] : undefined;
const str = (value: unknown, key: string): string | undefined =>
	isJson(value) && typeof value[key] === "string" ? value[key] : undefined;
const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

function parseJsonLines(text: string): Row[] {
	const rows: Row[] = [];
	text.split(/\r?\n/u).forEach((line, index) => {
		if (line.trim().length === 0) return;
		try {
			const value: unknown = JSON.parse(line);
			if (isJson(value)) rows.push({ index, event: value });
		} catch {
			// Non-JSONL lines (a pretty receipt on an agent path) stay in the raw artifact.
		}
	});
	return rows;
}

function successfulToolCalls(rows: Row[], toolName: string): Call[] {
	const ends = new Map<string, Row>();
	for (const row of rows) {
		const id = str(row.event, "toolCallId");
		if (row.event.type === "tool_execution_end" && id) ends.set(id, row);
	}
	return rows.flatMap((start) => {
		const id = str(start.event, "toolCallId");
		if (start.event.type !== "tool_execution_start" || start.event.toolName !== toolName || !id) return [];
		const end = ends.get(id);
		if (!end || end.index <= start.index || end.event.isError === true) return [];
		if (str(end.event, "result") === undefined && rec(end.event, "result")?.kind === "error") return [];
		return [{ ...start, end }];
	});
}

function dispatchAgentIds(args: unknown): string[] {
	if (!isJson(args)) return [];
	const ids: string[] = [];
	const top = args.agent ?? args.agent_id ?? args.agentId;
	if (typeof top === "string") ids.push(top);
	let tasks: unknown = args.tasks;
	if (typeof tasks === "string") {
		try {
			tasks = JSON.parse(tasks);
		} catch {
			tasks = [];
		}
	}
	if (Array.isArray(tasks)) {
		for (const task of tasks) {
			const agent = isJson(task) ? (task.agent ?? task.agent_id ?? task.agentId) : undefined;
			if (typeof agent === "string") ids.push(agent);
		}
	}
	return ids;
}

function assistantText(rows: Row[]): string {
	let latest = "";
	for (const row of rows) {
		const message = rec(row.event, "message");
		if (row.event.type !== "message_end" || message?.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") latest = content;
		else if (Array.isArray(content)) {
			latest = content
				.filter((block): block is Json => isJson(block) && block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("");
		}
	}
	return latest;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

await runDriver(USAGE, async () => {
	requireBuild();
	const args = parseLiveArgs(process.argv.slice(2), "medium");
	const timeoutMs = Number.parseInt(takeFlag(args.rest, "--timeout-ms") ?? "600000", 10);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000) throw new LiveUsageError("--timeout-ms must be >= 30000");
	rejectUnknown(args.rest);

	// Dispatch is denied at read-only autonomy. auto-edit admits the two
	// singular local runs; read-only recipes plus the snapshot below keep the
	// workspace unchanged. The repository copy and git seeding run inside the
	// home's cleanup protection, so a copy that fails half-way still removes
	// the credentials.
	return withLiveHome(args, { prefix: "clio-live-fleet-dispatch-", autonomy: "auto-edit" }, async (home) => {
		const workspaceDir = home.workspace;
		cpSync(REPO_ROOT, workspaceDir, {
			recursive: true,
			filter(source) {
				const path = relative(REPO_ROOT, source);
				if (path.length === 0) return true;
				return !EXCLUDED_ROOTS.has(path.split(sep)[0] as string);
			},
		});
		const git = (gitArgs: string[]): string =>
			execFileSync("git", gitArgs, { cwd: workspaceDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git(["init", "--quiet"]);
		git(["config", "user.email", "eval@clio.local"]);
		git(["config", "user.name", "Clio Fleet Live Eval"]);
		git(["add", "-A"]);
		git(["commit", "--quiet", "-m", "eval: fleet-dispatch baseline"]);
		const before = workspaceSnapshot(workspaceDir);

		const briefingBytes = Buffer.byteLength(BRIEFING_SENTINEL, "utf8");
		const briefingHash = sha256(BRIEFING_SENTINEL);
		const steeringBytes = Buffer.byteLength(STEERING_SENTINEL, "utf8");
		const steeringHash = sha256(STEERING_SENTINEL);

		process.stdout.write(
			`live fleet-dispatch: target=${home.target.id} model=${home.model} thinking=${home.thinking} timeoutMs=${timeoutMs}\n`,
		);
		const failures: string[] = [];
		const check = (condition: boolean, message: string): void => {
			if (!condition) failures.push(message);
		};
		const run = await settleRun(
			clio(
				home,
				[
					"run",
					"--json",
					"--target",
					home.target.id,
					"--model",
					home.model,
					"--thinking",
					home.thinking,
					"--autonomy",
					"auto-edit",
					"--no-skills",
					PROMPT,
				],
				{ cwd: workspaceDir, timeoutMs },
			),
		);
		const stdout = run.stdout;
		writeFileSync(join(home.dir, "stdout.jsonl"), home.redact(run.stdout), "utf8");
		writeFileSync(join(home.dir, "stderr.log"), home.redact(run.stderr), "utf8");
		if (run.timedOut) {
			check(false, `CLI did not finish within ${timeoutMs} ms; partial stream kept at ${join(home.dir, "stdout.jsonl")}`);
		} else {
			check(run.code === 0, `CLI exited ${String(run.code)}${run.signal ? ` via ${run.signal}` : ""}`);
		}

		const rows = parseJsonLines(stdout);
		const dispatchCalls = successfulToolCalls(rows, "dispatch");
		const scoutCalls = dispatchCalls.filter((call) => dispatchAgentIds(call.event.args).includes("scout"));
		check(
			scoutCalls.length === 1,
			`expected exactly one successful model-authored Scout dispatch, saw ${scoutCalls.length}`,
		);
		const scout = scoutCalls[0];
		if (scout) check(rec(scout.event, "args")?.detach !== true, "Scout dispatch must be synchronous");

		const specialistCalls = dispatchCalls.filter((call) => {
			const callArgs = rec(call.event, "args");
			return (
				dispatchAgentIds(callArgs).includes("debugger") &&
				callArgs?.task === SPECIALIST_TASK &&
				callArgs?.briefing === BRIEFING_SENTINEL
			);
		});
		check(
			specialistCalls.length === 1,
			`expected one accepted singular Debugger dispatch with the exact briefing, saw ${specialistCalls.length}`,
		);
		const specialist = specialistCalls[0];
		if (specialist) {
			const callArgs = rec(specialist.event, "args");
			check(callArgs?.detach === true, "specialist dispatch did not set detach=true");
			check(!Array.isArray(callArgs?.tasks), "specialist did not use the singular task form");
		}
		if (scout && specialist) {
			const spotChecks = rows.filter(
				(row) =>
					row.index > scout.end.index &&
					row.index < specialist.index &&
					row.event.type === "tool_execution_start" &&
					EXPLORATION_TOOLS.has(str(row.event, "toolName") ?? ""),
			);
			check(
				spotChecks.length >= 1 && spotChecks.length <= 6,
				`expected 1..6 parent spot-check calls after Scout and before Debugger, saw ${spotChecks.length}`,
			);
		}

		const monitorCalls = successfulToolCalls(rows, "monitor");
		const steeringCalls = successfulToolCalls(rows, "steer").filter((call) => {
			const callArgs = rec(call.event, "args");
			return callArgs?.action === "guide" && callArgs?.message === STEERING_SENTINEL;
		});
		check(
			steeringCalls.length === 1,
			`expected exactly one successful guide steer with the sentinel, saw ${steeringCalls.length}`,
		);
		const steer = steeringCalls[0];
		const mode = (call: Call): string | undefined => str(rec(call.event, "args"), "mode");
		const monitorStatus = monitorCalls.find(
			(call) =>
				(mode(call) === undefined || mode(call) === "status" || mode(call) === "peek") &&
				(!specialist || call.index > specialist.end.index),
		);
		const monitorWait = monitorCalls.find((call) => mode(call) === "wait" && (!steer || call.index > steer.end.index));
		const monitorCollect = monitorCalls.find(
			(call) => mode(call) === "collect" && (!monitorWait || call.index > monitorWait.end.index),
		);
		check(Boolean(monitorStatus), "detached specialist was not monitored before steering");
		check(Boolean(monitorWait), "detached specialist was not waited on after steering");
		check(Boolean(monitorCollect), "detached specialist batch was not collected after wait");
		if (monitorStatus && steer) check(monitorStatus.index < steer.index, "steer occurred before the first monitor call");

		let runs: Json[] = [];
		let receipts: Json[] = [];
		let batches: Json[] = [];
		try {
			const parsed = readJson(join(home.stateDir, "runs.json"));
			check(Array.isArray(parsed), "runs.json was not an array");
			if (Array.isArray(parsed)) runs = parsed.filter(isJson);
		} catch (error) {
			failures.push(`could not read runs.json: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const dir = join(home.stateDir, "receipts");
			receipts = existsSync(dir)
				? readdirSync(dir)
						.filter((name) => name.endsWith(".json"))
						.map((name) => readJson(join(dir, name)))
						.filter(isJson)
				: [];
		} catch (error) {
			failures.push(`could not read receipts: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const store = readJson(join(home.stateDir, "batches.json"));
			const list = isJson(store) ? store.batches : undefined;
			batches = Array.isArray(list) ? list.filter(isJson) : [];
		} catch (error) {
			failures.push(`could not read batches.json: ${error instanceof Error ? error.message : String(error)}`);
		}

		const scoutReceipts = receipts.filter((receipt) => receipt.agentId === "scout");
		check(scoutReceipts.length === 1, `expected one Scout receipt, saw ${scoutReceipts.length}`);
		const scoutReceipt = scoutReceipts[0];
		if (scoutReceipt) {
			check(scoutReceipt.outcome === "succeeded", `Scout outcome was ${String(scoutReceipt.outcome)}`);
			const output = rec(scoutReceipt, "output");
			check(
				output?.state === "final" && (str(output, "text") ?? "").trim().length > 0,
				"Scout receipt lacked nonempty final output",
			);
		}

		const specialistReceipts = receipts.filter(
			(receipt) => receipt.agentId === "debugger" && str(rec(receipt, "briefing"), "contentHash") === briefingHash,
		);
		check(
			specialistReceipts.length === 1,
			`expected one Debugger receipt with the briefing hash, saw ${specialistReceipts.length}`,
		);
		const receipt = specialistReceipts[0];
		if (receipt) {
			const briefing = rec(receipt, "briefing");
			const output = rec(receipt, "output");
			const integrity = rec(receipt, "integrity");
			check(receipt.task === SPECIALIST_TASK, "specialist receipt task changed or absorbed briefing prose");
			check(briefing?.bytes === briefingBytes, `briefing byte count was ${String(briefing?.bytes)}`);
			check(
				str(rec(receipt, "projectContext"), "contentHash") !== briefingHash,
				"project-context provenance was populated with the briefing hash",
			);
			const steers = Array.isArray(receipt.steering) ? receipt.steering.filter(isJson) : [];
			const sentinelSteers = steers.filter((entry) => entry.contentHash === steeringHash);
			check(
				sentinelSteers.length === 1,
				`expected one steering provenance entry with the sentinel hash, saw ${sentinelSteers.length}`,
			);
			const sentinelSteer = sentinelSteers[0];
			if (sentinelSteer) {
				check(sentinelSteer.bytes === steeringBytes, `steering byte count was ${String(sentinelSteer.bytes)}`);
				check(sentinelSteer.acknowledged === true, "native worker did not acknowledge the sent steer");
			}
			check(output?.state === "final", `specialist output state was ${String(output?.state)}`);
			check((str(output, "text") ?? "").trim().length > 0, "specialist receipt lacked nonempty final output");
			check(receipt.outcome === "succeeded", `specialist outcome was ${String(receipt.outcome)}`);
			check(receipt.outcomeCode == null, `specialist outcomeCode was ${String(receipt.outcomeCode)}`);
			check(integrity?.version === 6, `new receipt integrity version was ${String(integrity?.version)}`);
			check(integrity?.algorithm === "sha256", `receipt integrity algorithm was ${String(integrity?.algorithm)}`);

			const envelope = runs.find((entry) => entry.id === receipt.runId);
			check(Boolean(envelope), "specialist ledger envelope was missing");
			if (envelope) {
				check(envelope.outcome === receipt.outcome, "ledger and receipt outcomes differ");
				check((envelope.outcomeCode ?? null) === (receipt.outcomeCode ?? null), "ledger and receipt outcome codes differ");
				check(
					JSON.stringify(envelope.steering ?? []) === JSON.stringify(receipt.steering ?? []),
					"ledger and receipt steering provenance differ",
				);
			}
			const batch = batches.find(
				(candidate) =>
					Array.isArray(candidate.runs) && candidate.runs.some((entry) => isJson(entry) && entry.runId === receipt.runId),
			);
			check(Boolean(batch), "specialist detached batch record was missing");
			if (batch) {
				check(
					typeof batch.collectedAt === "string" && batch.collectedAt.length > 0,
					"specialist batch was not marked collected",
				);
				const collectedId = str(rec(monitorCollect?.event, "args"), "batch_id");
				if (collectedId) check(collectedId === batch.id, "collect used a different batch id");
			}
		}

		check(
			!JSON.stringify({ receipts, runs }).includes(STEERING_SENTINEL),
			"steering prose was persisted in receipt or ledger state",
		);
		check(
			stdout.includes("receipt_integrity=verified/v6/sha256"),
			"collect output did not expose verified v6 receipt integrity",
		);
		check(stdout.includes("evidence_verification="), "collect output did not expose evidence verification separately");
		check(
			stdout.includes(`briefing=bytes:${briefingBytes} sha256:${briefingHash}`),
			"collect output did not expose the exact briefing provenance",
		);
		check(stdout.includes("project_context="), "collect output did not expose project-context provenance separately");

		const finalText = assistantText(rows);
		for (const label of ["receipt_integrity=", "evidence_verification=", "briefing=", "project_context="]) {
			check(finalText.includes(label), `parent final response omitted ${label}`);
		}
		check(!finalText.includes(BRIEFING_SENTINEL), "parent final response quoted the briefing sentinel");
		check(!finalText.includes(STEERING_SENTINEL), "parent final response quoted the steering sentinel");

		const porcelain = git(["status", "--short", "--untracked-files=all"]);
		check(porcelain.trim().length === 0, `temporary workspace was not git-clean:\n${porcelain.trim()}`);
		const changed = workspaceChanges(before, workspaceSnapshot(workspaceDir));
		check(changed.length === 0, `temporary workspace filesystem changed:\n${changed.join("\n")}`);

		if (failures.length > 0) {
			process.stderr.write(`live fleet-dispatch: FAIL\n- ${home.redact(failures.join("\n- "))}\n`);
			return false;
		}
		process.stdout.write(
			`live fleet-dispatch: PASS scoutReceipts=${scoutReceipts.length} specialistReceipts=${specialistReceipts.length} ` +
				`briefingBytes=${briefingBytes} steeringBytes=${steeringBytes}\n`,
		);
		return true;
	});
});
