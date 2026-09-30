import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { parseAgentRecipeSchema } from "../../src/domains/agents/recipe-schema.js";
import {
	parseWorkerPermissionDeclaration,
	resolveWorkerPermit,
	type WorkerPermitInput,
	workerPermissionModeForPermit,
} from "../../src/domains/safety/worker-permit.js";

function frontmatter(extra: Record<string, unknown>, capabilityClass = "workspace-edit"): Record<string, unknown> {
	return {
		version: 1,
		name: "Permit fixture",
		description: "Permit fixture recipe.",
		tools: { required: [ToolNames.Read, ToolNames.Write], optional: [] },
		skills: [],
		audience: "custom",
		category: "implement",
		capabilityClass,
		latencyClass: "balanced",
		projectContextTier: "none",
		budget: { toolCalls: 10, readReserve: 1, synthesis: false },
		resultContract: { kind: "mutation-report" },
		tags: [],
		...extra,
	};
}

function parse(extra: Record<string, unknown>, capabilityClass?: string) {
	return parseAgentRecipeSchema({
		id: "permit-fixture",
		source: "project",
		filepath: "permit-fixture.md",
		body: "Persona.",
		frontmatter: frontmatter(extra, capabilityClass),
	});
}

function input(overrides: Partial<WorkerPermitInput> = {}): WorkerPermitInput {
	return {
		agentId: "coder",
		capabilityClass: "workspace-edit",
		tools: [ToolNames.Read, ToolNames.Write, ToolNames.Bash],
		readOnly: false,
		writeRoots: [],
		mode: "deny",
		...overrides,
	};
}

describe("worker permit", () => {
	it("parses recipe permissions strictly, rejecting unknown keys, unknown values and a misplaced worktree allowance", () => {
		deepStrictEqual(parse({ permissions: { git: "worktree", asks: "main" } }).permissions, {
			git: "worktree",
			asks: "main",
		});
		strictEqual(parse({}).permissions, undefined);
		throws(() => parse({ permissions: { git: "inspect", network: "on" } }), /permissions\.network is unknown/u);
		throws(() => parse({ permissions: { asks: "yolo" } }), /permissions\.asks must be one of deny, fail, main/u);
		throws(() => parse({ permissions: "main" }), /permissions must be a map/u);
		throws(
			() => parse({ permissions: { git: "worktree" } }, "verification"),
			/git worktree requires capabilityClass workspace-edit/u,
		);
		throws(() => parseWorkerPermissionDeclaration({ git: "all" }, "narrowing"), /narrowing\.git must be one of/u);
	});

	it("keeps today's behavior when nothing is declared and maps legacy escalate to operator-decided main routing", () => {
		const plain = resolveWorkerPermit(input());
		deepStrictEqual(plain.allowance, { git: "inspect", asks: "deny", approvalAuthority: "operator" });
		strictEqual(workerPermissionModeForPermit(plain.allowance), "deny");
		const escalate = resolveWorkerPermit(input({ mode: "escalate" }));
		deepStrictEqual(escalate.allowance, { git: "inspect", asks: "main", approvalAuthority: "operator" });
		strictEqual(workerPermissionModeForPermit(escalate.allowance), "escalate");
		strictEqual(resolveWorkerPermit(input({ mode: "fail" })).allowance.asks, "fail");
	});

	it("narrows per task and refuses a widening request instead of ignoring it", () => {
		const declared = { git: "worktree", asks: "main" } as const;
		const narrowed = resolveWorkerPermit(
			input({ mode: "escalate", declared, narrowing: { git: "inspect", asks: "fail" } }),
		);
		deepStrictEqual(narrowed.allowance, { git: "inspect", asks: "fail", approvalAuthority: "operator" });
		throws(() => resolveWorkerPermit(input({ narrowing: { git: "worktree" } })), /cannot be widened to worktree/u);
		throws(() => resolveWorkerPermit(input({ narrowing: { asks: "main" } })), /cannot be widened to main/u);
		// A retry's inherited allowance caps without refusing, and a read-only
		// ceiling leaves no Git mutation to allow.
		const capped = resolveWorkerPermit(
			input({ mode: "escalate", declared, inherited: { git: "inspect", asks: "deny", approvalAuthority: "operator" } }),
		);
		deepStrictEqual(capped.allowance, { git: "inspect", asks: "deny", approvalAuthority: "operator" });
		strictEqual(resolveWorkerPermit(input({ declared, readOnly: true })).allowance.git, "inspect");
		strictEqual(Object.isFrozen(narrowed.allowance), true);
		strictEqual(narrowed.digest === resolveWorkerPermit(input()).digest, false);
	});

	it("enforces class ceilings and fails closed for orchestration and unspecified internal workers", () => {
		throws(
			() => resolveWorkerPermit(input({ capabilityClass: "read-only", tools: [ToolNames.Read, ToolNames.Write] })),
			/read-only ceiling excludes write tool write/u,
		);
		throws(
			() => resolveWorkerPermit(input({ capabilityClass: "verification", tools: [ToolNames.Verify, ToolNames.Bash] })),
			/verification ceiling excludes bash/u,
		);
		throws(
			() => resolveWorkerPermit(input({ capabilityClass: "artifact-write", tools: [ToolNames.Artifact, ToolNames.Edit] })),
			/artifact-write ceiling allows only the artifact write/u,
		);
		throws(() => resolveWorkerPermit(input({ capabilityClass: "orchestration" })), /orchestration agent/u);
		throws(() => resolveWorkerPermit(input({ capabilityClass: "internal", tools: [ToolNames.Read] })), /internal/u);
		strictEqual(
			resolveWorkerPermit(input({ capabilityClass: "internal", tools: [ToolNames.Read], hostHelper: true })).ceiling
				.capabilityClass,
			"internal",
		);
		// The delegation ceiling is delegatedTools ?? allowedTools, never an intersection of both.
		const delegated = resolveWorkerPermit(
			input({
				turnConstraints: { allowedTools: [ToolNames.Dispatch], delegatedTools: [ToolNames.Read, ToolNames.Write] },
			}),
		);
		deepStrictEqual(delegated.ceiling.tools, [ToolNames.Read, ToolNames.Write]);
	});
});
