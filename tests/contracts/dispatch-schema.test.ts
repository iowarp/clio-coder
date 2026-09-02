import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
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
	it("advertises nothing optional for a one-route fleet with no roster and no adaptive routing", () => {
		const composition = dispatchSchemaCompositionFor(
			fleetWith({ default: { target: "mini", model: "ornith", thinkingLevel: "off" } }),
		);
		assert.deepEqual(composition, { council: false, compete: false, adaptiveRouting: false });
	});

	it("turns each block on with the fleet fact that makes it usable", () => {
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
		assert.equal(dispatchSchemaCompositionFor(sameRouteTwice).compete, false);
		const adaptive = fleetWith({ adaptiveRouting: { roles: ["verifier"], postures: ["balanced"], agentRoles: [] } });
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

	it("keeps the $defs the task objects reference in every composition", () => {
		const schema = buildDispatchParameters({ council: false, compete: false, adaptiveRouting: false }) as unknown as {
			$defs: Record<string, unknown>;
		};
		assert.deepEqual(Object.keys(schema.$defs).sort(), ["budget", "intent"]);
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
