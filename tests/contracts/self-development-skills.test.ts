import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { CLIO_SELF_DEVELOPMENT_SKILLS } from "../../src/core/clio-repo.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { agentSkillToolPolicy, withModelSkillActivation } from "../../src/core/skill-activation.js";
import {
	clearPluginSnapshots,
	disablePlugin,
	installPlugin,
	pluginContentDigest,
} from "../../src/domains/plugins/index.js";
import type { SessionPromptInputs } from "../../src/domains/prompts/compiler.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { loadSkills, modelVisibleSkills } from "../../src/domains/resources/skills/loader.js";
import { AUTONOMY_LEVELS, modelMayActivateSkills } from "../../src/domains/safety/autonomy.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

async function fixture(t: TestContext, worktree = false) {
	const env = await isolateClioEnv("clio-self-development-");
	t.after(() => {
		clearPluginSnapshots();
		env.restore();
	});
	const cwd = path.join(env.dir, "repo");
	mkdirSync(cwd);
	if (worktree) writeFileSync(path.join(cwd, ".git"), "gitdir: /fixture/worktree\n");
	else mkdirSync(path.join(cwd, ".git"));
	writeFileSync(
		path.join(cwd, "package.json"),
		JSON.stringify({ name: "@iowarp/clio-coder", repository: "https://github.com/iowarp/clio-coder" }),
	);
	for (const marker of [
		"src/entry/orchestrator.ts",
		"src/worker/entry.ts",
		"src/domains/prompts/fragments/identity/clio.md",
	]) {
		mkdirSync(path.dirname(path.join(cwd, marker)), { recursive: true });
		writeFileSync(path.join(cwd, marker), "fixture\n");
	}
	for (const name of CLIO_SELF_DEVELOPMENT_SKILLS) {
		cpSync(new URL(`../../library/skills/meta/${name}/`, import.meta.url), path.join(cwd, "library/skills/meta", name), {
			recursive: true,
		});
	}
	return { env, cwd };
}

for (const worktree of [false, true]) {
	it(`loads the two checkout skills through normal admission from a ${worktree ? "worktree" : "repository"} subdirectory`, async (t) => {
		const { env, cwd } = await fixture(t, worktree);
		const nested = path.join(cwd, "src");
		const list = loadSkills({ cwd: nested, home: env.dir });
		const source = modelVisibleSkills(list.items).filter((skill) => skill.sourceInfo.source === "self-development");
		deepStrictEqual(
			source.map((skill) => skill.name),
			[...CLIO_SELF_DEVELOPMENT_SKILLS],
		);
		for (const level of AUTONOMY_LEVELS) {
			const context = createContextTool({ getCwd: () => nested, skillMarketplace: false });
			for (const name of CLIO_SELF_DEVELOPMENT_SKILLS) {
				const pendingSkillPolicy = withModelSkillActivation(undefined, modelMayActivateSkills());
				const result = await context.run({ scope: "skills", name }, pendingSkillPolicy ? { pendingSkillPolicy } : {});
				strictEqual(result.kind, modelMayActivateSkills() ? "ok" : "error", level);
				if (result.kind === "ok") {
					ok(pendingSkillPolicy?.loadedSkillNames.has(name));
				} else match(result.message, /only the operator can activate/);
			}
		}
		const bound = withModelSkillActivation(agentSkillToolPolicy(["unrelated-skill"]), true);
		ok(bound);
		const denied = await createContextTool({ getCwd: () => nested }).run(
			{ scope: "skills", name: "clio-coder-dev" },
			{ pendingSkillPolicy: bound },
		);
		strictEqual(denied.kind, "error");
		if (denied.kind === "error") match(denied.message, /only its declared skill/);
	});
}

it("does not discover checkout skills outside the owning repo or when discovery is disabled", async (t) => {
	const { env, cwd } = await fixture(t);
	const nestedRepo = path.join(cwd, "nested");
	mkdirSync(path.join(nestedRepo, ".git"), { recursive: true });
	for (const input of [
		{ cwd, home: env.dir, disableDiscovery: true },
		{ cwd: nestedRepo, home: env.dir },
		{ cwd: env.dir, home: env.dir },
		{ cwd, home: env.dir, roots: [] },
	]) {
		strictEqual(
			loadSkills(input).items.some((skill) => skill.sourceInfo.source === "self-development"),
			false,
		);
	}
	rmSync(path.join(cwd, ".git"), { recursive: true });
	strictEqual(
		loadSkills({ cwd, home: env.dir }).items.some((skill) => skill.sourceInfo.source === "self-development"),
		false,
	);
});

it("honors hidden source skills and refuses source symlinks outside the checkout", async (t) => {
	const { env, cwd } = await fixture(t);
	const devPath = path.join(cwd, "library/skills/meta/clio-coder-dev/SKILL.md");
	writeFileSync(
		devPath,
		readFileSync(devPath, "utf8").replace("name: clio-coder-dev", "name: clio-coder-dev\ndisable-model-invocation: true"),
	);
	const testRoot = path.join(cwd, "library/skills/meta/clio-coder-test");
	const outside = path.join(env.dir, "outside");
	cpSync(testRoot, outside, { recursive: true });
	rmSync(testRoot, { recursive: true });
	symlinkSync(outside, testRoot, "dir");
	const loaded = loadSkills({ cwd, home: env.dir });
	strictEqual(
		modelVisibleSkills(loaded.items).some((skill) => CLIO_SELF_DEVELOPMENT_SKILLS.some((name) => name === skill.name)),
		false,
	);
	strictEqual(
		modelVisibleSkills(loadSkills({ cwd: path.join(cwd, "src"), home: env.dir }).items).some((skill) =>
			CLIO_SELF_DEVELOPMENT_SKILLS.some((name) => name === skill.name),
		),
		false,
	);
	ok(loaded.diagnostics.some((diagnostic) => /outside|escape/i.test(diagnostic.message)));
});

it("installed ownership prevents disabled or damaged packages from falling back to checkout skills", async (t) => {
	const { env, cwd } = await fixture(t);
	for (const [name, state] of [
		["clio-coder-dev", "disabled"],
		["clio-coder-test", "damaged"],
	] as const) {
		const source = path.join(cwd, "library/skills/meta", name);
		const installed = installPlugin(source, {
			cwd,
			scope: "project",
			expectedId: name,
			expectedDigest: pluginContentDigest(source),
		});
		ok(installed.plugin?.loadable, JSON.stringify(installed.diagnostics));
		if (state === "disabled") disablePlugin(name, { cwd, scope: "project" });
		else writeFileSync(path.join(installed.plugin.rootPath, "SKILL.md"), "damaged\n");
	}
	clearPluginSnapshots();
	for (const directory of [cwd, path.join(cwd, "src")]) {
		const loaded = loadSkills({ cwd: directory, home: env.dir });
		strictEqual(
			modelVisibleSkills(loaded.items).some((skill) => CLIO_SELF_DEVELOPMENT_SKILLS.some((name) => name === skill.name)),
			false,
		);
	}
});

for (const overridePath of ["clio-coder-dev/SKILL.md", "clio-coder-dev.md", "custom-name/SKILL.md"]) {
	it(`a native local override at ${overridePath} retains ownership from root and subdirectory`, async (t) => {
		const { env, cwd } = await fixture(t);
		const file = path.join(cwd, ".clio-coder/skills", overridePath);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			"---\nname: clio-coder-dev\ndescription: Local override.\ndisable-model-invocation: true\n---\nLocal\n",
		);
		const loaded = loadSkills({ cwd, home: env.dir });
		strictEqual(loaded.items.find((skill) => skill.name === "clio-coder-dev")?.filePath, file);
		strictEqual(
			modelVisibleSkills(loaded.items).some((skill) => skill.name === "clio-coder-dev"),
			false,
		);
		strictEqual(
			modelVisibleSkills(loadSkills({ cwd: path.join(cwd, "src"), home: env.dir }).items).some(
				(skill) => skill.name === "clio-coder-dev",
			),
			false,
		);
	});
}

it("repo guidance tracks actual skill capability, autonomy and turn restrictions without injecting skill bodies", async (t) => {
	const { cwd } = await fixture(t);
	const context: DomainContext = { bus: createSafeEventBus(), getContract: () => undefined };
	const bundle = createPromptsBundle(context);
	await bundle.extension.start();
	t.after(() => bundle.extension.stop?.());
	async function prompt(sessionInputs: SessionPromptInputs, autonomy = "default", workspace = cwd) {
		return bundle.contract.compileSessionPrompt({ sessionId: "self-dev", cwd: workspace, autonomy, sessionInputs });
	}
	const inputs = { toolNames: ["context"], providerSupportsTools: true, readySkillCount: 2 };
	const automatic = await prompt(inputs);
	match(automatic.systemPrompt, /# Self-development skills/);
	match(automatic.systemPrompt, /without waiting for a separate skill request/);
	strictEqual(automatic.systemPrompt.includes("## Establish the actual assignment"), false);
	for (const disabled of [
		{ ...inputs, skillDiscoveryEnabled: false },
		{ ...inputs, providerSupportsTools: false },
		{ ...inputs, readySkillCount: 0 },
		{ ...inputs, toolNames: ["read"] },
		{ ...inputs, turnConstraints: { skills: "disabled" } },
		{ ...inputs, turnConstraints: { mode: "answer" } },
		{ ...inputs, turnConstraints: { mode: "proposal" } },
		{ ...inputs, turnConstraints: { allowedTools: ["read"] } },
	] satisfies SessionPromptInputs[]) {
		strictEqual(
			(await prompt(disabled)).sections.some((section) => section.id === "context.self-development-skills"),
			false,
		);
	}
	strictEqual(
		(await prompt(inputs, "default", path.dirname(cwd))).systemPrompt.includes("# Self-development skills"),
		false,
	);
	const noSkills = createPromptsBundle(context, { noSkills: true });
	await noSkills.extension.start();
	t.after(() => noSkills.extension.stop?.());
	const suppressed = await noSkills.contract.compileSessionPrompt({ sessionId: "disabled", cwd, sessionInputs: inputs });
	strictEqual(suppressed.systemPrompt.includes("# Self-development skills"), false);
});
