import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings, recordYoloConfinementOnce, settingsPath } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import type { ConfigContract } from "../../src/domains/config/index.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import { runMiddlewareRegistrations } from "../../src/domains/middleware/runtime.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import { renderSessionPostureUpdate } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { admissionAutonomy, effectiveYoloConfinement } from "../../src/domains/safety/autonomy.js";
import {
	createAutonomyWindow,
	describeOpenDecision,
	type OpenDecision,
} from "../../src/domains/safety/autonomy-window.js";
import { projectScriptConsequences } from "../../src/domains/safety/call-consequence.js";
import type { CompletionEvaluationInput } from "../../src/domains/safety/decision-events.js";
import {
	CONTAINED_YOLO_CHECK_WAIVER,
	createFinishContractRegistration,
} from "../../src/domains/safety/finish-contract-registration.js";
import { parseRigorOverride, rigorResolution } from "../../src/domains/safety/rigor.js";
import {
	createSafetyJudge,
	type SafetyJudgeConfig,
	type SafetyJudgeNote,
} from "../../src/domains/safety/safety-judge.js";
import { SessionCostCeilingError } from "../../src/domains/scheduling/budget.js";
import { createSchedulingBundle } from "../../src/domains/scheduling/extension.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import {
	createYoloActivation,
	YOLO_UNCONFINED_ACCEPT_LABEL,
	YOLO_UNCONFINED_DECLINE_LABEL,
} from "../../src/interactive/yolo-activation.js";
import { createTurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import {
	createRegistry,
	type PermissionRequiredMeta,
	type RegistryDeps,
	type ToolSpec,
} from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const CONFIG: SafetyJudgeConfig = { enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] };
const UNRECOGNIZED = "./scripts/sync-assets --all";

/**
 * The operator's main-session registry at contained yolo, wired as the
 * orchestrator wires it: admission at `default`, and asks never parked.
 */
function containedRegistry(
	reply: () => string,
	observe: Pick<RegistryDeps, "onUnattendedRefusal"> & { note?: (note: SafetyJudgeNote) => void } = {},
) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-contained-yolo-")));
	let judged = 0;
	const judge = createSafetyJudge({
		config: () => CONFIG,
		complete: async () => {
			judged += 1;
			return { text: reply() };
		},
		operatorMessages: () => ["sync the assets"],
		session: () => "session-1",
		consequences: () => [],
		...(observe.note !== undefined ? { note: observe.note } : {}),
	});
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => admissionAutonomy("yolo", "contained"),
		safetyJudge: judge,
		unattendedAsks: () => true,
		...(observe.onUnattendedRefusal !== undefined ? { onUnattendedRefusal: observe.onUnattendedRefusal } : {}),
	});
	const ran: string[] = [];
	const tool = (name: ToolSpec["name"], extra: Partial<ToolSpec> = {}): ToolSpec => ({
		name,
		description: `fake ${name}`,
		parameters: {} as ToolSpec["parameters"],
		baseActionClass: "execute",
		async run(args) {
			ran.push(String(args.command ?? name));
			return { kind: "ok", output: "ran" };
		},
		...extra,
	});
	registry.register(tool(ToolNames.Bash));
	registry.register(
		tool(ToolNames.ConfigureClio, { baseActionClass: "write", confirmationRuleId: "fleet-routing-settings" }),
	);
	const parks: PermissionRequiredMeta[] = [];
	registry.onPermissionRequired((_call, _decision, meta) => parks.push(meta));
	return { registry, ran, parks, judged: () => judged };
}

test("confinement resolves to contained unless unconfined is both chosen and accepted", async (t) => {
	// A Clio bash child exports the confinement pin; isolate so the case reads only settings.
	const home = await isolateClioEnv("clio-yolo-confinement-resolve-");
	t.after(() => home.restore());
	const safety = DEFAULT_SETTINGS.safety;
	strictEqual(effectiveYoloConfinement(safety), "contained");
	strictEqual(effectiveYoloConfinement({ ...safety, yoloConfinement: "unconfined" }), "contained");
	strictEqual(
		effectiveYoloConfinement({ ...safety, yoloConfinement: "unconfined", yoloUnconfinedAccepted: true }),
		"unconfined",
	);
	strictEqual(admissionAutonomy("yolo", "contained"), "default");
	strictEqual(admissionAutonomy("yolo", "unconfined"), "yolo");
	strictEqual(admissionAutonomy("default", "unconfined"), "default");
});

test("contained yolo runs what the judge allows and refuses what it blocks", async () => {
	const allowed = containedRegistry(() => JSON.stringify({ verdict: "allow", rule: "operator-named", reason: "asked" }));
	strictEqual((await allowed.registry.invoke({ tool: ToolNames.Bash, args: { command: UNRECOGNIZED } })).kind, "ok");
	deepStrictEqual(allowed.ran, [UNRECOGNIZED]);

	const blocked = containedRegistry(() => JSON.stringify({ verdict: "block", rule: "publish", reason: "uploads" }));
	const verdict = await blocked.registry.invoke({ tool: ToolNames.Bash, args: { command: UNRECOGNIZED } });
	strictEqual(verdict.kind, "blocked");
	if (verdict.kind === "blocked") strictEqual(verdict.denial?.code, "safety-judge:publish");
	deepStrictEqual([blocked.ran, blocked.parks.length], [[], 0]);
});

test("contained yolo refuses a call the judge left without a verdict instead of parking it, and remembers it", async () => {
	const { registry, ran, parks, judged } = containedRegistry(() => "I am not sure.");
	const call = { tool: ToolNames.Bash, args: { command: UNRECOGNIZED } };
	const first = await registry.invoke(call, { turnId: "turn-1" });
	strictEqual(first.kind, "blocked");
	if (first.kind !== "blocked") return;
	match(first.reason, /contained yolo runs without the operator/u);
	match(first.reason, /Do not retry it/u);
	match(first.denial?.allowedBy ?? "", /contained yolo never waits/u);
	deepStrictEqual([ran, parks.length, judged()], [[], 0, 1]);

	const repeat = await registry.invoke(call, { turnId: "turn-1" });
	strictEqual(repeat.kind, "blocked");
	if (repeat.kind === "blocked") strictEqual(repeat.decision.policy?.reasonCode, "denied_repeat");
	deepStrictEqual([ran, parks.length, judged()], [[], 0, 1]);
});

test("a judge streak halts yolo only once the crossing block is recorded, inside the call that crossed it", async () => {
	// Wired as the orchestrator wires it: the registry records the refusal, the judge's escalation halts the window.
	const seen: OpenDecision[][] = [];
	let inCall = false;
	const window = createAutonomyWindow({
		caps: () => ({ toolCalls: 0, minutes: 0, tokens: 0 }),
		session: () => "session-1",
		onHalt: () => {
			ok(inCall, "the halt lands while the crossing call is still running, so it cancels that turn");
			seen.push(window.openDecisions(true));
		},
	});
	const { registry } = containedRegistry(
		() => JSON.stringify({ verdict: "block", rule: "publish", reason: "uploads" }),
		{
			onUnattendedRefusal: (call, decision, kind, rule) =>
				window.openDecision(describeOpenDecision(call, decision, kind, rule)),
			note: (note) => {
				if (note.kind === "escalation") window.haltFor("judge", "3 blocks in a row", note.workerRunId === undefined);
			},
		},
	);
	for (let i = 0; i < 3; i += 1) {
		inCall = true;
		const pending = registry.invoke({ tool: ToolNames.Bash, args: { command: `${UNRECOGNIZED} ${i}` } });
		const verdict = await pending;
		inCall = false;
		strictEqual(verdict.kind, "blocked");
	}
	strictEqual(seen.length, 1);
	strictEqual(seen[0]?.length, 3, "the notice names the block that crossed the line");
	strictEqual(window.halted()?.kind, "judge");
});

test("a throwing refusal observer never changes contained yolo's denial or its bookkeeping", async () => {
	const { registry } = containedRegistry(() => "I am not sure.", {
		onUnattendedRefusal: () => {
			throw new Error("observer failed");
		},
	});
	const call = { tool: ToolNames.Bash, args: { command: UNRECOGNIZED } };
	const first = await registry.invoke(call, { turnId: "turn-1" });
	strictEqual(first.kind, "blocked");
	if (first.kind === "blocked") match(first.reason, /contained yolo runs without the operator/u);
	const repeat = await registry.invoke(call, { turnId: "turn-1" });
	strictEqual(repeat.kind, "blocked");
	if (repeat.kind === "blocked") strictEqual(repeat.decision.policy?.reasonCode, "denied_repeat");

	const blocked = containedRegistry(() => JSON.stringify({ verdict: "block", rule: "publish", reason: "uploads" }), {
		onUnattendedRefusal: () => {
			throw new Error("observer failed");
		},
	});
	const verdict = await blocked.registry.invoke({ tool: ToolNames.Bash, args: { command: UNRECOGNIZED } });
	strictEqual(verdict.kind, "blocked");
	if (verdict.kind === "blocked") strictEqual(verdict.denial?.code, "safety-judge:publish");
});

test("contained yolo refuses an operator-only ask without the judge or a card", async () => {
	const { registry, ran, parks, judged } = containedRegistry(() =>
		JSON.stringify({ verdict: "allow", rule: "x", reason: "y" }),
	);
	const verdict = await registry.invoke({ tool: ToolNames.ConfigureClio, args: { action: "apply", proposalId: "p" } });
	strictEqual(verdict.kind, "blocked");
	if (verdict.kind === "blocked") match(verdict.reason, /contained yolo runs without the operator/u);
	deepStrictEqual([ran, parks.length, judged()], [[], 0, 0]);
});

test("contained yolo runs a plan-scale dispatch without the judge or a card", async () => {
	const { registry, parks, judged } = containedRegistry(() => "unused");
	const runs: string[] = [];
	registry.register({
		name: ToolNames.Dispatch,
		description: "stub dispatch",
		parameters: {} as ToolSpec["parameters"],
		baseActionClass: "dispatch",
		async run() {
			runs.push("dispatched");
			return { kind: "ok", output: "dispatched" };
		},
	});
	const plan = {
		tasks: [
			{ agent: "scout", task: "Survey the soil samples" },
			{ agent: "writer", task: "Draft the comparison report" },
		],
	};
	strictEqual((await registry.invoke({ tool: ToolNames.Dispatch, args: plan })).kind, "ok");
	deepStrictEqual([runs, parks.length, judged()], [["dispatched"], 0, 0]);
});

test("the unconfined prompt body appears only at effective unconfined yolo", () => {
	const table = loadFragments();
	const contained = renderSessionPostureUpdate(table, "yolo", { coordinatorCapabilities: [] });
	const unconfined = renderSessionPostureUpdate(table, "yolo", {
		coordinatorCapabilities: [],
		yoloConfinement: "unconfined",
	});
	match(contained, /Yolo is contained/u);
	doesNotMatch(contained, /Yolo mode \(unconfined\)/u);
	match(unconfined, /Yolo mode \(unconfined\)/u);
	doesNotMatch(unconfined, /Yolo is contained/u);
});

test("the unconfined prompt says how an outward command leaves a required sandbox", () => {
	const unconfined = renderSessionPostureUpdate(loadFragments(), "yolo", {
		coordinatorCapabilities: [],
		yoloConfinement: "unconfined",
	});
	match(unconfined, /outward command[^.]*leaves it only on a line of its own with literal arguments/u);
	match(unconfined, /--body-file/u);
});

test("choosing unconfined yolo asks its own card and records the acceptance only on accept", async (t) => {
	const home = await isolateClioEnv("clio-yolo-unconfined-accept-");
	t.after(() => home.restore());
	const harness = (answer: string | null) => {
		let settings = structuredClone(readSettings());
		settings.safety.autonomy = "yolo";
		settings.safety.yoloAccepted = true;
		const commits: Array<[string, unknown, string]> = [];
		const activation = createYoloActivation({
			getSettings: () => settings,
			refusal: null,
			commitSetting: (id, next, scope) => {
				commits.push([
					id,
					id === "safety.yoloConfinement" ? next.safety.yoloConfinement : next.safety.yoloUnconfinedAccepted,
					scope,
				]);
				settings = structuredClone(next);
			},
			ask: async () =>
				answer === null
					? { answers: [], cancelled: true }
					: { answers: [{ question: "Unconfined yolo", answer, options: [answer] }] },
			prepareScreen: () => {},
			notify: () => {},
		});
		const choose = async () => {
			const next = structuredClone(settings);
			next.safety.yoloConfinement = "unconfined";
			activation.commit("safety.yoloConfinement", next, "global");
			for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
		};
		return { choose, commits };
	};
	const declined = harness(YOLO_UNCONFINED_DECLINE_LABEL);
	await declined.choose();
	deepStrictEqual(declined.commits, []);
	const cancelled = harness(null);
	await cancelled.choose();
	deepStrictEqual(cancelled.commits, []);
	const accepted = harness(YOLO_UNCONFINED_ACCEPT_LABEL);
	await accepted.choose();
	deepStrictEqual(accepted.commits, [
		["safety.yoloUnconfinedAccepted", true, "global"],
		["safety.yoloConfinement", "unconfined", "global"],
	]);
});

test("a project layer cannot set yolo confinement or its acceptance", async (t) => {
	const home = await isolateClioEnv("clio-yolo-confinement-project-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(join(home.dir, "config", "settings.yaml"), "version: 2\nsafety:\n  autonomy: yolo\n");
	writeFileSync(
		join(workspace, ".clio-coder", "settings.local.yaml"),
		"safety:\n  yoloConfinement: unconfined\n  yoloUnconfinedAccepted: true\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	if (!snapshot.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const layered = readLayeredSettings(workspace);
	strictEqual(layered.settings.safety.yoloConfinement, "contained");
	strictEqual(layered.settings.safety.yoloUnconfinedAccepted, false);
	const paths = layered.issues.filter((issue) => issue.origin === "project.local").map((issue) => issue.path);
	deepStrictEqual(paths.sort(), ["safety.yoloConfinement", "safety.yoloUnconfinedAccepted"]);
});

test("the contained migration records the confinement once and keeps an operator's own choice", async (t) => {
	const home = await isolateClioEnv("clio-yolo-confinement-migration-");
	t.after(() => home.restore());
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(settingsPath(), "version: 2\nsafety:\n  autonomy: yolo\n  yoloAccepted: true\n");
	strictEqual(recordYoloConfinementOnce(), true);
	match(readFileSync(settingsPath(), "utf8"), /yoloConfinement: contained/u);
	strictEqual(recordYoloConfinementOnce(), false);
	writeFileSync(settingsPath(), "version: 2\nsafety:\n  yoloConfinement: unconfined\n");
	strictEqual(recordYoloConfinementOnce(), false);
	match(readFileSync(settingsPath(), "utf8"), /yoloConfinement: unconfined/u);
});

test("contained yolo runs an outward call the judge allows only when the operator named it", async () => {
	const push = { tool: ToolNames.Bash, args: { command: "git push origin HEAD:main" } };
	const named = containedRegistry(() => JSON.stringify({ verdict: "allow", rule: "operator-named", reason: "asked" }));
	strictEqual((await named.registry.invoke(push)).kind, "ok");

	const inferred = containedRegistry(() =>
		JSON.stringify({ verdict: "allow", rule: "workspace", reason: "serves the task" }),
	);
	const verdict = await inferred.registry.invoke(push, { turnId: "turn-1" });
	strictEqual(verdict.kind, "blocked");
	if (verdict.kind === "blocked") {
		match(verdict.reason, /contained yolo runs without the operator/u);
		match(
			verdict.decision.kind === "allow" ? "" : verdict.decision.rejection.detail,
			/allowed this outward call under rule workspace/u,
		);
	}
	deepStrictEqual([inferred.ran, inferred.parks.length, inferred.judged()], [[], 0, 1]);
});

test("contained yolo refuses a Scout external read root without a card", async () => {
	const { registry, parks } = containedRegistry(() => "unused");
	strictEqual(await registry.requestReadRootApproval?.("/srv/elsewhere"), null);
	strictEqual(parks.length, 0);
});

test("the judge reads the package.json body a named project script runs", () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-script-body-")));
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({ scripts: { release: "git push --force origin HEAD:main; cat .env", prerelease: "node lint.mjs" } }),
	);
	const lines = (command: string) => projectScriptConsequences({ tool: ToolNames.Bash, args: { command, cwd } });
	deepStrictEqual(lines("npm test && npm run release"), [
		'runs package.json script "release", repository data that executes as written: prerelease: node lint.mjs; release: git push --force origin HEAD:main; cat .env',
	]);
	deepStrictEqual(lines("pnpm release"), lines("npm run release"));
	deepStrictEqual(lines("git status"), []);
});

test("contained yolo refuses a paid request at the ceiling instead of waiting for a raise", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.limits.sessionCostUsd = 1;
	const config = { get: () => settings, onChange: () => () => {} } as unknown as ConfigContract;
	const spent = { usd: 1.25, estimated: false, unpriced: false, ref: null };
	const telemetry = { sessionSpend: () => spent, settledSessionSpend: async () => spent };
	const { contract, extension } = createSchedulingBundle({
		bus: createTelemetryHub(),
		getContract: (<T>(name: string) =>
			(name === "config" ? config : name === "telemetry" ? telemetry : undefined) as T | undefined) as never,
	});
	await extension.start?.();
	try {
		let contained = true;
		contract.setNeverWaitForRaise?.(() => contained);
		await rejects(contract.admitPaidRequest?.({ waitForRaise: true }) ?? Promise.resolve(), SessionCostCeilingError);
		contained = false;
		const controller = new AbortController();
		const held = contract.admitPaidRequest?.({ waitForRaise: true, signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort(new Error("operator left"));
		await rejects(held ?? Promise.resolve(), /operator left/u);
	} finally {
		await extension.stop?.();
	}
});

test("contained yolo raises rigor to high, and an explicit CLIO_CODER_RIGOR still wins", () => {
	const cwd = mkdtempSync(join(tmpdir(), "clio-contained-rigor-"));
	deepStrictEqual(rigorResolution({ cwd, containedYolo: true }), { rigor: "high", source: "contained-yolo" });
	deepStrictEqual(rigorResolution({ cwd, containedYolo: true, override: parseRigorOverride("normal") }), {
		rigor: "normal",
		source: "override",
	});
	strictEqual(rigorResolution({ cwd, containedYolo: false }).rigor, "normal");
});

function finishGateTurn(contained: boolean) {
	const entries: unknown[] = [
		{ kind: "message", role: "user", turnId: "user-1", payload: { text: "change the file" } },
		{
			kind: "message",
			role: "tool_call",
			turnId: "write-1",
			payload: { name: ToolNames.Write, toolCallId: "write-1", args: { path: "src/thing.ts", content: "x" } },
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "write-1",
			payload: { toolName: ToolNames.Write, toolCallId: "write-1", isError: false, result: { kind: "ok" } },
		},
	];
	const audits: CompletionEvaluationInput[] = [];
	const registration = createFinishContractRegistration({
		readSessionEntries: () => entries,
		resolveRigor: () => (contained ? "high" : "normal"),
		reserveVerificationNudge: () => contained,
		recordDecision: (input) => audits.push(input),
	});
	const state = createTurnState("off");
	// Another producer already spent the one nudge this prompt shares, and its resubmit went out.
	state.continuation.request();
	state.continuation.takeRequest();
	const footer: string[] = [];
	const nudges: string[] = [];
	const middleware = createTurnMiddleware({
		state,
		middleware: {
			runHook: (input) => {
				const result = runMiddlewareRegistrations(input, [registration]);
				for (const effect of result.effects) if (effect.kind === "request_continuation") nudges.push(effect.message);
				return result;
			},
		} as MiddlewareContract,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		emitNotice: () => {},
		emitFooterNotice: (_level, _text, key) => footer.push(key),
	});
	const runtime = {
		wireModelId: "fixture",
		runtimeId: "fixture",
		runtimeResolution: {},
		agent: { state: { tools: [{ name: ToolNames.Bash }, { name: ToolNames.Limitation }], messages: [] } },
	} as unknown as AgentRuntime;
	const finish = () =>
		middleware.fireTurnEnd(runtime, [
			{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
		] as never);
	return { state, footer, audits, nudges, finish };
}

test("contained yolo's finish gate keeps its own nudge and records an exhausted check as unverified", async () => {
	const turn = finishGateTurn(true);
	await turn.finish();
	strictEqual(turn.state.continuation.requested, true);
	strictEqual(turn.state.continuation.verificationNudgeSpent, true);
	// batch8: an operator who said "no need to run anything" gets an unverified change, not a limitation's exit 1.
	ok(turn.nudges[0]?.endsWith(CONTAINED_YOLO_CHECK_WAIVER));
	turn.state.continuation.takeRequest();
	await turn.finish();
	strictEqual(turn.state.continuation.requested, false);
	strictEqual(turn.footer.at(-1), "nudge.verification.spent");
	deepStrictEqual(
		turn.audits.map((audit) => [audit.decision, audit.rigor]),
		[
			["engage", "high"],
			["engage", "high"],
		],
	);

	const attended = finishGateTurn(false);
	await attended.finish();
	strictEqual(attended.state.continuation.requested, false);
	strictEqual(attended.state.continuation.verificationNudgeSpent, false);
});
