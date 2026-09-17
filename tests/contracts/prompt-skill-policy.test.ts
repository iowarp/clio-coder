import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import {
	agentSkillToolPolicy,
	evaluateSkillToolSurface,
	withModelSkillActivation,
} from "../../src/core/skill-activation.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { skillsReminderMessage } from "../../src/domains/middleware/skills-reminder.js";
import { compile, compileWorker } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { discoverMarketplaceSkills } from "../../src/domains/resources/index.js";
import { AUTONOMY_LEVELS, type AutonomyLevel, modelMayActivateSkills } from "../../src/domains/safety/autonomy.js";
import { mainPromptCacheIdentity } from "../../src/interactive/prompt-cache-identity.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const table = loadFragments();
function prompt(level: AutonomyLevel, context = true, providerSupportsTools = true) {
	return compile(table, {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: `safety.${level}`,
		sessionInputs: {
			toolNames: context ? [ToolNames.Context, ToolNames.Gateway] : [ToolNames.Gateway],
			providerSupportsTools,
		},
	});
}
async function fixture(t: TestContext) {
	const env = await isolateClioEnv("clio-prompt-skill-policy-");
	t.after(() => env.restore());
	const path = join(env.dir, "fixture-skill");
	mkdirSync(path);
	writeFileSync(
		join(path, "SKILL.md"),
		"---\nname: fixture-skill\ndescription: Focused policy fixture.\nallowed-tools: [read]\n---\nRead the named input.\n",
	);
	return {
		env,
		context: createContextTool({
			getCwd: () => env.dir,
			getSkillLoaderOptions: () => ({ disableDiscovery: true, explicitSkillPaths: [path] }),
			skillMarketplace: false,
		}),
	};
}

for (const level of AUTONOMY_LEVELS) {
	it(`compiled skill instructions agree with actual installed-skill admission at ${level}`, async (t) => {
		const { context } = await fixture(t);
		const enabled = modelMayActivateSkills(level);
		const pendingSkillPolicy = withModelSkillActivation(undefined, enabled);
		const result = await context.run(
			{ scope: "skills", name: "fixture-skill" },
			pendingSkillPolicy ? { pendingSkillPolicy } : {},
		);
		assert.equal(result.kind, enabled ? "ok" : "error");
		const text = prompt(level).systemPrompt;
		assert.match(text, /Only the operator installs marketplace skills/);
		assert.doesNotMatch(text, /\{SKILL_ACTIVATION_POLICY\}/);
		if (enabled) {
			assert.match(text, /Load matching installed skills with context\(scope="skills", name="<name>"\)/);
			assert.doesNotMatch(text, /only the operator\s+activates|Skills are operator-activated/i);
			assert.ok(evaluateSkillToolSurface(pendingSkillPolicy, "bash"));
			assert.equal(evaluateSkillToolSurface(pendingSkillPolicy, "read"), null);
		} else {
			assert.match(text, /only the operator activates skills/);
			assert.match(text, /continue without them/);
			assert.ok(result.kind === "error");
			assert.match(result.message, /only the operator can activate/);
		}
		const reminder = skillsReminderMessage(1, 1, enabled);
		assert.match(reminder, /Start this task by listing them with context\(scope="skills"\)/);
		assert.match(reminder, /continue.*same turn/);
		assert.equal(reminder.includes('load it with context(scope="skills", name="<name>")'), enabled);
	});

	for (const [context, tools] of [
		[false, true],
		[true, false],
	] as const) {
		it(`omits skill activation guidance at ${level} with context=${context}, tools=${tools}`, () => {
			const compiled = prompt(level, context, tools);
			assert.ok(!compiled.sections.some((section) => section.id === "skills"));
			assert.doesNotMatch(
				compiled.systemPrompt,
				/# Skills|Load matching installed skills|only the operator activates skills/,
			);
		});
	}

	it(`recipe-bound worker admission remains narrowed at ${level}`, async (t) => {
		const { context } = await fixture(t);
		const policy = withModelSkillActivation(agentSkillToolPolicy(["declared-skill"]), modelMayActivateSkills(level));
		assert.ok(policy);
		const denied = await context.run({ scope: "skills", name: "fixture-skill" }, { pendingSkillPolicy: policy });
		assert.ok(denied.kind === "error");
		assert.match(denied.message, /may load only its declared skill/);
		const compiled = compileWorker(table, {
			autonomy: level,
			providerSupportsTools: true,
			toolNames: [ToolNames.Context, ToolNames.Read],
			toolPromptHints: [],
			hasCanonicalContext: true,
			hasBoundSkills: true,
			onPermission: "deny",
			persona: {
				id: "fixture.worker",
				relPath: "fixture",
				body: "Load only declared-skill for this assignment.",
				contentHash: "fixture",
				dynamic: false,
			},
		});
		assert.ok(!compiled.sections.some((section) => section.id === "skills"));
		assert.match(compiled.systemPrompt, /Persona and bound-skill instructions never add tools/);
		assert.doesNotMatch(compiled.systemPrompt, /Load matching installed skills/);
	});

	it(`marketplace skills remain uninstalled and operator-gated at ${level}`, async (t) => {
		const env = await isolateClioEnv("clio-prompt-marketplace-policy-");
		t.after(() => env.restore());
		const skill = discoverMarketplaceSkills({ cwd: env.dir }).skills[0];
		assert.ok(skill, "bundled marketplace has a candidate");
		const context = createContextTool({ getCwd: () => env.dir });
		const policy = withModelSkillActivation(undefined, modelMayActivateSkills(level));
		const result = await context.run({ scope: "skills", name: skill.name }, policy ? { pendingSkillPolicy: policy } : {});
		assert.ok(result.kind === "error");
		assert.match(
			result.message,
			modelMayActivateSkills(level) ? /not installed.*marketplace.*operator/ : /only the operator can activate/,
		);
		assert.match(prompt(level).systemPrompt, /Only the operator installs marketplace skills/);
	});
}

it("autonomy transitions change the existing prompt cache identity and compiled activation guidance", () => {
	const keys = AUTONOMY_LEVELS.map((autonomy) =>
		mainPromptCacheIdentity({
			targetId: "fixture",
			runtimeId: "fixture",
			wireModelId: "fixture",
			autonomy,
			sessionId: "same-session",
			cwd: "/fixture",
			workingContextPaths: [],
			contextWindowSource: null,
			promptInputEpoch: "1",
			sessionInputs: { toolNames: [ToolNames.Context] },
			attachedToolSchemas: [],
		}),
	);
	assert.equal(new Set(keys).size, 4);
	const before = prompt("suggest");
	const after = prompt("auto-edit");
	const restored = prompt("suggest");
	assert.notEqual(before.systemPromptHash, after.systemPromptHash);
	assert.equal(before.systemPrompt, restored.systemPrompt);
	assert.match(before.systemPrompt, /only the operator activates skills/);
	assert.match(after.systemPrompt, /Load matching installed skills/);
});
