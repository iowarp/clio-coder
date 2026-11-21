import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RunPlanProvenance } from "../../src/domains/dispatch/types.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareEffect, MiddlewareHookRegistration } from "../../src/domains/middleware/index.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import type { SafetyJudgeOutcome, SafetyJudgeSeat } from "../../src/domains/safety/safety-judge.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { dispatchRewriteNarrows } from "../../src/tools/dispatch-narrowing.js";
import type { DispatchExecutionSnapshot } from "../../src/tools/dispatch-types.js";
import { createRegistry, type RegistryDeps, type ToolSpec } from "../../src/tools/registry.js";
import { isolateDispatchState, restoreDispatchState } from "../harness/dispatch.js";

// WX2: a before_tool hook that only narrows an operator-approved plan-scale
// dispatch (the WTF-P desk confining each worker) must not lose the approval.

beforeEach(async () => isolateDispatchState());
afterEach(() => restoreDispatchState());

type Intent = { write_roots?: string[]; read_roots?: string[]; relevant_paths?: string[] };
type Task = { task: string; intent: Intent };
const task = (root: string, extra: Omit<Intent, "write_roots"> = {}): Task => ({
	task: "Edit the module.",
	intent: { write_roots: [root], ...extra },
});

function rewriter(
	args: Record<string, unknown>,
	editLive?: (live: Record<string, unknown>) => void,
): MiddlewareHookRegistration {
	return {
		id: "extension:desk:before_tool:0",
		description: "confines each dispatched worker",
		hooks: ["before_tool"],
		awaited: true,
		evaluate: () => [],
		async evaluateAsync(input): Promise<ReadonlyArray<MiddlewareEffect>> {
			if (editLive !== undefined && input.toolArgs !== undefined) editLive(input.toolArgs);
			return [{ kind: "rewrite_tool_input", args, reason: "confine workers", source: "desk" }];
		},
	};
}

interface DispatchCase {
	original?: Task[];
	/** Arguments both calls carry besides the agent and tasks. */
	args?: Record<string, unknown>;
	/** Surface that answers the approval ask. */
	requestedBy?: string;
	/** Edits the arguments the hook sees, in place, before it rewrites them. */
	editLive?: (live: Record<string, unknown>) => void;
}

async function approvedDispatch(rewritten: Task[], options: DispatchCase = {}) {
	const shared = { agent: "coder", ...options.args };
	const original = options.original ?? [task("src/"), task("lib/")];
	const middleware = createMiddlewareBundle({
		registrations: [rewriter({ ...shared, tasks: rewritten }, options.editLive)],
	}).contract;
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd: process.cwd() }),
		autonomy: () => "default",
		middleware,
	});
	const ran: string[][] = [];
	const plans: unknown[] = [];
	registry.register(
		createDispatchTool({
			dispatch: {
				// The same grants for every request, so only the narrowing checks decide a carry.
				derivedGrants: () => ({
					requestedActions: ["read", "write"],
					mcp: null,
					permit: {
						version: 1,
						ceiling: { capabilityClass: "workspace-edit", tools: [], readOnly: false, writeRoots: [], enforcement: {} },
						allowance: {},
						digest: "stub",
					},
				}),
				dispatchBatch: async (requests: ReadonlyArray<DispatchRequest>) => {
					for (const request of requests) {
						ran.push([...(request.intent?.writeRoots ?? [])]);
						plans.push(request.plan);
					}
					throw new Error("stub workers");
				},
				dispatch: async (request: DispatchRequest) => {
					ran.push([...(request.intent?.writeRoots ?? [])]);
					throw new Error("stub worker");
				},
			} as unknown as DispatchContract,
			getAgentSpecs: () => [{ id: "coder", capabilityClass: "workspace-edit" }] as never,
		}),
	);
	let asks = 0;
	registry.onPermissionRequired((_call, decision, meta) => {
		asks += 1;
		void registry.resumeParkedCalls({
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			requestedBy: options.requestedBy ?? "tool:one_shot",
		});
	});
	const verdict = await registry.invoke({ tool: "dispatch", args: { ...shared, tasks: original } });
	return { verdict, asks, ran, plans };
}

function refusedApproval(outcome: Awaited<ReturnType<typeof approvedDispatch>>): void {
	strictEqual(outcome.verdict.kind, "blocked");
	match(outcome.verdict.kind === "blocked" ? outcome.verdict.reason : "", /would need operator approval/);
	deepStrictEqual(outcome.ran, []);
}

describe("an approved dispatch rewritten by a before_tool hook", () => {
	it("keeps the approval when the rewrite only narrows write roots", async () => {
		const { verdict, asks, ran } = await approvedDispatch([task("src/a/"), task("lib/b/")]);
		strictEqual(asks, 1);
		strictEqual(verdict.kind, "ok");
		match(
			verdict.kind === "ok" && verdict.result.kind === "error" ? verdict.result.message : "",
			/approval carried over/,
		);
		deepStrictEqual(ran.sort(), [["lib/b/"], ["src/a/"]]);
	});

	it("seals which plan was approved and names the client whose approval carried over", async () => {
		const { verdict, plans } = await approvedDispatch([task("src/a/"), task("lib/b/")], { requestedBy: "acp-client" });
		match(
			verdict.kind === "ok" && verdict.result.kind === "error" ? verdict.result.message : "",
			/the connected ACP client's approval carried over/,
		);
		strictEqual(plans.length, 2);
		const plan = plans[0] as RunPlanProvenance;
		deepStrictEqual(plans[1], plan);
		strictEqual(plan.approvalRequestedBy, "acp-client");
		strictEqual(plan.approvalCarry?.extension, "desk");
		strictEqual(plan.approvalCarry?.rewrittenPlanHash, plan.hash);
		match(plan.approvalCarry?.approvedPlanHash ?? "", /^[0-9a-f]{64}$/u);
	});

	it("refuses a rewrite that adds a task", async () => {
		const { verdict, ran } = await approvedDispatch([task("src/a/"), task("lib/b/"), task("lib/c/")]);
		strictEqual(verdict.kind, "blocked");
		match(verdict.kind === "blocked" ? verdict.reason : "", /would need operator approval/);
		deepStrictEqual(ran, []);
	});

	it("refuses a rewrite that changes a task's text and keeps its roots", async () => {
		const changed = { ...task("lib/"), task: "Delete the module." };
		const { verdict, ran } = await approvedDispatch([task("src/"), changed]);
		strictEqual(verdict.kind, "blocked");
		match(verdict.kind === "blocked" ? verdict.reason : "", /would need operator approval/);
		deepStrictEqual(ran, []);
	});

	it("refuses a rewrite that edits the approved task text in place to match itself", async () => {
		const deleting = { ...task("lib/b/"), task: "Delete the module." };
		refusedApproval(
			await approvedDispatch([task("src/a/"), deleting], {
				editLive: (live) => {
					const tasks = live.tasks as Task[];
					if (tasks[1] !== undefined) tasks[1].task = "Delete the module.";
				},
			}),
		);
	});

	it("refuses a rewrite that widens a write root", async () => {
		const { verdict, ran } = await approvedDispatch([task("src/a/"), task("docs/")]);
		strictEqual(verdict.kind, "blocked");
		match(verdict.kind === "blocked" ? verdict.reason : "", /would need operator approval/);
		deepStrictEqual(ran, []);
	});

	it("refuses a rewrite that adds relevant paths the approved intent never read", async () => {
		refusedApproval(await approvedDispatch([task("src/a/", { relevant_paths: [".env", "config/"] }), task("lib/b/")]));
	});

	it("refuses a rewrite to a write root that links outside the approved root", async () => {
		// The dispatch cwd must sit inside the workspace root, which is the process cwd.
		const home = process.cwd();
		const cwd = mkdtempSync(join(tmpdir(), "rewrite-keeps-approval-"));
		try {
			mkdirSync(join(cwd, "src"));
			mkdirSync(join(cwd, "lib"));
			symlinkSync("../lib", join(cwd, "src", "vendor"));
			process.chdir(cwd);
			refusedApproval(
				await approvedDispatch([task("src/vendor/"), task("docs/a/")], { original: [task("src/"), task("docs/")] }),
			);
		} finally {
			process.chdir(home);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("judges write roots by the intent when a legacy writeRoots: [] rides along", async () => {
		// WX4: request.writeRoots took the legacy [] and read the confined original as unrestricted.
		const home = process.cwd();
		const cwd = mkdtempSync(join(tmpdir(), "rewrite-keeps-approval-"));
		try {
			mkdirSync(join(cwd, "src"));
			mkdirSync(join(cwd, "lib"));
			symlinkSync("../lib", join(cwd, "src", "vendor"));
			process.chdir(cwd);
			const options = { original: [task("src/"), task("lib/")], args: { writeRoots: [], writers: 1 } };
			const emptied = { task: "Edit the module.", intent: { write_roots: [] } };
			refusedApproval(await approvedDispatch([emptied, task("lib/")], options));
			refusedApproval(await approvedDispatch([task("src/vendor/"), task("lib/")], options));
		} finally {
			process.chdir(home);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("a rewrite that adds write roots to an intent that declared none", () => {
	// F-C12: such an intent leaves the worker unbounded under its cwd, so that
	// workspace is the ceiling a desk narrows, not an empty one.
	const intentArgs = (intent: Intent) => ({ intent });

	for (const intent of [{ read_roots: ["paper/"] }, { read_roots: ["paper/"], write_roots: [] }] as Intent[]) {
		const label = intent.write_roots === undefined ? "read_roots only" : "write_roots: []";
		it(`${intent.write_roots === undefined ? "admits" : "refuses"} an in-workspace write root added beside the shared intent (${label})`, async () => {
			// The desk's shape: the model's intent rides at the top level, the rewrite confines the task.
			const { verdict, ran } = await approvedDispatch(
				[{ task: "Edit the module.", intent: { write_roots: ["paper/x.md"] } }],
				{ original: [{ task: "Edit the module." } as never], args: intentArgs(intent) },
			);
			if (intent.write_roots !== undefined) {
				// M2 (DESIGN 4.7): an explicit write_roots: [] declares no writes, so it is a ceiling a member cannot widen.
				const text =
					verdict.kind === "ok" && verdict.result.kind === "error" ? verdict.result.message : JSON.stringify(verdict);
				match(text, /intent_scope_widening: .*write_roots: \[\] \(no writes\)/);
				deepStrictEqual(ran, []);
				return;
			}
			strictEqual(verdict.kind, "ok");
			deepStrictEqual(ran, [["paper/x.md"]]);
		});

		it(`refuses a write root outside the workspace (${label})`, async () => {
			const { verdict, ran } = await approvedDispatch(
				[{ task: "Edit the module.", intent: { write_roots: ["../elsewhere/"] } }],
				{ original: [{ task: "Edit the module." } as never], args: intentArgs(intent) },
			);
			const text =
				verdict.kind === "blocked"
					? verdict.reason
					: verdict.kind === "ok" && verdict.result.kind === "error"
						? verdict.result.message
						: "";
			match(text, /escapes the repository root/);
			deepStrictEqual(ran, []);
		});
	}

	it("carries an approval across a rewrite that confines an unconfined intent inside the workspace", () => {
		const request = (writeRoots: string[], cwd?: string) => ({
			agentId: "coder",
			task: "Edit the module.",
			...(cwd !== undefined ? { cwd } : {}),
			intent: {
				version: 2,
				readRoots: ["paper/"],
				writeRoots,
				relevantPaths: [],
				pathProvenance: [],
				expectedOutputs: [],
				verification: [],
			},
		});
		const snapshot = (writeRoots: string[], cwd?: string) =>
			({
				kind: "dispatch",
				mode: "parallel",
				writers: 1,
				requests: [request(writeRoots, cwd)],
				planView: { topology: "parallel", taskCount: 1, planScale: true, text: "", hash: "", tasks: [] },
			}) as unknown as DispatchExecutionSnapshot;
		strictEqual(dispatchRewriteNarrows(snapshot([]), snapshot(["paper/x.md"])), true);
		const cwd = mkdtempSync(join(tmpdir(), "rewrite-keeps-approval-"));
		const outside = mkdtempSync(join(tmpdir(), "rewrite-outside-"));
		try {
			mkdirSync(join(cwd, "paper"));
			symlinkSync(outside, join(cwd, "paper", "ext"));
			strictEqual(dispatchRewriteNarrows(snapshot([], cwd), snapshot(["paper/x.md"], cwd)), true);
			strictEqual(dispatchRewriteNarrows(snapshot([], cwd), snapshot(["paper/ext/"], cwd)), false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("the plan view of a rewritten dispatch", () => {
	const route = {
		version: 1,
		decision: { mode: "active" },
		totalCostUpperBoundUsd: 2,
		deadlineMs: null,
		maxAttempts: 2,
	};
	const snapshot = (
		routeApproval: Record<string, unknown>,
		plan: Record<string, unknown> = {},
		view: Record<string, unknown> = {},
	) =>
		({
			kind: "dispatch",
			mode: "parallel",
			writers: 1,
			requests: [{ agentId: "coder", task: "Edit the module." }],
			planView: {
				topology: "parallel",
				taskCount: 1,
				planScale: true,
				text: "",
				hash: "",
				tasks: [{ agent: "coder", task: "Edit the module.", routeApproval, agentDecision: null, ...view }],
				...plan,
			},
		}) as unknown as DispatchExecutionSnapshot;

	it("lets a re-planned route bound shrink and never grow", () => {
		strictEqual(dispatchRewriteNarrows(snapshot(route), snapshot({ ...route, maxAttempts: 1 })), true);
		strictEqual(dispatchRewriteNarrows(snapshot(route), snapshot({ ...route, maxAttempts: 3 })), false);
		strictEqual(dispatchRewriteNarrows(snapshot(route), snapshot({ ...route, totalCostUpperBoundUsd: 5 })), false);
	});

	it("holds every host-derived field outside the intent", () => {
		strictEqual(dispatchRewriteNarrows(snapshot(route), snapshot(route, {}, { agentDecision: { mode: "x" } })), false);
		strictEqual(dispatchRewriteNarrows(snapshot(route), snapshot(route, { costCeilingUsd: 9 })), false);
	});
});

describe("the read scope of a rewritten splice task", () => {
	// WX4: a splice with no scope paths takes every parent observation, an earlier .env read included.
	const intent = (readRoots: string[]) => ({
		version: 2,
		readRoots,
		writeRoots: [],
		relevantPaths: [],
		pathProvenance: [],
		expectedOutputs: [],
		verification: [],
	});
	const seed = (selectedRefs: string[]) => ({
		provenance: { version: 1, mode: "splice", snapshotHash: "s", contentHash: selectedRefs.join(), selectedRefs },
		messages: [],
	});
	const snapshot = (readRoots: string[], selectedRefs: string[]) =>
		({
			kind: "dispatch",
			mode: "parallel",
			writers: 1,
			requests: [
				{ agentId: "coder", task: "Read the module.", intent: intent(readRoots), contextSeed: seed(selectedRefs) },
			],
			planView: { topology: "parallel", taskCount: 1, planScale: true, text: "", hash: "", tasks: [] },
		}) as unknown as DispatchExecutionSnapshot;

	it("refuses a rewrite that empties the approved scope or selects more parent results", () => {
		const approved = snapshot(["src/a/"], ["tool:read-a"]);
		strictEqual(dispatchRewriteNarrows(approved, snapshot(["src/a/b/"], ["tool:read-a"])), true);
		strictEqual(dispatchRewriteNarrows(approved, snapshot([], ["tool:read-a"])), false);
		strictEqual(dispatchRewriteNarrows(approved, snapshot(["src/a/b/"], ["tool:read-a", "tool:read-env"])), false);
	});
});

describe("parallel worktree tasks with overlapping write roots", () => {
	it("warn once on the bus and still start", async () => {
		const bus = createTelemetryHub();
		const notices: Array<{ code: string; message: string }> = [];
		bus.subscribe("run.scope_notice_raised", (notice) => {
			notices.push(notice);
		});
		let started = 0;
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }), autonomy: () => "default" });
		registry.register(
			createDispatchTool({
				bus,
				dispatch: {
					derivedGrants: () => ({ requestedActions: ["read"], mcp: null }),
					dispatchBatch: async (requests: ReadonlyArray<DispatchRequest>) => {
						started += requests.length;
						throw new Error("stub workers");
					},
				} as unknown as DispatchContract,
				getAgentSpecs: () => [{ id: "coder", capabilityClass: "workspace-edit" }] as never,
			}),
		);
		const tasks = [
			{ task: "Edit the module.", intent: { write_roots: ["src/"] } },
			{ task: "Edit the parser.", intent: { write_roots: ["src/parser/"] } },
			{ task: "Edit the docs.", intent: { write_roots: ["docs/"] } },
		];
		registry.onPermissionRequired((_call, decision, meta) => {
			void registry.resumeParkedCalls({
				actionClass: decision.classification.actionClass,
				requestId: meta.requestId,
				requestedBy: "tool:one_shot",
			});
		});
		await registry.invoke({ tool: "dispatch", args: { agent: "coder", worktree: true, tasks } });
		strictEqual(started, 3);
		deepStrictEqual(
			notices.map((notice) => notice.code),
			["write_roots_overlap"],
		);
		match(notices[0]?.message ?? "", /task 1 \(coder\) and task 2 \(coder\): \S*src ~ \S*src\/parser$/u);
	});
});

// EX-4: a hook's `ask` is an approval request through the same card, grant and refusal path as any ask.
describe("a before_tool hook that asks for approval", () => {
	function asking(deps: Partial<RegistryDeps> = {}) {
		let hookRuns = 0;
		const middleware = createMiddlewareBundle({
			registrations: [
				{
					id: "user:env-guard",
					description: "asks before .env is touched",
					hooks: ["before_tool"],
					evaluate: () => {
						hookRuns += 1;
						return [{ kind: "request_approval", reason: "reads .env" }];
					},
				},
			],
		}).contract;
		const registry = createRegistry({
			safety: createWorkerSafety({ cwd: process.cwd() }),
			autonomy: () => "default",
			middleware,
			...deps,
		});
		const ran: string[] = [];
		const tool = (name: ToolSpec["name"], baseActionClass: ToolSpec["baseActionClass"]): ToolSpec => ({
			name,
			description: `fake ${name}`,
			parameters: {} as ToolSpec["parameters"],
			baseActionClass,
			async run() {
				ran.push(name);
				return { kind: "ok", output: "ran" };
			},
		});
		registry.register(tool(ToolNames.Read, "read"));
		registry.register(tool(ToolNames.Bash, "execute"));
		registry.register({
			...tool(ToolNames.ConfigureClio, "write"),
			confirmationRuleId: "fleet-routing-settings",
		});
		const cards: SafetyDecision[] = [];
		const answer = (approve: boolean) =>
			registry.onPermissionRequired((_call, decision, meta) => {
				cards.push(decision);
				if (approve)
					void registry.resumeParkedCalls({
						actionClass: decision.classification.actionClass,
						requestId: meta.requestId,
						requestedBy: "tool:one_shot",
					});
				else registry.cancelParkedCall(meta.requestId, "operator denied");
			});
		return { registry, ran, cards, answer, hookRuns: () => hookRuns };
	}
	const cardText = (decision: SafetyDecision | undefined): string =>
		decision?.kind === "ask" ? `${decision.rejection.short} ${decision.rejection.detail}` : "";

	it("parks a call admission allowed on the operator card, runs it once approved, and runs its hooks once", async () => {
		const probe = asking();
		probe.answer(true);
		const verdict = await probe.registry.invoke({ tool: ToolNames.Read, args: { path: "notes.md" } });
		strictEqual(verdict.kind, "ok", JSON.stringify(verdict));
		deepStrictEqual(probe.ran, [ToolNames.Read]);
		strictEqual(probe.cards.length, 1);
		strictEqual(probe.cards[0]?.kind, "ask");
		match(cardText(probe.cards[0]), /reads \.env/);
		strictEqual(probe.hookRuns(), 1, "the approved call reuses what its hooks decided");
	});

	it("refuses the call when the operator denies the card, without running it", async () => {
		const probe = asking();
		probe.answer(false);
		const verdict = await probe.registry.invoke({ tool: ToolNames.Read, args: { path: "notes.md" } });
		strictEqual(verdict.kind, "blocked");
		deepStrictEqual(probe.ran, []);
		strictEqual(probe.hookRuns(), 1);
	});

	it("refuses it headless, where no operator can answer, like any ask", async () => {
		const probe = asking();
		const verdict = await probe.registry.invoke({ tool: ToolNames.Read, args: { path: "notes.md" } });
		strictEqual(verdict.kind, "blocked");
		match(JSON.stringify(verdict), /"ruleId":"middleware-hook-ask"/, "the refusal names the hook's rail");
		match(JSON.stringify(verdict), /a hook asked \(reads \.env\)/, "and why the hook asked");
		deepStrictEqual(probe.ran, []);
	});

	it("routes it to the safety judge under contained yolo, like any ask", async () => {
		const judge = (outcome: SafetyJudgeOutcome) => {
			const reviewed: string[] = [];
			const seat: SafetyJudgeSeat = {
				review: (subject) => {
					reviewed.push(cardText(subject.decision));
					return outcome;
				},
				operatorApproved: () => {},
			};
			return { seat, reviewed };
		};
		const allow = judge({ kind: "allow", rule: "operator-named", reason: "asked", build: "b", latencyMs: 0 });
		const allowed = asking({ safetyJudge: allow.seat, unattendedAsks: () => true });
		const released = await allowed.registry.invoke({ tool: ToolNames.Read, args: { path: "notes.md" } });
		strictEqual(released.kind, "ok", JSON.stringify(released));
		deepStrictEqual(allowed.ran, [ToolNames.Read]);
		strictEqual(allow.reviewed.length, 1);
		match(allow.reviewed[0] ?? "", /reads \.env/);
		strictEqual(allowed.hookRuns(), 1);
		const block = judge({
			kind: "block",
			rule: "secrets",
			refusal: "no",
			allowedBy: "the operator",
			build: "b",
			latencyMs: 0,
		} as SafetyJudgeOutcome);
		const blocked = asking({ safetyJudge: block.seat, unattendedAsks: () => true });
		strictEqual((await blocked.registry.invoke({ tool: ToolNames.Read, args: { path: "notes.md" } })).kind, "blocked");
		deepStrictEqual(blocked.ran, []);
		const unjudged = asking({ unattendedAsks: () => true });
		unjudged.answer(true);
		strictEqual((await unjudged.registry.invoke({ tool: ToolNames.Read, args: { path: "notes.md" } })).kind, "blocked");
		deepStrictEqual(unjudged.cards, [], "contained yolo never parks an ask");
	});

	it("asks once for a call admission already parked, since the operator's approval answers both", async () => {
		const probe = asking();
		probe.answer(true);
		const verdict = await probe.registry.invoke({ tool: ToolNames.ConfigureClio, args: { action: "preview" } });
		strictEqual(verdict.kind, "ok", JSON.stringify(verdict));
		strictEqual(probe.cards.length, 1);
		doesNotMatch(cardText(probe.cards[0]), /a hook asked/, "the one card is admission's own");
		deepStrictEqual(probe.ran, [ToolNames.ConfigureClio]);
		strictEqual(probe.hookRuns(), 1);
	});
});
