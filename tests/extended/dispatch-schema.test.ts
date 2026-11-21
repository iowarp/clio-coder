import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resolveWorkerSandboxSpec } from "../../src/core/sandbox/worker-policy.js";
import { renderAgentCatalogSectionsFromSpecs } from "../../src/domains/agents/catalog.js";
import { DISPATCH_JOB_TABLE_TEXT } from "../../src/domains/agents/dispatch-jobs.js";
import { discoverAgentRecipes } from "../../src/domains/agents/registry.js";
import { validateResultContract } from "../../src/domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../../src/domains/agents/result-contract-filesystem.js";
import { agentSpecPolicyErrors, normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { assessCapabilityMismatch } from "../../src/domains/dispatch/capability-match.js";
import { normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import { mergeOperatorNamedChecks, operatorNamedChecks } from "../../src/domains/dispatch/operator-checks.js";
import { scoutReadWorkspace } from "../../src/domains/dispatch/scout-workspace.js";
import { streamSimple } from "../../src/engine/ai.js";
import type { EngineModel } from "../../src/engine/types.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { dispatchRequestsFromArgs } from "../../src/tools/dispatch-arguments.js";
import {
	buildDispatchParameters,
	type DispatchSchemaComposition,
	dispatchSchemaCompositionFor,
	FULL_DISPATCH_SCHEMA_COMPOSITION,
} from "../../src/tools/dispatch-schema.js";
import type { DispatchToolDeps } from "../../src/tools/dispatch-types.js";

type Schema = { properties: Record<string, Record<string, unknown>> };

function fleetWith(overrides: Partial<typeof DEFAULT_SETTINGS.fleet>) {
	return { ...DEFAULT_SETTINGS.fleet, ...overrides };
}

function propertyNames(schema: unknown): string[] {
	return Object.keys((schema as Schema).properties);
}

function modeEnum(schema: unknown): string[] {
	const mode = (schema as Schema).properties.mode as unknown as { enum?: string[]; anyOf?: Array<{ const: string }> };
	return mode.enum ?? (mode.anyOf ?? []).map((v) => v.const);
}

describe("dispatch schema composition", () => {
	it("grants absolute intent.read_roots as read-only extra roots and still refuses an outside cwd", () => {
		const base = mkdtempSync(join(tmpdir(), "clio-coder-read-roots-"));
		try {
			const workspace = join(base, "repo");
			const outside = join(base, "reference");
			mkdirSync(join(workspace, "src"), { recursive: true });
			mkdirSync(outside, { recursive: true });
			const granted = scoutReadWorkspace({
				agentId: "coder",
				readOnlyScout: false,
				workspaceRoot: workspace,
				intent: { read_roots: ["src/", outside], write_roots: ["src/"] },
				worktree: true,
				writeRoots: undefined,
			});
			assert.ok(granted.ok);
			assert.deepEqual(granted.extraReadRoots, [realpathSync(outside)]);
			assert.deepEqual((granted.intent as { read_roots: unknown }).read_roots, ["src/"]);
			const spec = resolveWorkerSandboxSpec({
				mode: "auto",
				readOnly: false,
				cwd: workspace,
				writeBoundaries: [`${workspace}/src/`],
				network: false,
				dependencyRoots: granted.extraReadRoots ?? [],
			});
			assert.ok(spec?.readableRoots.includes(realpathSync(outside)));
			assert.ok(spec?.readOnlyPaths.includes(realpathSync(outside)));
			assert.ok(!spec?.writableRoots.includes(realpathSync(outside)));
			for (const refused of [
				{ intent: { read_roots: [join(base, "missing")] } },
				{ intent: { read_roots: [workspace] } },
				{ intent: { read_roots: ["src/"] }, cwd: outside },
			]) {
				const result = scoutReadWorkspace({
					agentId: "coder",
					readOnlyScout: false,
					workspaceRoot: workspace,
					worktree: false,
					writeRoots: undefined,
					...refused,
				});
				assert.equal(result.ok, false, JSON.stringify(refused));
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("routes explicit reviews mentioning tests to the reviewer without changing test-writing or explicit recipes", () => {
		const parsed = dispatchRequestsFromArgs(
			{
				agent: "auto",
				tasks: [
					"Review the following diff for the clsx fix. Check correctness, regression tests, and documentation.",
					"Please independently review the regression tests and README.",
					"Write regression tests for the review findings.",
					{ agent: "coder", task: "Review and fix the tests." },
				],
			},
			{ auto: { approvedAuthorities: ["read-only", "workspace-edit"], authorityBasis: "yolo-policy" } },
		);
		assert.ok(parsed.ok);
		assert.deepEqual(
			parsed.requests.map((request) => request.agentId),
			["reviewer", "reviewer", "tester", "coder"],
		);
	});

	it("resolves an omitted agent from the job table, typed write scope outranking the prose classifier (M4)", () => {
		const parsed = dispatchRequestsFromArgs(
			{
				tasks: [
					"Map the modules that read fleet config.",
					"Run the test suite and report any failures.",
					"Diagnose the crash in the parser on empty input.",
					"Fix the crash in src/parser.ts.",
					"Add a regression test for the empty-input crash.",
					{ task: "Map the modules that read fleet config.", intent: { write_roots: ["src"] } },
					"Resolve the parser crash.",
					"Where is the configuration loaded?",
					{ task: "Implement the retry flag in src/config.ts.", intent: { write_roots: [], expected_outputs: [] } },
					"Summarize the run record for run id 1yd79n91i9b0.",
					"Do this now: fix the parser crash.",
					"Can we add a retry flag to the configuration?",
					"List the fields: address, postal code, and country.",
					"List the result labels: correct, incorrect, and unknown.",
					"Why does the parser crash? Which dependency do we need to patch?",
					"Explain how the checkout service generates customer receipts.",
				],
			},
			{
				auto: { approvedAuthorities: ["read-only"], authorityBasis: "yolo-policy" },
				resolveIntent: (raw) => {
					const declared = normalizeDispatchIntent(raw, new Map());
					return declared.ok ? { ok: true, intent: declared.intent, resolvedVerification: [] } : declared;
				},
			},
		);
		assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
		assert.deepEqual(
			parsed.requests.map((request) => request.agentId),
			[
				"scout",
				"verifier",
				"debugger",
				"coder",
				"tester",
				"coder",
				"coder",
				"scout",
				"scout",
				"provenance",
				"coder",
				"coder",
				"scout",
				"scout",
				"debugger",
				"scout",
			],
		);
		// The fix family writes, so a pinned read-only scout on a repair is refused, not seated.
		for (const task of ["Resolve the parser crash.", "Do this now: fix the parser crash."]) {
			const pinnedScout = assessCapabilityMismatch({
				agentId: "scout",
				capabilityClass: "read-only",
				task,
				autoSelected: false,
				resultContractKind: "scout-report",
				specs: [],
			});
			assert.equal(pinnedScout?.verdict, "refuse", task);
		}
		assert.ok(parsed.requests.every((request) => request.agentSelection === undefined));
		const tool = createDispatchTool({ getAgentSpecs: () => [] } as unknown as DispatchToolDeps);
		assert.ok(tool.description.startsWith(DISPATCH_JOB_TABLE_TEXT));
		assert.ok(renderAgentCatalogSectionsFromSpecs([]).stable.startsWith(DISPATCH_JOB_TABLE_TEXT));
		assert.match(
			DISPATCH_JOB_TABLE_TEXT,
			/^Job table \([^)]*\): inspect=scout; review a diff=reviewer; run checks=verifier; diagnose a failure=debugger; add tests=tester; implement=coder;/u,
		);
		// The ruled reviewer: read-only by class, verify required, its verdict in the review gate's shape.
		const reviewer = discoverAgentRecipes(process.cwd()).find((recipe) => recipe.id === "reviewer");
		assert.ok(reviewer);
		const spec = normalizeAgentSpec(reviewer);
		assert.equal(spec.capabilityClass, "verification");
		assert.deepEqual(agentSpecPolicyErrors(spec), []);
		const verdict = validateResultContract({
			contract: spec.resultContract,
			output: '{"verdict":"pass","checks":[{"name":"diff","passed":true,"evidence":"src/a.ts:3 guards the empty case"}]}',
			cwd: process.cwd(),
			networkAllowed: false,
			filesystem: nodeResultContractFilesystem(),
		});
		assert.equal(verdict.conformance, "pass");
	});

	it("attaches declared checks the operator named in the turn to every task's intent verification", () => {
		const turn =
			"Fix it, then verify by running `pnpm run check`, `lint` and pnpm run test:file -- tests/x.test.ts; also `deploy`.";
		const named = operatorNamedChecks(turn, new Set(["check", "lint", "test:file"]));
		assert.deepEqual(named, ["check", "lint"]);
		const seen: unknown[] = [];
		const parsed = dispatchRequestsFromArgs(
			{
				tasks: [
					{ agent: "coder", task: "a", intent: { verification: [{ check: "lint", timeout_ms: 5000 }] } },
					{ agent: "coder", task: "b" },
				],
			},
			{
				auto: { approvedAuthorities: ["workspace-edit"], authorityBasis: "yolo-policy" },
				operatorNamedChecks: () => named,
				resolveIntent(rawIntent) {
					seen.push(rawIntent);
					return { ok: false, message: "stop" };
				},
			},
		);
		assert.equal(parsed.ok, false);
		assert.deepEqual(seen[0], { verification: [{ check: "lint", timeout_ms: 5000 }, { check: "check" }] });
		assert.deepEqual(mergeOperatorNamedChecks(undefined, named), {
			verification: [{ check: "check" }, { check: "lint" }],
		});
	});

	it("advertises compete for a one-route fleet without a roster or adaptive routing", () => {
		const composition = dispatchSchemaCompositionFor(
			fleetWith({ default: { target: "mini", model: "ornith", thinkingLevel: "off" } }),
		);
		assert.deepEqual(composition, { council: false, compete: true, adaptiveRouting: false });
		const schema = buildDispatchParameters(composition);
		assert.deepEqual(modeEnum(schema), ["parallel", "sequential", "pipeline", "compete"]);
		for (const field of ["candidates", "judge", "apply_winner"]) assert.ok(propertyNames(schema).includes(field));
	});

	it("keeps compete available across fleet routes while composing council and routing", () => {
		const roster = {
			rosters: {
				panel: {
					members: [
						{ label: "a", target: "mini" },
						{ label: "b", target: "dynamo" },
					],
				},
			},
		};
		assert.equal(dispatchSchemaCompositionFor(fleetWith(roster)).council, true);
		const twoRoutes = fleetWith({
			default: { target: "mini", model: "ornith", thinkingLevel: "off" },
			profiles: { code: { target: "mini", model: "qwen", thinkingLevel: "off" } },
		});
		assert.equal(dispatchSchemaCompositionFor(twoRoutes).compete, true);
		const sameRouteTwice = fleetWith({
			default: { target: "mini", model: "ornith", thinkingLevel: "off" },
			profiles: { code: { target: "mini", model: "ornith", thinkingLevel: "off" } },
		});
		assert.equal(dispatchSchemaCompositionFor(sameRouteTwice).compete, true);
		const adaptive = fleetWith({ adaptiveRouting: { roles: ["checker"], postures: ["balanced"], agentRoles: [] } });
		assert.equal(dispatchSchemaCompositionFor(adaptive).adaptiveRouting, true);
	});

	it("leaves the council, compete, and adaptive-routing fields off the wire when they are not usable", () => {
		const none: DispatchSchemaComposition = { council: false, compete: false, adaptiveRouting: false };
		const schema = buildDispatchParameters(none);
		const names = propertyNames(schema);
		for (const hidden of ["roster", "members", "synthesis", "rounds", "candidates", "judge", "apply_winner"]) {
			assert.equal(names.includes(hidden), false, `${hidden} should be hidden`);
		}
		for (const kept of [
			"task",
			"tasks",
			"mode",
			"review",
			"detach",
			"writers",
			"worktree",
			"apply",
			"from_scout",
			"intent",
			"budget",
			"routing",
		]) {
			assert.equal(names.includes(kept), true, `${kept} should stay`);
		}
		assert.deepEqual(modeEnum(schema), ["parallel", "sequential", "pipeline"]);
		const routing = (schema as unknown as Schema).properties.routing as unknown as Schema;
		assert.deepEqual(Object.keys(routing.properties).sort(), ["deadlineMs", "maxCostUsd", "requiredCapabilities"]);

		const full = buildDispatchParameters(FULL_DISPATCH_SCHEMA_COMPOSITION);
		assert.deepEqual(modeEnum(full), ["parallel", "sequential", "pipeline", "compete", "council"]);
		assert.equal(propertyNames(full).includes("members"), true);
		assert.equal(Object.keys(((full as unknown as Schema).properties.routing as unknown as Schema).properties).length, 7);
	});

	it("delivers nested dispatch objects through Pi's non-strict Anthropic wire schema", async () => {
		const schema = buildDispatchParameters({ council: false, compete: false, adaptiveRouting: false });
		const model: EngineModel = {
			id: "claude-haiku-4-5",
			name: "fixture",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://provider.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 4096,
		};
		let wire: typeof schema | undefined;
		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "dispatch a verifier", timestamp: 0 }],
				tools: [{ name: "dispatch", description: "Dispatch a worker", parameters: schema }],
			},
			{
				apiKey: "fixture",
				onPayload(payload) {
					wire = (payload as { tools: Array<{ input_schema: typeof schema }> }).tools[0]?.input_schema;
					throw new Error("captured before network");
				},
			},
		).result();
		assert.ok(wire);
		const task = {
			task: "check",
			context: { mode: "fork" },
			intent: { relevant_paths: ["package.json"], verification: [{ check: "test" }] },
			budget: { toolCalls: 3, readReserve: 1 },
		};
		assert.equal(Value.Check(wire, task), true);
		assert.equal(Value.Check(wire, { tasks: [task] }), true);
		assert.equal(Value.Check(wire, { ...task, context: JSON.stringify(task.context) }), false);
		assert.equal(Value.Check(wire, { ...task, intent: JSON.stringify(task.intent) }), false);
	});

	it("does not refuse a hidden field a caller sends anyway", () => {
		// Admission reads council, compete, and routing fields whether or not the
		// schema advertised them, so the composed schema must stay open to them:
		// a caller that knows the full shape loses nothing, only the advertisement moves.
		const deps = {
			getAgentSpecs: () => [],
			getSchemaComposition: () => ({ council: false, compete: false, adaptiveRouting: false }),
		} as unknown as DispatchToolDeps;
		const tool = createDispatchTool(deps);
		assert.equal(propertyNames(tool.parameters).includes("members"), false);
		const call = {
			mode: "council",
			task: "compare",
			members: [
				{ label: "a", target: "mini" },
				{ label: "b", target: "dynamo" },
			],
			candidates: 2,
			routing: { posture: "balanced", maxCostUsd: 1 },
		};
		assert.equal(Value.Check(tool.parameters as never, call), false, "mode council is not in the advertised enum");
		assert.equal(
			Value.Check(tool.parameters as never, { ...call, mode: "parallel" }),
			false,
			"routing.posture is closed",
		);
		assert.equal(Value.Check(tool.parameters as never, { ...call, mode: "parallel", routing: { maxCostUsd: 1 } }), true);
	});

	it("advertises every block when no composition is supplied", () => {
		const tool = createDispatchTool({ getAgentSpecs: () => [] } as unknown as DispatchToolDeps);
		assert.deepEqual(modeEnum(tool.parameters), ["parallel", "sequential", "pipeline", "compete", "council"]);
	});
});
