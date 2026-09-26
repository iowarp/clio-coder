import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetPlanView, parseFleetVars } from "../client/chat/fleet-run-model.js";

test("fleet variables are name=value lines, checked before anything is sent", () => {
	assert.deepEqual(parseFleetVars("site = plot-7\n\ndepth=2 m\n"), { vars: { site: "plot-7", depth: "2 m" } });
	assert.deepEqual(parseFleetVars(""), { vars: {} });
	assert.match((parseFleetVars("just words") as { error: string }).error, /not name=value/);
	assert.match((parseFleetVars("9lives=x") as { error: string }).error, /not a variable name/);
	assert.match((parseFleetVars("a=1\na=2") as { error: string }).error, /set twice/);
});

test("a compiled plan reads as waves of steps with placement, scope and declared writes", () => {
	const view = fleetPlanView({
		status: "ready",
		name: "survey",
		planHash: "b".repeat(64),
		stepCount: 2,
		truncated: false,
		budget: { ceilingUsd: 5, currentUsd: 0.25, contractUsd: 1 },
		waves: [
			{
				index: 0,
				steps: [
					{
						stepId: "survey",
						kind: "agent",
						scope: "readonly",
						agentId: "scout",
						writes: null,
						route: { targetId: "mini", model: "gemma", nodeId: "local" },
					},
				],
			},
			{
				index: 1,
				steps: [
					{ stepId: "lint", kind: "code", scope: "workspace", commandId: "lint", argv: ["pnpm", "lint"], writes: [] },
				],
			},
		],
	});
	assert.equal(view.heading, "2 steps in 2 waves");
	assert.deepEqual(
		view.waves.map((wave) => [wave.label, wave.rows.map((row) => [row.who, row.where, row.notes])]),
		[
			["Wave 1", [["scout", "mini · gemma", ["Reads only"]]]],
			["Wave 2", [["command lint", "pnpm lint", ["May change the workspace", "Declares no writes"]]]],
		],
	);
	assert.equal(view.budget, "$0.25 of this session's $5.00 ceiling is spent; the contract asks for up to $1.00.");
	assert.equal(view.hash.short, "bbbbbbbbbbbb");
});
