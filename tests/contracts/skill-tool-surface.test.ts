import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { Type } from "typebox";

import {
	armedSkillSurface,
	evaluateSkillToolSurface,
	type PendingSkillToolPolicy,
	skillSurfaceNames,
	withModelSkillActivation,
} from "../../src/core/skill-activation.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { loadSkills, parsePendingSkillRequests } from "../../src/domains/resources/skills/loader.js";
import { type AutonomyLevel, modelMayActivateSkills } from "../../src/domains/safety/autonomy.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createPendingSkillToolPolicy } from "../../src/interactive/chat-loop-messages.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

const roots: string[] = [];

function scratchRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-skill-surface-"));
	roots.push(root);
	return root;
}

/** A skill directory whose frontmatter declares the narrowing under test. */
function writeNarrowingSkill(root: string, name: string, frontmatter: ReadonlyArray<string>): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			`description: ${name} interview workflow.`,
			...frontmatter,
			"---",
			"",
			`Run ${name}.`,
			"",
		].join("\n"),
		"utf8",
	);
	return directory;
}

function allowAllSafety(recorded: { reasonCode?: string; decision?: string }[]) {
	return {
		classify: () => ({ actionClass: "read" as const, reasons: [] }),
		evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "contract", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: {
			recordCount: () => 0,
			recordToolCall: (row: { reasonCode?: string; decision?: string }) => {
				recorded.push({ ...row });
			},
		},
	};
}

function bashSpec(): ToolSpec {
	return {
		name: ToolNames.Bash,
		description: "contract bash",
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => ({ kind: "ok" as const, output: "ran" }),
	};
}

/**
 * The chat loop's per-turn composition, condensed: an operator `/skill` this
 * turn wins, otherwise the turn runs under the surface an earlier turn armed,
 * and the autonomy level stamps model activation on whichever it is.
 */
function turnPolicy(
	input: string,
	root: string,
	armed: PendingSkillToolPolicy | undefined,
	autonomy: AutonomyLevel = "suggest",
): PendingSkillToolPolicy | undefined {
	const list = loadSkills({ cwd: root, disableDiscovery: true, explicitSkillPaths: explicitPaths });
	const requests = parsePendingSkillRequests(input, list, { cwd: root }).pendingSkillRequests;
	return withModelSkillActivation(createPendingSkillToolPolicy(requests) ?? armed, modelMayActivateSkills(autonomy));
}

let explicitPaths: string[] = [];

/** Tool-invoke options for a turn, omitting the key entirely when nothing is armed. */
function invokeOptions(policy: PendingSkillToolPolicy | undefined): { pendingSkillPolicy?: PendingSkillToolPolicy } {
	return policy ? { pendingSkillPolicy: policy } : {};
}

function contextToolFor(root: string) {
	return createContextTool({
		getCwd: () => root,
		getSkillLoaderOptions: () => ({ disableDiscovery: true, explicitSkillPaths: explicitPaths }),
		skillMarketplace: false,
	});
}

describe("skill tool surface lifetime", () => {
	afterEach(() => {
		explicitPaths = [];
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("keeps a loaded skill's narrowing armed on the operator's next turn", async () => {
		const root = scratchRoot();
		explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
		const context = contextToolFor(root);

		// Turn 1: the operator activates the skill and it loads.
		const turnOne = turnPolicy("/skill interview start", root, undefined);
		ok(turnOne !== undefined);
		const loaded = await context.run({ scope: "skills", name: "interview" }, invokeOptions(turnOne));
		strictEqual(loaded.kind, "ok");
		ok(evaluateSkillToolSurface(turnOne, ToolNames.Bash) !== null);

		// Turn 1 settles; the surface it declared stays armed.
		const armed = armedSkillSurface(turnOne);
		ok(armed !== undefined);
		strictEqual(armed.carriedSurface, true);

		// Turn 2 is an ordinary message, and bash is still outside the surface.
		const turnTwo = turnPolicy("next answer", root, armed);
		strictEqual(turnTwo, armed);
		const violation = evaluateSkillToolSurface(turnTwo, ToolNames.Bash);
		ok(violation !== null);
		strictEqual(violation.carriedSurface, true);

		const recorded: { reasonCode?: string; decision?: string }[] = [];
		const registry = createRegistry({ safety: allowAllSafety(recorded) });
		registry.register(bashSpec());
		const verdict = await registry.invoke({ tool: ToolNames.Bash, args: {} }, invokeOptions(turnTwo));
		strictEqual(verdict.kind, "blocked");
		strictEqual(recorded.at(-1)?.reasonCode, "skill_surface");
		if (verdict.kind === "blocked") {
			match(verdict.reason, /stays active for the rest of the session/u);
			match(verdict.reason, /\/skill off/u);
		}
	});

	it("lifts the narrowing when the operator clears it with /skill off", async () => {
		const root = scratchRoot();
		explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
		const context = contextToolFor(root);
		const turnOne = turnPolicy("/skill interview start", root, undefined);
		await context.run({ scope: "skills", name: "interview" }, invokeOptions(turnOne));
		const armed = armedSkillSurface(turnOne);
		ok(armed !== undefined);

		// `/skill off` is its own command: it clears the surface instead of
		// submitting a turn that tries to load a skill named "off".
		deepStrictEqual(parseSlashCommand("/skill off"), { kind: "skill-surface-clear" });
		const notices: Array<[string, string]> = [];
		let submitted = 0;
		let held: PendingSkillToolPolicy | undefined = armed;
		const ctx = {
			notice: (level: string, text: string) => {
				notices.push([level, text]);
			},
			submitChat: () => {
				submitted += 1;
			},
			clearSkillSurface: () => {
				const cleared = skillSurfaceNames(held);
				held = undefined;
				return cleared;
			},
		} as unknown as SlashCommandContext;
		dispatchSlashCommand(parseSlashCommand("/skill off"), ctx);
		strictEqual(submitted, 0);
		strictEqual(held, undefined);
		match(notices.at(-1)?.[1] ?? "", /Skill tool surface cleared: interview\./u);

		// The next turn runs with the full surface back.
		const turnTwo = turnPolicy("keep going", root, held);
		strictEqual(turnTwo, undefined);
		strictEqual(evaluateSkillToolSurface(turnTwo, ToolNames.Bash), null);
		const registry = createRegistry({ safety: allowAllSafety([]) });
		registry.register(bashSpec());
		const verdict = await registry.invoke({ tool: ToolNames.Bash, args: {} }, invokeOptions(turnTwo));
		strictEqual(verdict.kind, "ok");
	});

	it("replaces rather than merges when the operator activates a different skill", async () => {
		const root = scratchRoot();
		explicitPaths = [
			writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"]),
			writeNarrowingSkill(root, "builder", ["allowed-tools: write"]),
		];
		const context = contextToolFor(root);
		const turnOne = turnPolicy("/skill interview start", root, undefined);
		await context.run({ scope: "skills", name: "interview" }, invokeOptions(turnOne));
		const armed = armedSkillSurface(turnOne);
		ok(armed !== undefined);

		const turnTwo = turnPolicy("/skill builder go", root, armed);
		ok(turnTwo !== undefined);
		strictEqual(turnTwo === armed, false, "a fresh /skill must not run under the previous skill's policy");
		await context.run({ scope: "skills", name: "builder" }, invokeOptions(turnTwo));
		const replaced = armedSkillSurface(turnTwo);
		ok(replaced !== undefined);
		strictEqual(skillSurfaceNames(replaced).join(","), "builder");
		// The replaced skill's surface is gone, not unioned with the new one.
		strictEqual(evaluateSkillToolSurface(replaced, ToolNames.Write), null);
		ok(evaluateSkillToolSurface(replaced, ToolNames.Read) !== null);
	});
});

describe("model skill activation by autonomy level", () => {
	const priorCatalogDir = process.env.CLIO_CODER_SKILL_CATALOG_DIR;

	afterEach(() => {
		explicitPaths = [];
		if (priorCatalogDir === undefined) delete process.env.CLIO_CODER_SKILL_CATALOG_DIR;
		else process.env.CLIO_CODER_SKILL_CATALOG_DIR = priorCatalogDir;
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	for (const autonomy of ["auto-edit", "full-auto"] as const) {
		it(`activates an installed skill on a model call at ${autonomy}`, async () => {
			const root = scratchRoot();
			explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
			const context = contextToolFor(root);
			// No /skill this turn: the model calls context(scope="skills") itself.
			const policy = turnPolicy("look at the failing test", root, undefined, autonomy);
			ok(policy !== undefined);
			strictEqual(policy.modelActivation, true);
			const activated = await context.run({ scope: "skills", name: "interview" }, invokeOptions(policy));
			strictEqual(activated.kind, "ok");
			if (activated.kind === "ok") match(activated.output, /Run interview\./u);

			// The narrowing it declared binds the very next call of the same turn.
			const recorded: { reasonCode?: string; decision?: string }[] = [];
			const registry = createRegistry({ safety: allowAllSafety(recorded) });
			registry.register(bashSpec());
			const verdict = await registry.invoke({ tool: ToolNames.Bash, args: {} }, invokeOptions(policy));
			strictEqual(verdict.kind, "blocked");
			strictEqual(recorded.at(-1)?.reasonCode, "skill_surface");
		});
	}

	for (const autonomy of ["read-only", "suggest"] as const) {
		it(`keeps activation operator-gated at ${autonomy}`, async () => {
			const root = scratchRoot();
			explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
			const context = contextToolFor(root);
			const policy = turnPolicy("look at the failing test", root, undefined, autonomy);
			strictEqual(policy, undefined);
			const refused = await context.run({ scope: "skills", name: "interview" }, invokeOptions(policy));
			strictEqual(refused.kind, "error");
			if (refused.kind === "error") {
				match(refused.message, /only the operator can activate a skill/u);
				match(refused.message, /Suggested skill: \/skill/u);
			}
		});
	}

	it("still refuses an uninstalled marketplace skill at full-auto", async () => {
		const root = scratchRoot();
		explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
		// A catalog the operator could install from, holding a skill that is not installed here.
		const catalog = join(root, "catalog");
		mkdirSync(catalog, { recursive: true });
		writeNarrowingSkill(catalog, "marketplace-only", []);
		process.env.CLIO_CODER_SKILL_CATALOG_DIR = catalog;

		// Marketplace rows only appear when discovery is on, which is what makes
		// this the real not-installed path rather than an unknown-name miss.
		const context = createContextTool({
			getCwd: () => root,
			getSkillLoaderOptions: () => ({ explicitSkillPaths: explicitPaths }),
		});
		const policy = turnPolicy("do the thing", root, undefined, "full-auto");
		ok(policy !== undefined);
		const refused = await context.run({ scope: "skills", name: "marketplace-only" }, invokeOptions(policy));
		strictEqual(refused.kind, "error");
		if (refused.kind === "error") {
			match(refused.message, /is not installed; it is available in the marketplace/u);
			match(refused.message, /Ask the operator to run \/skill marketplace-only/u);
		}
	});
});
