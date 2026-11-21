import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import {
	parseRunCliArgs,
	requestedRunLimits,
	sandboxRequiredRefusal,
	taskFileAuthorityRefusal,
} from "../../src/cli/args.js";
import { runClioRun } from "../../src/cli/run.js";
import { runLimitsV2, startRefusalCause } from "../../src/cli/run-failure.js";
import { dryRunPricingRefusal } from "../../src/cli/run-plan.js";
import { readSettings, validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { pinRunSettings, RUN_OVERRIDES_ENV, requirePricedRefusal } from "../../src/core/run-overrides.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import { factKnownValue } from "../../src/core/telemetry/known.js";
import type { CallStarted } from "../../src/core/telemetry/schemas.js";
import type { SpawnedWorker, SpawnedWorkerResult, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { calculatePricingCostUsd, resolveEffectivePricing } from "../../src/domains/providers/catalog.js";
import inception from "../../src/domains/providers/runtimes/cloud/inception.js";
import { createRunCostCap, runCostCeilingUsd, sessionCeilingReached } from "../../src/domains/scheduling/budget.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import {
	loadOutputSchema,
	OUTPUT_SCHEMA_REFUSAL_PREFIX,
	structuredAnswerBody,
	structuredRepairConstraints,
	validateStructuredAnswer,
} from "../../src/session-control/structured-finish.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("clio-coder run --max-cost-usd bounds what the run adds, under any lower configured ceiling", () => {
	strictEqual(parseRunCliArgs(["--max-cost-usd", "1.5", "task"]).maxCostUsd, 1.5);
	deepStrictEqual(
		parseRunCliArgs(["--max-cost-usd", "0", "task"]).diagnostics.map((entry) => entry.message),
		["--max-cost-usd must be a positive number of US dollars"],
	);
	// With --agent it bounds that one worker run (SPEC 6.9), and --worktree is an --agent flag.
	deepStrictEqual(parseRunCliArgs(["--agent", "scout", "--max-cost-usd", "0.01", "--worktree", "x"]).diagnostics, []);
	deepStrictEqual(
		parseRunCliArgs(["--worktree", "x"]).diagnostics.map((entry) => entry.message),
		["fleet dispatch flags require --agent <recipe-id>"],
	);
	// A continued session already spent $2; the run may add $1.50 more.
	const ceiling = runCostCeilingUsd({ spentUsd: 2, runMaxUsd: 1.5, configuredUsd: 0 });
	strictEqual(ceiling, 3.5);
	strictEqual(sessionCeilingReached(3.49, ceiling), false);
	strictEqual(sessionCeilingReached(3.5, ceiling), true);
	strictEqual(runCostCeilingUsd({ spentUsd: 2, runMaxUsd: 1.5, configuredUsd: 3 }), 3);
});

describe("--max-cost-usd and parallel dispatches", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("stops running workers at the cap, so two together pass it by at most one call each", async () => {
		const capUsd = 1;
		const callUsd = 0.3;
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.safety.limits.sessionCostUsd = capUsd;
		// Each worker would spend $3 over ten calls if nothing stopped it.
		const pricedWorker = (spec: WorkerSpec): SpawnedWorker => {
			let aborted = false;
			let settle!: (result: SpawnedWorkerResult) => void;
			const promise = new Promise<SpawnedWorkerResult>((resolve) => {
				settle = resolve;
			});
			return {
				pid: null,
				promise,
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {
					aborted = true;
				},
				send: () => true,
				events: (async function* () {
					for (let call = 0; call < 10; call++) {
						await new Promise((resolve) => setImmediate(resolve));
						if (aborted) break;
						// The run's spend reaches the host as call telemetry, the one source its meter reads (#434).
						const context = spec.telemetryContext;
						ok(context);
						const started: CallStarted = {
							callId: newCallId(),
							attemptId: newAttemptId(),
							attempt: 0,
							roundKind: "normal",
							toolChoice: "auto",
							target: {
								targetId: "fixture",
								runtimeId: "fixture",
								api: "fixture",
								requestedModel: "fixture",
								reportedModel: { kind: "unknown", reason: "not-observed" },
							},
						};
						const message = {
							role: "assistant",
							stopReason: "toolUse",
							content: [],
							usage: { input: 1000, output: 100, totalTokens: 1100, cost: { total: callUsd } },
						};
						yield {
							type: "clio_coder_telemetry",
							record: {
								...makeTelemetryRecord(
									"call.settled",
									{ ...started, stages: { settle: 1 }, ...callSettlementFromMessage(message, "target-rates") },
									{ ...context, callId: started.callId, attemptId: started.attemptId },
									{ t: new Date().toISOString(), mono: call },
								),
								origin: { host: "local-worker", pid: 42, birthToken: "fixture", monoEpochWallMs: 0 },
							},
						};
						yield { type: "message_end", message };
					}
					settle(aborted ? { exitCode: null, signal: "SIGTERM" } : { exitCode: 0, signal: null });
				})(),
			};
		};
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				settings,
				scheduling: {
					ceilingUsd: () => capUsd,
					preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: capUsd }),
					runCostCap: () => createRunCostCap(0, capUsd),
				},
			}),
			{ heartbeatIntervalMs: 3_600_000, spawnWorker: pricedWorker },
		);
		await bundle.extension.start();
		try {
			const request = {
				agentId: "scout",
				executionRole: "explorer" as const,
				task: "Inspect which functions lib/math.js exports.",
				requestOrigin: "internal" as const,
			};
			const runs = await Promise.all([bundle.contract.dispatch(request), bundle.contract.dispatch(request)]);
			const receipts = await Promise.all(runs.map((run) => run.finalPromise));
			const spentUsd = receipts.reduce((sum, receipt) => sum + factKnownValue(receipt.spend.pricing.usd), 0);
			// The documented bound: the cap plus one in-flight call per running worker, to 1e-9 USD.
			ok(spentUsd <= capUsd + 2 * callUsd + 1e-9, `spent ${spentUsd}`);
			for (const receipt of receipts) {
				strictEqual(receipt.outcome, "canceled");
				match(receipt.outcomeDetail ?? "", /--max-cost-usd \$1\.00 cap/u);
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

test("the --trust-task-file gate refuses verify, yolo and cwd in an untrusted envelope and nothing else", () => {
	strictEqual(taskFileAuthorityRefusal({ task: "x", model: "m" }, false), undefined);
	strictEqual(taskFileAuthorityRefusal({ task: "x", permissions: { autonomy: "default" } }, false), undefined);
	match(taskFileAuthorityRefusal({ task: "x", verify: [] }, false) ?? "", /carries verify,.*--trust-task-file/);
	match(
		taskFileAuthorityRefusal({ task: "x", cwd: "/w", permissions: { autonomy: "yolo" } }, false) ?? "",
		/carries permissions\.autonomy yolo, cwd/,
	);
	strictEqual(taskFileAuthorityRefusal({ task: "x", verify: [], cwd: "/w" }, true), undefined);
});

test("--agent --max-cost-usd 0.01 is a requested, enforced limit whose overshoot is possible (SPEC 6.9)", () => {
	const parsed = parseRunCliArgs(["--agent", "scout", "--max-cost-usd", "0.01", "x"]);
	deepStrictEqual(runLimitsV2(requestedRunLimits(parsed)), {
		requested: { maxCostUsd: 0.01 },
		enforced: ["maxCostUsd"],
		cost: { overshootPossible: true, unpricedCalls: 0, unpricedRoutes: [] },
	});
	strictEqual(runLimitsV2(requestedRunLimits(parseRunCliArgs(["x"]))), undefined);
});

test("--sandbox required: only required parses, it pins safety.sandbox, and a host without a sandbox is refused", () => {
	strictEqual(parseRunCliArgs(["--sandbox", "required", "x"]).sandboxRequired, true);
	match(parseRunCliArgs(["--sandbox", "off", "x"]).diagnostics[0]?.message ?? "", /accepts only required/);
	const pinned = { [RUN_OVERRIDES_ENV]: JSON.stringify({ sandbox: "required" }) };
	for (const mode of ["off", "auto", "required"] as const) {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.sandbox = mode;
		strictEqual(pinRunSettings(settings, pinned).safety.sandbox, "required");
	}
	const untouched = structuredClone(DEFAULT_SETTINGS);
	untouched.safety.sandbox = "off";
	strictEqual(pinRunSettings(untouched, {}).safety.sandbox, "off");
	strictEqual(sandboxRequiredRefusal({ available: true, reason: null }), undefined);
	match(
		sandboxRequiredRefusal({ available: false, reason: "bubblewrap (bwrap) is not installed" }) ?? "",
		/--sandbox required, but no OS sandbox .*bwrap/,
	);
});

test("--require-priced: parsed into limits, carried to admission, and refuses only an unpriced route", () => {
	const parsed = parseRunCliArgs(["--require-priced", "--no-delegate", "x"]);
	strictEqual(parsed.requirePriced, true);
	deepStrictEqual(runLimitsV2(requestedRunLimits(parsed))?.enforced, ["requirePriced"]);
	const required = { [RUN_OVERRIDES_ENV]: JSON.stringify({ requirePriced: true }) };
	match(
		requirePricedRefusal("none", "proxy/gpt-x", required) ?? "",
		/^--require-priced: proxy\/gpt-x has no known pricing; declare targets\[\]\.pricing/,
	);
	for (const pricedBy of ["catalog", "target-rates", "free"])
		strictEqual(requirePricedRefusal(pricedBy, "t/m", required), undefined);
	strictEqual(requirePricedRefusal("none", "proxy/gpt-x", {}), undefined);
});

test("--dry-run --require-priced refuses an unpriced route exactly as the run would, instead of previewing it (CLI-P16)", async (t) => {
	const home = await isolateClioEnv("clio-dry-run-require-priced-");
	const original = process.cwd();
	const cwd = path.join(home.dir, "workspace");
	mkdirSync(path.join(home.dir, "config"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(
		path.join(home.dir, "config", "settings.yaml"),
		"version: 2\ntargets:\n  - { id: proxy, runtime: litellm, url: 'http://127.0.0.1:9', defaultModel: gpt-x }\nchat:\n  target: proxy\n  model: gpt-x\n",
	);
	let stderr = "";
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	process.chdir(cwd);
	try {
		const code = await runClioRun(["--dry-run", "--require-priced", "--no-delegate", "x"], { noContextFiles: true });
		strictEqual(code, 2, stderr);
		match(stderr, /--require-priced: routes this run can reach have no known pricing: proxy\/gpt-x; declare targets/u);
		// SPEC 6.9: declaring the pricing is the fix, so the preflight's refusal is not_configured at its source.
		const args = parseRunCliArgs(["--dry-run", "--require-priced", "--no-delegate", "x"]);
		const refusal = await dryRunPricingRefusal(args, readSettings());
		strictEqual(refusal?.slug, "not_configured");
		strictEqual(startRefusalCause(refusal).code, "not_configured");
	} finally {
		process.chdir(original);
		home.restore();
	}
});

test("--require-priced admits a mercury-3 run and --max-cost-usd bounds it at Inception list rates (PV-6)", async () => {
	const home = await isolateClioEnv("clio-mercury-priced-");
	const raw = {
		version: 2,
		targets: [{ id: "inception", runtime: "inception", defaultModel: "mercury-3" }],
		chat: { target: "inception", model: "mercury-3" },
	};
	mkdirSync(path.join(home.dir, "config"), { recursive: true });
	writeFileSync(path.join(home.dir, "config", "settings.yaml"), JSON.stringify(raw));
	try {
		const parsed = parseRunCliArgs(["--require-priced", "--max-cost-usd", "1", "--no-delegate", "x"]);
		const { settings, issues } = validateSettings(raw);
		deepStrictEqual(issues, []);
		strictEqual(await dryRunPricingRefusal(parsed, settings), undefined);
		const target = settings.targets[0];
		ok(target);
		const { rates, pricedBy } = resolveEffectivePricing(target, inception, "mercury-3");
		strictEqual(pricedBy, "catalog");
		deepStrictEqual(rates, { input: 0.2, output: 0.7, cacheRead: 0.02, cacheWrite: 0 });
		// One call: 1M fresh input, 500K cache read, 100K output is $0.28 at list, half that at the launch discount.
		const callUsd = calculatePricingCostUsd(rates, { input: 1_000_000, cacheRead: 500_000, output: 100_000 });
		ok(Math.abs(callUsd - 0.28) < 1e-12, `call ${callUsd}`);
		const ceiling = runCostCeilingUsd({ spentUsd: 0, runMaxUsd: parsed.maxCostUsd ?? 0, configuredUsd: 0 });
		strictEqual(sessionCeilingReached(3 * callUsd, ceiling), false);
		strictEqual(sessionCeilingReached(4 * callUsd, ceiling), true);
	} finally {
		home.restore();
	}
});

test("--output-schema: refused schemas are schema_unsupported, and only a whole JSON answer validates (SPEC 6.8)", async () => {
	strictEqual(parseRunCliArgs(["--output-schema", "s.json", "x"]).outputSchema, "s.json");
	strictEqual(parseRunCliArgs(["--output-schema=s.json", "x"]).outputSchema, "s.json");
	const dir = mkdtempSync(path.join(tmpdir(), "output-schema-"));
	const file = (name: string, body: string): string => {
		const full = path.join(dir, name);
		writeFileSync(full, body);
		return full;
	};
	const big: Record<string, unknown> = {};
	for (let i = 0; i < 4000; i++) big[`k${i}`] = { type: "string" };
	for (const refused of [
		file("array.json", '{"type":"array"}'),
		file("bool.json", "true"),
		file("remote.json", '{"type":"object","properties":{"a":{"$ref":"https://x.test/s.json"}}}'),
		file("big.json", JSON.stringify({ type: "object", properties: big })),
	]) {
		const loaded = await loadOutputSchema(refused);
		ok(!loaded.ok, refused);
		if (!loaded.ok)
			strictEqual(
				startRefusalCause({ slug: loaded.slug, message: `${OUTPUT_SCHEMA_REFUSAL_PREFIX}${loaded.reason}` }).code,
				"schema_unsupported",
			);
	}
	const loaded = await loadOutputSchema(
		file(
			"ok.json",
			'{"type":"object","description":"d","properties":{"n":{"$ref":"#/$defs/N"},"e":{"enum":["a","b"]}},"required":["n"],"$defs":{"N":{"type":"integer"}}}',
		),
	);
	ok(loaded.ok);
	if (!loaded.ok) return;
	deepStrictEqual(await validateStructuredAnswer(loaded.schema, '```json\n{"n":1}\n```'), {
		ok: true,
		value: { n: 1 },
		json: '{"n":1}',
	});
	strictEqual(structuredAnswerBody('Here it is: {"n":1}'), 'Here it is: {"n":1}');
	strictEqual((await validateStructuredAnswer(loaded.schema, 'Here it is: {"n":1}')).ok, false);
	strictEqual((await validateStructuredAnswer(loaded.schema, '{"n":"one"}')).ok, false);
	strictEqual((await validateStructuredAnswer(loaded.schema, '{"n":1,"e":"c"}')).ok, false);
	deepStrictEqual(structuredRepairConstraints(undefined).allowedTools, []);
});
