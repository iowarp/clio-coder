import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Value } from "typebox/value";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { runClioRun } from "../../src/cli/run.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { readRunRecording } from "../../src/domains/dispatch/index.js";
import { readVerifiedRun } from "../../src/domains/telemetry/index.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { dispatchRequestsFromArgs, prepareDispatchArguments } from "../../src/tools/dispatch-arguments.js";
import {
	describeDispatchPlan,
	resolvedDispatchPlanFromArgs,
	withResolvedPlanTaskPin,
} from "../../src/tools/dispatch-plan.js";
import { buildDispatchParameters } from "../../src/tools/dispatch-schema.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

let env: Awaited<ReturnType<typeof isolateClioEnv>>;
beforeEach(async () => {
	env = await isolateClioEnv("clio-coder-recording-surface-");
});
afterEach(() => env.restore());
const parserOptions = { auto: { approvedAuthorities: ["read-only" as const], authorityBasis: "yolo-policy" as const } };

it("advertises and parses opt-in recording with shared defaults and per-task false overrides", () => {
	const schema = buildDispatchParameters({ council: false, compete: false, adaptiveRouting: false });
	const args = { record: true, tasks: ["first", { task: "second", record: false }, { task: "third", node: "seven" }] };
	equal(Value.Check(schema, args), true);
	const parsed = dispatchRequestsFromArgs(args, parserOptions);
	ok(parsed.ok);
	deepStrictEqual(
		parsed.requests.map((request) => request.record),
		[true, false, true],
	);
	const single = dispatchRequestsFromArgs(prepareDispatchArguments({ task: "single", record: true }), parserOptions);
	ok(single.ok);
	equal(single.requests[0]?.record, true);
	const defaults = dispatchRequestsFromArgs({ tasks: ["unchanged"] }, parserOptions);
	ok(defaults.ok);
	equal(Object.hasOwn(defaults.requests[0] ?? {}, "record"), false);
	for (const value of ["true", 1, null, {}]) {
		equal(Value.Check(schema, { task: "bad", record: value }), false);
		equal(Value.Check(schema, { tasks: [{ task: "bad", record: value }] }), false);
		equal(
			dispatchRequestsFromArgs({ record: value, tasks: [{ task: "override", record: true }] }, parserOptions).ok,
			false,
		);
		equal(dispatchRequestsFromArgs({ tasks: [{ task: "bad", record: value }] }, parserOptions).ok, false);
	}
});

it("CLI --record is opt-in, parses beside --agent, and refuses a main-agent run before boot", async () => {
	const args = parseRunCliArgs(["--agent", "scout", "--record", "--json", "Inspect sources"]);
	equal(args.record, true);
	equal(args.agentId, "scout");
	equal(args.json, true);
	deepStrictEqual(args.diagnostics, []);
	equal(Object.hasOwn(parseRunCliArgs(["--agent", "scout", "Inspect sources"]), "record"), false);
	equal(await runClioRun(["--record", "Inspect sources"], { noContextFiles: true }), 2);
});

it("binds recording into approval plans and returns the manifest reference from the real dispatch tool", async () => {
	const originalCwd = process.cwd();
	process.chdir(env.dir);
	writeFileSync(join(env.dir, "input.txt"), "fixture evidence\n");
	const context = dispatchStubContext();
	const bundle = makeDispatchBundle(context, {
		journalRunEvents: false,
		spawnWorker: () => ({
			pid: null,
			heartbeatAt: { current: Date.now(), monotonic: performance.now() },
			abort() {},
			promise: Promise.resolve({ exitCode: 0, signal: null }),
			events: (async function* () {
				yield { type: "text_delta", delta: "warning: preliminary\ncorrection: inspected original\n" };
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: JSON.stringify({
							findings: [{ claim: "fixture evidence", path: "input.txt", line: 1 }],
							needsSplit: false,
							proposedSubtasks: [],
						}),
					},
				};
				yield { type: "agent_end" };
			})(),
		}),
	});
	await bundle.extension.start();
	try {
		const tool = createDispatchTool({
			dispatch: bundle.contract,
			getAutonomy: () => "yolo",
			getAgentSpecs: () => context.getContract<AgentsContract>("agents")?.listSpecs() ?? [],
		});
		const args = {
			tasks: ["Inspect isolated source evidence.", "Inspect isolated evidence again."],
			mode: "sequential",
			agent: "scout",
			cwd: env.dir,
			record: true,
		};
		const prepared = tool.prepareAdmissionArguments?.(args);
		ok(prepared);
		const artifact = resolvedDispatchPlanFromArgs(prepared);
		ok(artifact?.tasks[0], JSON.stringify(prepared));
		equal(artifact.tasks[0].record, true);
		const view = tool.describeDispatchPlan?.(prepared);
		ok(view);
		match(view.text, /record=true/);
		const noRecordPlan = describeDispatchPlan({ ...args, record: false });
		const recordedPlan = describeDispatchPlan(args);
		ok(noRecordPlan.hash !== recordedPlan.hash);
		const pinBase = { agentId: "scout", executionRole: "researcher" as const, task: "changed", record: false };
		equal(withResolvedPlanTaskPin(pinBase, artifact.tasks[0]).record, true);
		const { record: _record, ...unrecorded } = artifact.tasks[0];
		equal(Object.hasOwn(withResolvedPlanTaskPin({ ...pinBase, record: true }, unrecorded), "record"), false);
		const result = await tool.run(prepared);
		equal(result.kind, "ok", JSON.stringify(result));
		const runs = result.details?.runs as Array<{ runId: string; recording?: { manifestPath: string } }>;
		ok(runs[0]?.recording);
		equal(runs[0].recording.manifestPath, `runs/${runs[0].runId}/recording.json`);
		const source = readRunRecording(clioStateDir(), runs[0].runId);
		ok(source?.cast);
		match(source.cast, /warning/);
		match(source.cast, /correction/);
		const manifest = JSON.parse(readFileSync(join(clioStateDir(), runs[0].recording.manifestPath), "utf8"));
		equal(manifest.sha256, source.manifest.sha256);
		if (result.kind === "ok") match(result.output, /recording_manifest=/);
		const defaultResult = await tool.run({ ...args, record: undefined });
		equal(defaultResult.kind, "ok", JSON.stringify(defaultResult));
		const defaultRun = (defaultResult.details?.runs as Array<{ runId: string; recording?: unknown }>)[0];
		ok(defaultRun);
		equal(Object.hasOwn(defaultRun, "recording"), false);
		equal(readRunRecording(clioStateDir(), defaultRun.runId), null);
		const review = tool.prepareAdmissionArguments?.({
			task: "Inspect the source.",
			agent: "coder",
			cwd: env.dir,
			review: true,
			record: true,
		});
		ok(review);
		const reviewView = tool.describeDispatchPlan?.(review);
		ok(reviewView);
		ok(reviewView.tasks.length >= 2);
		ok(reviewView.tasks.every((task) => task.record === true));
		tool.disposeAdmissionArguments?.(review);
	} finally {
		await bundle.extension.stop?.();
		process.chdir(originalCwd);
	}
});

it("admits an approved sibling-checkout Scout read once per run and records the root on the receipt (#433)", async () => {
	const host = join(env.dir, "host");
	const sibling = join(env.dir, "sibling");
	mkdirSync(host);
	mkdirSync(sibling);
	// A symlinked root proves admission canonicalizes it rather than resolving it lexically (#433).
	const link = join(env.dir, "link");
	symlinkSync(sibling, link);
	writeFileSync(join(sibling, "input.txt"), "sibling evidence\n");
	const context = dispatchStubContext();
	const bundle = makeDispatchBundle(context, {
		journalRunEvents: false,
		spawnWorker: () => ({
			pid: null,
			heartbeatAt: { current: Date.now(), monotonic: performance.now() },
			abort() {},
			promise: Promise.resolve({ exitCode: 0, signal: null }),
			events: (async function* () {
				const content = JSON.stringify({
					findings: [{ claim: "sibling evidence", path: "input.txt", line: 1 }],
					needsSplit: false,
					proposedSubtasks: [],
				});
				yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content } };
				yield { type: "agent_end" };
			})(),
		}),
	});
	await bundle.extension.start();
	try {
		const approvals: string[] = [];
		const tool = createDispatchTool({
			dispatch: bundle.contract,
			getAutonomy: () => "yolo",
			getWorkspaceRoot: () => host,
			approveExternalRead: async (root) => {
				approvals.push(root);
				return { requestId: "approval-1", requestedBy: "operator" };
			},
			getAgentSpecs: () => context.getContract<AgentsContract>("agents")?.listSpecs() ?? [],
		});
		const scout = { agent: "scout", mode: "parallel", intent: { read_roots: [`${link}/`] } };
		const writing = tool.prepareAdmissionArguments?.({
			...scout,
			task: "Inspect and fix the sibling checkout.",
			intent: { read_roots: [`${link}/`], write_roots: ["src/"] },
		});
		const refused = writing === undefined ? null : await tool.run(writing);
		equal(refused?.kind, "error", JSON.stringify(refused));
		match(JSON.stringify(refused), /external_read_write_scope/);
		const prepared = tool.prepareAdmissionArguments?.({
			...scout,
			tasks: ["Inspect the sibling checkout.", "Inspect the sibling checkout again."],
		});
		ok(prepared);
		const result = await tool.run(prepared);
		equal(result.kind, "ok", JSON.stringify(result));
		const root = realpathSync(sibling);
		deepStrictEqual(approvals, [root, root]);
		const runs = result.details?.runs as Array<{ runId: string }>;
		equal(runs.length, 2);
		equal(new Set(runs.map((run) => run.runId)).size, 2);
		for (const run of runs) {
			const record = readVerifiedRun(clioStateDir(), run.runId);
			ok(record);
			equal(record.settled.outcome, "succeeded");
			equal(bundle.contract.getRun(run.runId)?.cwd, root);
		}
	} finally {
		await bundle.extension.stop?.();
	}
});
