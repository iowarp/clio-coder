import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { stringify } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import {
	buildCompletionContractAuditRecord,
	type CompletionContractAuditRecord,
} from "../../src/domains/safety/audit.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { invokeRegisteredTool } from "../../src/tools/agent-tools.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function project(body: (root: string) => Promise<void>): Promise<void> {
	const scratch = await isolateClioEnv("dispatch-quality-policy-");
	const previousCwd = process.cwd();
	try {
		delete process.env.CLIO_CODER_RIGOR;
		const root = join(scratch.dir, "worker-project");
		mkdirSync(join(root, ".clio-coder"), { recursive: true });
		mkdirSync(join(root, "src"));
		execFileSync("git", ["init", "--quiet", root]);
		writeFileSync(join(root, "src/solver.ts"), "export const solver = 1;\n");
		writeFileSync(join(root, "check.cjs"), "process.exitCode = 0;\n");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { "test:solver": "node check.cjs", lint: "node check.cjs" } }),
		);
		writeFileSync(
			join(root, ".clio-coder/quality.yaml"),
			stringify({
				version: 1,
				rules: [{ id: "solver", paths: ["src/**"], inputs: ["src/**", "check.cjs"], checks: ["test:solver"] }],
			}),
		);
		await body(root);
	} finally {
		process.chdir(previousCwd);
		scratch.restore();
	}
}

function auditedContext(settings: typeof DEFAULT_SETTINGS, audits: CompletionContractAuditRecord[]) {
	const base = dispatchStubContext({ settings });
	const baseSafety = base.getContract<SafetyContract>("safety");
	ok(baseSafety);
	const safety: SafetyContract = {
		...baseSafety,
		audit: {
			...baseSafety.audit,
			recordCompletionContract: (input) => audits.push(buildCompletionContractAuditRecord(input)),
		},
	};
	return {
		bus: base.bus,
		getContract<T extends object>(name: string): T | undefined {
			return name === "safety" ? (safety as T) : base.getContract<T>(name);
		},
	};
}

/** Use the production worker admission and AgentToolResult projection, retaining details. */
async function nativeEvents(root: string, requiredCheck: boolean): Promise<unknown[]> {
	const previousCwd = process.cwd();
	try {
		process.chdir(root);
		const registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: root }), { noSkills: true }, []);
		// Fixture authorization precedes dispatch; the completion gate never grants this approval.
		registry.onPermissionRequired((_call, decision, meta) => {
			void registry.resumeParkedCalls({
				actionClass: decision.classification.actionClass,
				requestId: meta.requestId,
				requestedBy: "test",
			});
		});
		const calls = [
			{ name: ToolNames.Write, args: { path: "src/solver.ts", content: "export const solver = 2;\n" } },
			requiredCheck
				? { name: ToolNames.Verify, args: { check: "test:solver" } }
				: { name: ToolNames.Bash, args: { command: "npm run lint" } },
		];
		const events: unknown[] = [];
		for (const [index, call] of calls.entries()) {
			const toolCallId = `native-${index}`;
			events.push({ type: "tool_execution_start", toolCallId, toolName: call.name, args: call.args });
			const result = await invokeRegisteredTool(registry, call.name, call.args, {
				telemetry: {
					onStart: (payload) => events.push({ type: "clio_coder_tool_start", payload: { ...payload, toolCallId } }),
					onFinish: (payload) => events.push({ type: "clio_coder_tool_finish", payload: { ...payload, toolCallId } }),
				},
			});
			if (requiredCheck && call.name === ToolNames.Verify)
				ok(result.details && "quality" in result.details, "native projection must preserve the quality snapshot");
			events.push({ type: "tool_execution_end", toolCallId, toolName: call.name, isError: false, result });
		}
		events.push({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: JSON.stringify({
					mutatedPaths: ["src/solver.ts"],
					validations: [{ name: requiredCheck ? "npm run test:solver" : "npm run lint", passed: true, evidence: "exit 0" }],
					summary: "Updated src/solver.ts and ran validation.",
				}),
			},
		});
		return events;
	} finally {
		process.chdir(previousCwd);
	}
}

for (const mode of ["missing", "passed", "normal"] as const) {
	it(`native dispatch assesses the worker workspace and audits ${mode} project requirements`, async () =>
		project(async (root) => {
			if (mode === "normal") process.env.CLIO_CODER_RIGOR = "normal";
			const events = await nativeEvents(root, mode === "passed");
			ok(process.cwd() !== root, "the parent must not accidentally supply the worker's cwd");
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.fleet.retry.maxRetries = 0;
			const audits: CompletionContractAuditRecord[] = [];
			let launches = 0;
			const controls: unknown[] = [];
			const bundle = makeDispatchBundle(auditedContext(settings, audits), {
				spawnWorker: (spec, options) => {
					launches++;
					strictEqual(options?.cwd, root);
					if (mode !== "passed")
						ok(!spec.allowedTools.includes(ToolNames.Verify), "completion must not restore a denied tool");
					return {
						pid: null,
						promise: Promise.resolve({ exitCode: 0, signal: null }),
						heartbeatAt: { current: Date.now(), monotonic: performance.now() },
						abort: () => {},
						send: (value) => {
							controls.push(value);
							return true;
						},
						events: (async function* () {
							yield* events;
						})(),
					};
				},
			});
			await bundle.extension.start();
			try {
				const run = await bundle.contract.dispatch({
					agentId: "coder",
					task: "Update solver and verify it.",
					cwd: root,
					executionRole: "builder",
					requestOrigin: "internal",
					...(mode !== "passed" ? { denyTools: [ToolNames.Verify] } : {}),
				});
				const receipt = await run.finalPromise;
				strictEqual(receipt.outcome, mode === "missing" ? "failed" : "succeeded", receipt.failureMessage ?? "");
				if (mode === "missing") match(receipt.outcomeDetail ?? "", /high-rigor finish gate/u);
				const audit = audits.find((row) => row.runId === run.runId);
				ok(audit);
				strictEqual(audit.rigor, mode === "normal" ? "normal" : "high");
				strictEqual(audit.decision, mode === "passed" ? "ok" : "engage");
				strictEqual(audit.quality?.[0]?.state, mode === "passed" ? "passed" : "missing");
				strictEqual(launches, 1);
				deepStrictEqual(controls, [], "the completion gate must not issue tool execution or recovery authority");
				const stored = bundle.contract.getRun(run.runId);
				ok(stored);
				deepStrictEqual(verifyReceiptIntegrity(receipt, stored), { ok: true });
			} finally {
				await bundle.extension.stop?.();
			}
		}));
}

const ACP_PEER = `
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...message}) + "\\n");
require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({id: request.id, result: {protocolVersion: 1}});
  if (request.method === "session/new") send({id: request.id, result: {sessionId: "quality-fixture"}});
  if (request.method === "session/prompt") {
    for (const [id, title, kind, rawInput] of [["write", "write", "edit", {path: "src/solver.ts", content: "updated"}], ["validation", "bash", "execute", {command: "npm run lint"}]]) {
      send({method: "session/update", params: {sessionId: "quality-fixture", update: {sessionUpdate: "tool_call", toolCallId: id, title, kind, rawInput, status: "in_progress"}}});
      send({method: "session/update", params: {sessionId: "quality-fixture", update: {sessionUpdate: "tool_call_update", toolCallId: id, title, status: "completed", rawOutput: {content: [], details: {kind: "ok", exitCode: 0}}}}});
    }
    send({method: "session/update", params: {sessionId: "quality-fixture", update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "Updated solver and ran generic validation."}}}});
    send({id: request.id, result: {stopReason: "end_turn"}});
  }
});
`;

for (const rigor of ["high", "normal"] as const) {
	it(`ACP dispatch audits outstanding policy checks under ${rigor} rigor`, async () =>
		project(async (root) => {
			if (rigor === "normal") process.env.CLIO_CODER_RIGOR = "normal";
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.fleet.retry.maxRetries = 0;
			settings.integrations.externalAgents.entries = [
				{ id: "quality-fixture", command: process.execPath, args: ["-e", ACP_PEER], toolGovernance: "clio-coder-policy" },
			];
			const audits: CompletionContractAuditRecord[] = [];
			const bundle = makeDispatchBundle(auditedContext(settings, audits));
			await bundle.extension.start();
			try {
				const run = await bundle.contract.dispatch({
					agentId: "quality-fixture",
					task: "Update solver and verify it.",
					cwd: root,
					executionRole: "builder",
					requestOrigin: "internal",
				});
				const receipt = await run.finalPromise;
				strictEqual(receipt.outcome, rigor === "high" ? "failed" : "succeeded", receipt.failureMessage ?? "");
				const audit = audits.find((row) => row.runId === run.runId);
				ok(audit);
				strictEqual(audit.rigor, rigor);
				strictEqual(audit.decision, "engage");
				strictEqual(audit.quality?.[0]?.state, "missing");
			} finally {
				await bundle.extension.stop?.();
			}
		}));
}
