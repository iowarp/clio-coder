import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { type AgentBudget, parseAgentBudget } from "../../src/domains/agents/recipe.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import {
	BudgetAdmissionError,
	cloneDispatchBudgetRequest,
	resolveToolBudgetEnvelope,
} from "../../src/domains/dispatch/budget-envelope.js";
import { dispatchRequestsFromArgs } from "../../src/tools/dispatch-arguments.js";

const exactPolicy: AgentBudget = { toolCalls: 32, readReserve: 5, synthesis: true };
const rangedPolicy: AgentBudget = {
	...exactPolicy,
	maximum: { toolCalls: 150, readReserve: 16 },
};

function resolve(
	overrides: Partial<Parameters<typeof resolveToolBudgetEnvelope>[0]> = {},
): ReturnType<typeof resolveToolBudgetEnvelope> {
	return resolveToolBudgetEnvelope({
		recipeId: "architect",
		policy: rangedPolicy,
		hardCap: 150,
		hasReadTool: true,
		retry: false,
		revision: false,
		...overrides,
	});
}

describe("contracts/dispatch budget envelopes", () => {
	it("keeps unchanged recipes exact and gives Architect the only builtin range", () => {
		const recipes = loadRecipesFromDir({
			dir: join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
			source: "builtin",
		});
		const architect = recipes.find((recipe) => recipe.id === "architect");
		deepStrictEqual(architect?.budget, rangedPolicy);
		for (const recipe of recipes) {
			if (recipe.id !== "architect") strictEqual(recipe.budget.maximum, undefined, recipe.id);
		}
	});

	it("strictly validates recipe maxima and invocation reserve semantics", () => {
		deepStrictEqual(parseAgentBudget({ ...exactPolicy, maximum: { toolCalls: 64, readReserve: 8 } }, "/tmp/agent.md"), {
			...exactPolicy,
			maximum: { toolCalls: 64, readReserve: 8 },
		});
		throws(
			() => parseAgentBudget({ ...exactPolicy, maximum: { toolCalls: 31, readReserve: 8 } }, "/tmp/agent.md"),
			/maximum.toolCalls must be greater than or equal to budget.toolCalls/,
		);
		throws(
			() => cloneDispatchBudgetRequest({ toolCalls: 8, readReserve: 8 }),
			/budget.readReserve must be less than budget.toolCalls/,
		);
		throws(() => cloneDispatchBudgetRequest({ toolCalls: 8, readReserve: 1, bypass: true }), /budget.bypass is unknown/);
	});

	it("preserves default behavior and records every effective clamp", () => {
		const unchanged = resolve();
		deepStrictEqual(unchanged.effective, { toolCalls: 32, readReserve: 5, synthesis: true, hardCap: 150 });
		strictEqual(unchanged.request, null);
		deepStrictEqual(unchanged.reasons, []);
		ok(Object.isFrozen(unchanged));
		ok(Object.isFrozen(unchanged.effective));

		const clamped = resolve({ hardCap: 4, hasReadTool: false });
		deepStrictEqual(clamped.effective, { toolCalls: 4, readReserve: 0, synthesis: true, hardCap: 4 });
		deepStrictEqual(
			clamped.reasons.map((reason) => reason.code),
			["global-cap-clamp", "read-reserve-unavailable-clamp"],
		);
		const revisionClamped = resolve({
			request: {
				toolCalls: 64,
				readReserve: 8,
				retryRevision: { toolCalls: 120, readReserve: 12 },
			},
			hasReadTool: false,
		});
		deepStrictEqual(revisionClamped.effective.revision, { toolCalls: 120, readReserve: 0 });
		deepStrictEqual(
			revisionClamped.reasons.map((reason) => reason.code),
			["revision-growth-authorized", "read-reserve-unavailable-clamp", "read-reserve-unavailable-clamp"],
		);
	});

	it("denies exact-policy, recipe-maximum, global-cap, and malformed ceiling requests", () => {
		throws(
			() =>
				resolve({
					policy: exactPolicy,
					request: { toolCalls: 33, readReserve: 5 },
				}),
			(error) => error instanceof BudgetAdmissionError && error.code === "exact-recipe-policy",
		);
		throws(
			() => resolve({ request: { toolCalls: 151, readReserve: 5 }, hardCap: 200 }),
			(error) => error instanceof BudgetAdmissionError && error.code === "recipe-maximum",
		);
		throws(
			() => resolve({ request: { toolCalls: 100, readReserve: 8 }, hardCap: 80 }),
			(error) => error instanceof BudgetAdmissionError && error.code === "global-cap",
		);
		throws(
			() =>
				resolve({
					request: {
						toolCalls: 80,
						readReserve: 8,
						retryRevision: { toolCalls: 64, readReserve: 7 },
					},
				}),
			(error) => error instanceof BudgetAdmissionError && error.code === "ceiling-below-request",
		);
	});

	it("allows only preauthorized retry and revision growth", () => {
		const request = {
			toolCalls: 64,
			readReserve: 8,
			retryRevision: { toolCalls: 120, readReserve: 12 },
		};
		const initial = resolve({ request });
		deepStrictEqual(initial.effective, {
			toolCalls: 64,
			readReserve: 8,
			synthesis: true,
			hardCap: 150,
			revision: { toolCalls: 120, readReserve: 12 },
		});
		strictEqual(initial.reasons[0]?.code, "revision-growth-authorized");
		const retry = resolve({ request, retry: true });
		deepStrictEqual(retry.effective, { toolCalls: 120, readReserve: 12, synthesis: true, hardCap: 150 });
		strictEqual(retry.reasons[0]?.code, "retry-growth-authorized");

		const revision = resolve({ request, revision: true });
		strictEqual(revision.effective.toolCalls, 120);
		strictEqual(revision.reasons[0]?.code, "revision-growth-authorized");

		const denied = resolve({ request: { toolCalls: 64, readReserve: 8 }, retry: true });
		deepStrictEqual(denied.effective, { toolCalls: 64, readReserve: 8, synthesis: true, hardCap: 150 });
		strictEqual(denied.reasons[0]?.code, "retry-growth-denied");
	});

	it("parses the model-facing typed request without weakening its shape", () => {
		const parsed = dispatchRequestsFromArgs(
			{
				tasks: [{ agent: "architect", task: "Design the change" }],
				budget: {
					toolCalls: 64,
					readReserve: 8,
					retryRevision: { toolCalls: 120, readReserve: 12 },
				},
			},
			{ auto: { approvedAuthorities: [], authorityBasis: "operator-plan-approval" } },
		);
		ok(parsed.ok);
		if (!parsed.ok) return;
		deepStrictEqual(parsed.requests[0]?.budget, {
			toolCalls: 64,
			readReserve: 8,
			retryRevision: { toolCalls: 120, readReserve: 12 },
		});

		const malformed = dispatchRequestsFromArgs(
			{ tasks: [{ task: "Design" }], budget: { toolCalls: 10, readReserve: 10 } },
			{ auto: { approvedAuthorities: [], authorityBasis: "operator-plan-approval" } },
		);
		strictEqual(malformed.ok, false);
		if (malformed.ok) return;
		match(malformed.message, /readReserve must be less than budget.toolCalls/);
	});
});
