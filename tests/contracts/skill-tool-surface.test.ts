import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import {
	evaluateSkillToolSurface,
	type PendingSkillRequest,
	type PendingSkillToolPolicy,
	type SkillDeclaredToolPolicy,
} from "../../src/core/skill-activation.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { ToolCallAuditInput } from "../../src/domains/safety/audit.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createRegistry, type ToolResult, type ToolSpec } from "../../src/tools/registry.js";
import { createReadSkillTool } from "../../src/tools/skills.js";

function surfacePolicy(policies: Record<string, SkillDeclaredToolPolicy>): PendingSkillToolPolicy {
	const names = Object.keys(policies);
	return {
		allowedSkillNames: names,
		requests: names.map((name): PendingSkillRequest => ({ name, args: "", source: "slash-command", installed: true })),
		loadedSkillNames: new Set(names),
		loadedSkillPolicies: new Map(Object.entries(policies)),
	};
}

describe("contracts/skill-tool-surface evaluator", () => {
	it("returns null with no policy or no loaded skills", () => {
		strictEqual(evaluateSkillToolSurface(undefined, "write"), null);
		strictEqual(evaluateSkillToolSurface(surfacePolicy({}), "write"), null);
	});

	it("blocks a tool outside a single skill's allowed-tools and permits declared ones", () => {
		const policy = surfacePolicy({ council: { allowedTools: ["read", "dispatch"] } });
		const violation = evaluateSkillToolSurface(policy, "write");
		ok(violation);
		strictEqual(violation.mergedAllowedTools?.join(","), "read,dispatch");
		strictEqual(evaluateSkillToolSurface(policy, "read"), null);
		strictEqual(evaluateSkillToolSurface(policy, "dispatch"), null);
	});

	it("always exempts read_skill and ask_user", () => {
		const policy = surfacePolicy({ narrow: { allowedTools: ["read"], disallowedTools: ["ask_user"] } });
		strictEqual(evaluateSkillToolSurface(policy, "read_skill"), null);
		strictEqual(evaluateSkillToolSurface(policy, "ask_user"), null);
	});

	it("merges multiple declaring skills as a union", () => {
		const policy = surfacePolicy({
			a: { allowedTools: ["read"] },
			b: { allowedTools: ["write", "bash"] },
		});
		strictEqual(evaluateSkillToolSurface(policy, "write"), null);
		strictEqual(evaluateSkillToolSurface(policy, "read"), null);
		const violation = evaluateSkillToolSurface(policy, "dispatch");
		ok(violation);
		strictEqual(violation.skills.join(","), "a,b");
	});

	it("lifts allow-narrowing when any loaded skill declares no allowed-tools", () => {
		const policy = surfacePolicy({
			narrow: { allowedTools: ["read"] },
			open: {},
		});
		strictEqual(evaluateSkillToolSurface(policy, "write"), null);
	});

	it("applies disallowed-tools denials even when allow-narrowing is lifted", () => {
		const policy = surfacePolicy({
			open: { disallowedTools: ["bash"] },
			other: {},
		});
		const violation = evaluateSkillToolSurface(policy, "bash");
		ok(violation);
		strictEqual(violation.disallowedBy.join(","), "open");
		strictEqual(evaluateSkillToolSurface(policy, "write"), null);
	});
});

function auditingSafety(rows: ToolCallAuditInput[]): SafetyContract {
	return {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		audit: {
			recordCount: () => rows.length,
			recordToolCall: (input) => {
				rows.push(input);
			},
		},
	};
}

function mockSpec(name: ToolName, result: ToolResult): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => result,
	};
}

function writeSkillDir(root: string, name: string, frontmatter: string[], body = "Skill body."): void {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", "", body, ""].join("\n"), "utf8");
}

describe("contracts/skill-tool-surface registry enforcement", () => {
	const ORIGINAL_ENV = { ...process.env };
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-skill-surface-"));
		process.env.HOME = scratch;
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_STATE_DIR = join(scratch, "state");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("blocks out-of-surface calls after read_skill loads a narrowing skill", async () => {
		const cwd = join(scratch, "project");
		writeSkillDir(join(cwd, ".clio", "skills"), "narrow", [
			'name: "narrow"',
			'description: "Narrowing fixture skill."',
			"allowed-tools:",
			"  - read",
		]);
		const rows: ToolCallAuditInput[] = [];
		const registry = createRegistry({ safety: auditingSafety(rows) });
		registry.register(createReadSkillTool({ getCwd: () => cwd }));
		registry.register(mockSpec(ToolNames.Read, { kind: "ok", output: "read ok" }));
		registry.register(mockSpec(ToolNames.Write, { kind: "ok", output: "wrote" }));
		registry.register(mockSpec(ToolNames.AskUser, { kind: "ok", output: "asked" }));

		const policy = surfacePolicy({});
		(policy.allowedSkillNames as string[]).push("narrow");
		(policy.requests as PendingSkillRequest[]).push({
			name: "narrow",
			args: "",
			source: "slash-command",
			installed: true,
		});
		const options = { turnId: "turn-1", pendingSkillPolicy: policy };

		// Before activation the surface is unrestricted.
		const preWrite = await registry.invoke({ tool: ToolNames.Write, args: {} }, options);
		strictEqual(preWrite.kind, "ok");

		const load = await registry.invoke({ tool: ToolNames.ReadSkill, args: { name: "narrow" } }, options);
		strictEqual(load.kind, "ok");
		if (load.kind === "ok") strictEqual(load.result.kind, "ok");
		ok(policy.loadedSkillPolicies.has("narrow"));

		const blocked = await registry.invoke({ tool: ToolNames.Write, args: {} }, options);
		strictEqual(blocked.kind, "blocked");
		if (blocked.kind !== "blocked") return;
		ok(blocked.reason.includes("narrow"));
		ok(blocked.reason.includes("read"));
		ok(blocked.reason.includes("ask_user"));

		const auditRow = rows.find((row) => row.tool === ToolNames.Write && row.decision === "blocked");
		ok(auditRow);
		strictEqual(auditRow.reasonCode, "skill_surface");

		const allowedRead = await registry.invoke({ tool: ToolNames.Read, args: {} }, options);
		strictEqual(allowedRead.kind, "ok");
		const askUser = await registry.invoke({ tool: ToolNames.AskUser, args: {} }, options);
		strictEqual(askUser.kind, "ok");

		// A call without the policy (next turn) is unrestricted again.
		const nextTurn = await registry.invoke({ tool: ToolNames.Write, args: {} }, { turnId: "turn-2" });
		strictEqual(nextTurn.kind, "ok");
	});
});
