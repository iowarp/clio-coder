import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	agentSkillToolPolicy,
	mergePendingSkillToolSurface,
	type SkillDeclaredToolPolicy,
} from "../../src/core/skill-activation.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	createResourcesLoader,
	expandSkillInvocationInput,
	formatSkillsCatalogForPrompt,
	loadSkills,
	modelVisibleSkills,
	parsePendingSkillRequests,
	type ResourcesContract,
	type SkillRoot,
} from "../../src/domains/resources/index.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { expandInteractiveSubmit } from "../../src/interactive/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import { createReadSkillTool, createSkillTool } from "../../src/tools/skills.js";

const scratchRoots: string[] = [];

function scratchDir(prefix = "clio-skills-"): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	scratchRoots.push(root);
	return root;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function writeSkillDir(root: string, name: string, frontmatter: string[], body = "Skill body."): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const content = ["---", ...frontmatter, "---", "", body, ""].join("\n");
	const file = join(dir, "SKILL.md");
	writeFileSync(file, content, "utf8");
	return file;
}

function projectRoot(path: string): SkillRoot {
	return { path, scope: "project", source: "clio", origin: "project" };
}

function userRoot(path: string): SkillRoot {
	return { path, scope: "user", source: "clio", origin: "config" };
}

function allowAllSafety(): SafetyContract {
	return {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: {
			readonly: READONLY_SCOPE,
			workspace: WORKSPACE_SCOPE,
			confirmed: CONFIRMED_SCOPE,
		},
		isSubset,
		audit: { recordCount: () => 0 },
	};
}

function pendingPolicy(name: string, args = "test task") {
	return {
		allowedSkillNames: [name],
		requests: [{ name, args, source: "slash-command" as const, installed: true }],
		loadedSkillNames: new Set<string>(),
		loadedSkillPolicies: new Map<string, SkillDeclaredToolPolicy>(),
		toolsExpanded: false,
	};
}

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("contracts/skills loader normalization", () => {
	it("loads a valid skill with stable hash and captured metadata", () => {
		const root = scratchDir();
		writeSkillDir(root, "review-tests", [
			'name: "review-tests"',
			'description: "Use when reviewing test coverage."',
			'license: "MIT"',
			'version: "1.2.0"',
			"allowed-tools:",
			"  - Read",
			"  - Grep",
		]);
		const list = loadSkills({ roots: [projectRoot(root)] });
		strictEqual(list.items.length, 1);
		const skill = list.items[0];
		ok(skill);
		strictEqual(skill.name, "review-tests");
		strictEqual(skill.description, "Use when reviewing test coverage.");
		strictEqual(skill.scope, "project");
		strictEqual(skill.source, "clio");
		strictEqual(skill.trusted, true);
		match(skill.hash, /^[0-9a-f]{64}$/);
		strictEqual(skill.metadata.license, "MIT");
		strictEqual(skill.metadata.version, "1.2.0");
		deepStrictEqual(skill.allowedTools, ["Read", "Grep"]);
		strictEqual("allowed-tools" in skill.metadata, false);
	});

	it("rejects a skill that is missing a description", () => {
		const root = scratchDir();
		writeSkillDir(root, "no-desc", ['name: "no-desc"']);
		const list = loadSkills({ roots: [projectRoot(root)] });
		strictEqual(list.items.length, 0);
		ok(list.diagnostics.some((d) => d.message.includes("description is required")));
	});

	it("warns but loads on name/path mismatch and uses the frontmatter name", () => {
		const root = scratchDir();
		writeSkillDir(root, "folder-name", ['name: "canonical-name"', 'description: "Mismatch case."']);
		const list = loadSkills({ roots: [projectRoot(root)] });
		strictEqual(list.items.length, 1);
		const skill = list.items[0];
		ok(skill);
		strictEqual(skill.name, "canonical-name");
		strictEqual(skill.pathSubject, "folder-name");
		ok(skill.diagnostics.some((d) => d.message.includes("differs from path subject")));
	});

	it("warns but loads on invalid name format", () => {
		const root = scratchDir();
		writeSkillDir(root, "Bad_Name", ['name: "Bad_Name"', 'description: "Invalid name format."']);
		const list = loadSkills({ roots: [projectRoot(root)] });
		strictEqual(list.items.length, 1);
		ok(list.diagnostics.some((d) => d.message.includes("invalid characters")));
	});

	it("keeps disable-model-invocation skills listed but out of the model catalog", () => {
		const root = scratchDir();
		writeSkillDir(root, "manual-only", [
			'name: "manual-only"',
			'description: "Only via slash command."',
			"disable-model-invocation: true",
		]);
		const list = loadSkills({ roots: [projectRoot(root)] });
		strictEqual(list.items.length, 1);
		strictEqual(modelVisibleSkills(list.items).length, 0);
		strictEqual(formatSkillsCatalogForPrompt(list), "");
	});

	it("resolves collisions by precedence: clio project overrides clio user", () => {
		const userDir = scratchDir();
		const projectDir = scratchDir();
		writeSkillDir(userDir, "dup", ['name: "dup"', 'description: "User version."'], "USER BODY");
		writeSkillDir(projectDir, "dup", ['name: "dup"', 'description: "Project version."'], "PROJECT BODY");
		const list = loadSkills({ roots: [userRoot(userDir), projectRoot(projectDir)] });
		strictEqual(list.items.length, 1);
		const skill = list.items[0];
		ok(skill);
		strictEqual(skill.content, "PROJECT BODY");
		ok(list.diagnostics.some((d) => d.type === "collision"));
	});

	it("resolves collisions by precedence: clio project overrides project compat", () => {
		const compatDir = scratchDir();
		const clioDir = scratchDir();
		writeSkillDir(compatDir, "dup", ['name: "dup"', 'description: "Compat version."'], "COMPAT BODY");
		writeSkillDir(clioDir, "dup", ['name: "dup"', 'description: "Clio version."'], "CLIO BODY");
		const compatRoot: SkillRoot = {
			path: compatDir,
			scope: "project",
			source: "codex",
			origin: "codex-project",
			precedence: 40,
			trusted: false,
		};
		const list = loadSkills({ roots: [compatRoot, projectRoot(clioDir)] });
		strictEqual(list.items.length, 1);
		const skill = list.items[0];
		ok(skill);
		strictEqual(skill.content, "CLIO BODY");
	});

	it("dedups skills whose symlinked paths resolve to the same SKILL.md", () => {
		const realRoot = scratchDir();
		const aliasRoot = scratchDir();
		writeSkillDir(realRoot, "linked-skill", ['name: "linked-skill"', 'description: "Canonical skill."'], "REAL BODY");
		symlinkSync(join(realRoot, "linked-skill"), join(aliasRoot, "linked-skill"), "dir");
		const list = loadSkills({ roots: [userRoot(realRoot), projectRoot(aliasRoot)] });
		strictEqual(list.items.length, 1);
		const skill = list.items[0];
		ok(skill);
		strictEqual(skill.name, "linked-skill");
		strictEqual(skill.content, "REAL BODY");
		ok(list.diagnostics.some((diag) => diag.message.includes("same canonical skill file")));
	});

	it("hashes are stable across loads and change with content", () => {
		const root = scratchDir();
		const file = writeSkillDir(root, "hashing", ['name: "hashing"', 'description: "Hash stability."'], "ONE");
		const first = loadSkills({ roots: [projectRoot(root)] }).items[0];
		const second = loadSkills({ roots: [projectRoot(root)] }).items[0];
		ok(first && second);
		strictEqual(first.hash, second.hash);
		writeFileSync(file, ["---", 'name: "hashing"', 'description: "Hash stability."', "---", "", "TWO", ""].join("\n"));
		const third = loadSkills({ roots: [projectRoot(root)] }).items[0];
		ok(third);
		ok(third.hash !== first.hash);
	});
});

describe("contracts/skills compatibility roots", () => {
	it("discovers shared user Agent Skills, Claude, Codex, OpenCode, and Copilot roots", () => {
		const home = scratchDir("clio-home-");
		const project = scratchDir("clio-proj-");
		const config = scratchDir("clio-cfg-");
		writeSkillDir(join(home, ".agents", "skills"), "agents-skill", [
			'name: "agents-skill"',
			'description: "From agents root."',
		]);
		writeSkillDir(join(home, ".codex", "skills"), "codex-skill", [
			'name: "codex-skill"',
			'description: "From codex root."',
		]);
		writeSkillDir(join(home, ".claude", "skills"), "claude-skill", [
			'name: "claude-skill"',
			'description: "From claude root."',
		]);
		writeSkillDir(join(home, ".config", "opencode", "skills"), "opencode-skill", [
			'name: "opencode-skill"',
			'description: "From opencode root."',
		]);
		writeSkillDir(join(home, ".copilot", "skills"), "copilot-skill", [
			'name: "copilot-skill"',
			'description: "From copilot root."',
		]);
		const list = loadSkills({ cwd: project, home, configDir: config });
		const names = list.items.map((s) => s.name);
		ok(names.includes("agents-skill"));
		ok(names.includes("codex-skill"));
		ok(names.includes("claude-skill"));
		ok(names.includes("opencode-skill"));
		ok(names.includes("copilot-skill"));
		const agents = list.items.find((s) => s.name === "agents-skill");
		ok(agents);
		strictEqual(agents.source, "agents");
		strictEqual(agents.scope, "user");
		strictEqual(agents.trusted, true);
		const claude = list.items.find((s) => s.name === "claude-skill");
		ok(claude);
		strictEqual(claude.source, "claude");
		const opencode = list.items.find((s) => s.name === "opencode-skill");
		ok(opencode);
		strictEqual(opencode.source, "opencode");
		const copilot = list.items.find((s) => s.name === "copilot-skill");
		ok(copilot);
		strictEqual(copilot.source, "copilot");
	});

	it("treats project compat roots as untrusted by default", () => {
		const home = scratchDir("clio-home-");
		const project = scratchDir("clio-proj-");
		const config = scratchDir("clio-cfg-");
		writeSkillDir(join(project, ".codex", "skills"), "proj-compat", [
			'name: "proj-compat"',
			'description: "Project compat skill."',
		]);
		writeSkillDir(join(project, ".claude", "skills"), "proj-claude", [
			'name: "proj-claude"',
			'description: "Project Claude skill."',
		]);
		writeSkillDir(join(project, ".opencode", "skills"), "proj-opencode", [
			'name: "proj-opencode"',
			'description: "Project OpenCode skill."',
		]);
		writeSkillDir(join(project, ".github", "skills"), "proj-copilot", [
			'name: "proj-copilot"',
			'description: "Project Copilot skill."',
		]);
		const list = loadSkills({ cwd: project, home, configDir: config });
		const skill = list.items.find((s) => s.name === "proj-compat");
		ok(skill);
		strictEqual(skill.trusted, false);
		for (const name of ["proj-claude", "proj-opencode", "proj-copilot"]) {
			const projectSkill = list.items.find((s) => s.name === name);
			ok(projectSkill);
			strictEqual(projectSkill.trusted, false);
		}
		strictEqual(
			modelVisibleSkills(list.items).some((s) => s.name === "proj-compat"),
			false,
		);
		strictEqual(formatSkillsCatalogForPrompt(list), "");
	});

	it("trusts project compat roots when opted in", () => {
		const home = scratchDir("clio-home-");
		const project = scratchDir("clio-proj-");
		const config = scratchDir("clio-cfg-");
		writeSkillDir(join(project, ".agents", "skills"), "proj-optin", [
			'name: "proj-optin"',
			'description: "Opted-in compat skill."',
		]);
		const list = loadSkills({ cwd: project, home, configDir: config, trustProjectCompatRoots: true });
		const skill = list.items.find((s) => s.name === "proj-optin");
		ok(skill);
		strictEqual(skill.trusted, true);
		ok(modelVisibleSkills(list.items).some((s) => s.name === "proj-optin"));
	});

	it("threads project compat trust through createResourcesLoader", () => {
		const project = scratchDir("clio-proj-");
		writeSkillDir(join(project, ".codex", "skills"), "proj-loader", [
			'name: "proj-loader"',
			'description: "Project compat through resources loader."',
		]);
		const loader = createResourcesLoader({
			cwd: project,
			skills: () => ({ trustProjectCompatRoots: true }),
		});
		const skill = loader.skills(project).items.find((entry) => entry.name === "proj-loader");
		ok(skill);
		strictEqual(skill.trusted, true);
		ok(loader.skillsCatalog(project).includes("proj-loader"));
	});
});

describe("contracts/skills prompt catalog", () => {
	it("emits a catalog hash and per-skill source for visible skills", () => {
		const root = scratchDir();
		writeSkillDir(root, "visible", ['name: "visible"', 'description: "Catalog entry."']);
		const list = loadSkills({ roots: [projectRoot(root)] });
		const catalog = formatSkillsCatalogForPrompt(list);
		ok(catalog.startsWith("# Skills"));
		match(catalog, /catalog_hash="[0-9a-f]{12}"/);
		match(catalog, /source="clio"/);
		match(catalog, /origin="project"/);
		ok(catalog.includes("<description>Catalog entry.</description>"));
	});

	it("preserves extension skill root origin in model-visible descriptors", () => {
		const root = scratchDir();
		writeSkillDir(root, "extension-visible", ['name: "extension-visible"', 'description: "Extension catalog entry."']);
		const list = loadSkills({
			roots: [
				{
					path: root,
					scope: "package",
					source: "extension",
					origin: "extension:user:test-pack",
					trusted: true,
				},
			],
		});
		const catalog = formatSkillsCatalogForPrompt(list);
		match(catalog, /source="extension"/);
		match(catalog, /origin="extension:user:test-pack"/);
	});
});

describe("contracts/skills slash-command parity", () => {
	it("expands /skill:name with trailing args from the loaded list", () => {
		const root = scratchDir();
		writeSkillDir(root, "expandable", ['name: "expandable"', 'description: "Expand me."'], "FOLLOW STEPS");
		const list = loadSkills({ roots: [projectRoot(root)] });
		const expansion = expandSkillInvocationInput("/skill:expandable do the thing", list);
		strictEqual(expansion.expanded, true);
		strictEqual(expansion.text, "do the thing");
		strictEqual(expansion.text.includes("FOLLOW STEPS"), false);
		if (expansion.expanded) {
			strictEqual(expansion.skill.name, "expandable");
			strictEqual(expansion.triggeredBy, "slash-command");
		}
	});

	it("expands /skills:name as the interactive plural alias", () => {
		const root = scratchDir();
		writeSkillDir(root, "grill-me", ['name: "grill-me"', 'description: "Interview skill."'], "ASK ONE QUESTION");
		const list = loadSkills({ roots: [projectRoot(root)] });
		const expansion = expandSkillInvocationInput("/skills:grill-me about adding science skills", list);
		strictEqual(expansion.expanded, true);
		strictEqual(expansion.text, "about adding science skills");
		strictEqual(expansion.text.includes("ASK ONE QUESTION"), false);
		if (expansion.expanded) {
			strictEqual(expansion.skill.name, "grill-me");
			strictEqual(expansion.triggeredBy, "slash-command");
		}
	});

	it("ignores quoted trigger phrases even when the deprecated opt-in flag is passed", () => {
		const root = scratchDir();
		writeSkillDir(
			root,
			"grill-me",
			['name: "grill-me"', 'description: \'Use when interviewing. Triggers on "grill me", "interview me".\''],
			"ASK ONE QUESTION",
		);
		const list = loadSkills({ roots: [projectRoot(root)] });
		const expansion = expandSkillInvocationInput("grill me about adding science skills", list, {
			naturalLanguageTriggers: true,
		});
		strictEqual(expansion.expanded, false);
		strictEqual(expansion.text, "grill me about adding science skills");
		strictEqual(expansion.text.includes("ASK ONE QUESTION"), false);
	});

	it("does not expand quoted trigger phrases unless interactive mode opts in", () => {
		const root = scratchDir();
		writeSkillDir(
			root,
			"grill-me",
			['name: "grill-me"', "description: 'Use when interviewing. Triggers on \"grill me\".'"],
			"ASK ONE QUESTION",
		);
		const list = loadSkills({ roots: [projectRoot(root)] });
		const expansion = expandSkillInvocationInput("grill me about adding science skills", list);
		strictEqual(expansion.expanded, false);
		strictEqual(expansion.text, "grill me about adding science skills");
	});

	it("does not trigger hidden model-invocation skills from plain text", () => {
		const root = scratchDir();
		writeSkillDir(root, "hidden", [
			'name: "hidden"',
			"description: 'Use when hidden. Triggers on \"grill me\".'",
			"disable-model-invocation: true",
		]);
		const list = loadSkills({ roots: [projectRoot(root)] });
		const expansion = expandSkillInvocationInput("grill me about hidden things", list, {
			naturalLanguageTriggers: true,
		});
		strictEqual(expansion.expanded, false);
		strictEqual(expansion.text, "grill me about hidden things");
	});

	it("parses explicit slash skill requests into clean pending request state", () => {
		const root = scratchDir();
		const filePath = writeSkillDir(
			root,
			"grill-me",
			['name: "grill-me"', 'description: "Interview skill."'],
			"ASK ONE QUESTION",
		);
		const list = loadSkills({ roots: [projectRoot(root)] });
		const parsed = parsePendingSkillRequests("/skill:grill-me adding more science skills", list);
		strictEqual(parsed.text, "adding more science skills");
		strictEqual(parsed.pendingSkillRequests.length, 1);
		const pending = parsed.pendingSkillRequests[0];
		ok(pending);
		strictEqual(pending.name, "grill-me");
		strictEqual(pending.args, "adding more science skills");
		strictEqual(pending.source, "slash-command");
		strictEqual(pending.installed, true);
		strictEqual(pending.filePath, filePath);
	});

	it("does not parse plain skill-management text into pending request state", () => {
		const root = scratchDir();
		writeSkillDir(root, "grill-me", ['name: "grill-me"', 'description: "Interview skill."'], "ASK ONE QUESTION");
		const list = loadSkills({ roots: [projectRoot(root)] });
		const parsed = parsePendingSkillRequests("adding more science skills to clio coder", list, {
			naturalLanguageTriggers: true,
		});
		strictEqual(parsed.text, "adding more science skills to clio coder");
		strictEqual(parsed.pendingSkillRequests.length, 0);
	});

	it("interactive submit asks the model to load slash-command skills without preloading the body", () => {
		const root = scratchDir();
		writeSkillDir(root, "expandable", ['name: "expandable"', 'description: "Expand me."'], "FOLLOW STEPS");
		const list = loadSkills({ roots: [projectRoot(root)] });
		const resources: ResourcesContract = {
			contextFiles: () => [],
			renderContextFiles: () => "",
			skills: () => list,
			skillsCatalog: () => formatSkillsCatalogForPrompt(list),
			expandSkillInvocation: (text, _cwd, options) => expandSkillInvocationInput(text, list, options),
			parsePendingSkillRequests: (text, _cwd, options) => {
				const expansion = expandSkillInvocationInput(text, list, options);
				return {
					text: expansion.text,
					pendingSkillRequests: expansion.expanded
						? [
								{
									name: expansion.skill.name,
									args: expansion.args,
									source: "slash-command" as const,
									installed: true,
								},
							]
						: [],
				};
			},
			expandPromptTemplate: (text: string) => ({ expanded: false as const, text, args: [], diagnostics: [] }),
			prompts: () => ({ items: [], diagnostics: [] }),
			themes: () => ({ items: [], diagnostics: [] }),
			resolvePath: (value: string) => value,
			reload: async () => undefined,
		};
		const expanded = expandInteractiveSubmit("/skill:expandable do the thing", resources);
		strictEqual(expanded.pendingSkillRequests.length, 1);
		strictEqual(expanded.text, "do the thing");
		strictEqual(expanded.text.includes("FOLLOW STEPS"), false);
	});

	it("interactive submit does not auto-activate prompt-triggered skills from plain text", () => {
		const root = scratchDir();
		writeSkillDir(
			root,
			"grill-me",
			['name: "grill-me"', "description: 'Use when interviewing. Triggers on \"grill me\".'"],
			"ASK ONE QUESTION",
		);
		const list = loadSkills({ roots: [projectRoot(root)] });
		const resources: ResourcesContract = {
			contextFiles: () => [],
			renderContextFiles: () => "",
			skills: () => list,
			skillsCatalog: () => formatSkillsCatalogForPrompt(list),
			expandSkillInvocation: (text, _cwd, options) => expandSkillInvocationInput(text, list, options),
			parsePendingSkillRequests: (text, _cwd, options) => {
				const expansion = expandSkillInvocationInput(text, list, options);
				return {
					text: expansion.text,
					pendingSkillRequests: expansion.expanded
						? [
								{
									name: expansion.skill.name,
									args: expansion.args,
									source: "slash-command" as const,
									installed: true,
								},
							]
						: [],
				};
			},
			expandPromptTemplate: (text: string) => ({ expanded: false as const, text, args: [], diagnostics: [] }),
			prompts: () => ({ items: [], diagnostics: [] }),
			themes: () => ({ items: [], diagnostics: [] }),
			resolvePath: (value: string) => value,
			reload: async () => undefined,
		};
		const expanded = expandInteractiveSubmit("grill me about science skills", resources);
		strictEqual(expanded.pendingSkillRequests.length, 0);
		strictEqual(expanded.text, "grill me about science skills");
		strictEqual(expanded.text.includes("ASK ONE QUESTION"), false);
	});

	it("leaves non-skill input untouched", () => {
		const list = loadSkills({ roots: [] });
		const expansion = expandSkillInvocationInput("just a normal message", list);
		strictEqual(expansion.expanded, false);
		strictEqual(expansion.text, "just a normal message");
	});
});

describe("contracts/skills tools", () => {
	const ORIGINAL_ENV = { ...process.env };
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-skill-tools-"));
		process.env.HOME = scratch;
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
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

	it("read_skill returns structured metadata, hash, base_dir, and body", async () => {
		const cwd = join(scratch, "project");
		writeSkillDir(
			join(cwd, ".clio", "skills"),
			"readable",
			['name: "readable"', 'description: "Readable skill."', 'license: "MIT"'],
			"READ ME BODY",
		);
		const tool = createReadSkillTool({ getCwd: () => cwd });
		const result = await tool.run({ name: "readable" }, { pendingSkillPolicy: pendingPolicy("readable") });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("READ ME BODY"));
		const details = result.details as Record<string, unknown>;
		strictEqual(details.name, "readable");
		match(String(details.hash), /^[0-9a-f]{64}$/);
		strictEqual(details.scope, "project");
		strictEqual(details.sourceOrigin, "project");
		ok(String(details.baseDir).includes(".clio"));
	});

	it("read_skill pending policy rejects non-requested and repeated skill loads", async () => {
		const cwd = join(scratch, "project");
		writeSkillDir(
			join(cwd, ".clio", "skills"),
			"grill-me",
			['name: "grill-me"', 'description: "Interview skill."'],
			"ASK ONE QUESTION",
		);
		writeSkillDir(
			join(cwd, ".clio", "skills"),
			"context-prime",
			['name: "context-prime"', 'description: "Context skill."'],
			"PRIME CONTEXT",
		);
		const policy = pendingPolicy("grill-me", "about adding science skills");
		const tool = createReadSkillTool({ getCwd: () => cwd });

		const wrong = await tool.run({ name: "context-prime" }, { pendingSkillPolicy: policy });
		strictEqual(wrong.kind, "error");
		if (wrong.kind === "error") {
			strictEqual(
				wrong.message,
				"read_skill: this turn has pending skill request(s): grill-me. Load only those before doing anything else.",
			);
		}

		const first = await tool.run({ name: "grill-me" }, { pendingSkillPolicy: policy });
		strictEqual(first.kind, "ok");
		ok(policy.loadedSkillNames.has("grill-me"));
		ok(policy.loadedSkillPolicies.has("grill-me"));

		const repeated = await tool.run({ name: "grill-me" }, { pendingSkillPolicy: policy });
		strictEqual(repeated.kind, "error");
		if (repeated.kind === "error") {
			strictEqual(
				repeated.message,
				"read_skill: pending skill grill-me already loaded this turn; continue with the loaded workflow and call ask_user if an interview/choice is needed.",
			);
		}
	});

	it("read_skill activation is emitted by the registry with turn metadata", async () => {
		const cwd = join(scratch, "project");
		writeSkillDir(
			join(cwd, ".clio", "skills"),
			"readable",
			['name: "readable"', 'description: "Readable skill."'],
			"READ ME BODY",
		);
		const activations: Array<{
			name: string;
			filePath: string;
			hash: string;
			source: string;
			sourceOrigin?: string;
			triggeredBy: string;
			turnId?: string;
		}> = [];
		const registry = createRegistry({
			safety: allowAllSafety(),
			onSkillActivation: (activation) => activations.push(activation),
		});
		registry.register(createReadSkillTool({ getCwd: () => cwd }));

		const missing = await registry.invoke(
			{ tool: ToolNames.ReadSkill, args: { name: "missing" } },
			{ turnId: "turn-1", pendingSkillPolicy: pendingPolicy("missing") },
		);
		strictEqual(missing.kind, "ok");
		if (missing.kind === "ok") strictEqual(missing.result.kind, "error");
		strictEqual(activations.length, 0);

		const result = await registry.invoke(
			{ tool: ToolNames.ReadSkill, args: { name: "readable" } },
			{ turnId: "turn-1", pendingSkillPolicy: pendingPolicy("readable") },
		);
		strictEqual(result.kind, "ok");
		strictEqual(activations.length, 1);
		const activation = activations[0];
		ok(activation);
		strictEqual(activation.name, "readable");
		strictEqual(activation.triggeredBy, "tool");
		strictEqual(activation.turnId, "turn-1");
		match(activation.hash, /^[0-9a-f]{64}$/);
		strictEqual(activation.sourceOrigin, "project");
		ok(activation.filePath.endsWith("SKILL.md"));
	});

	it("read_skill annotates marketplace provenance drift without blocking", async () => {
		const cwd = join(scratch, "project");
		const skillPath = writeSkillDir(
			join(cwd, ".clio", "skills"),
			"pinned",
			['name: "pinned"', 'description: "Pinned skill."', 'registry-id: "pinned"'],
			"PINNED BODY",
		);
		const manifestDir = join(cwd, "skills");
		mkdirSync(manifestDir, { recursive: true });
		const tool = createReadSkillTool({ getCwd: () => cwd });
		const skillHash = sha256(readFileSync(skillPath, "utf8"));

		writeFileSync(
			join(manifestDir, "registry.yaml"),
			["skills:", "  - name: pinned", "    version: 1.0.0", `    sha256: ${skillHash}`, ""].join("\n"),
			"utf8",
		);
		const matchResult = await tool.run({ name: "pinned" }, { pendingSkillPolicy: pendingPolicy("pinned") });
		strictEqual(matchResult.kind, "ok");
		if (matchResult.kind !== "ok") return;
		strictEqual((matchResult.details as Record<string, unknown>).drift, "match");
		strictEqual(matchResult.output.includes("skill_drift"), false);

		writeFileSync(
			join(manifestDir, "registry.yaml"),
			["skills:", "  - name: pinned", "    version: 1.0.0", `    sha256: ${"b".repeat(64)}`, ""].join("\n"),
			"utf8",
		);
		const mismatchResult = await tool.run({ name: "pinned" }, { pendingSkillPolicy: pendingPolicy("pinned") });
		strictEqual(mismatchResult.kind, "ok");
		if (mismatchResult.kind !== "ok") return;
		strictEqual((mismatchResult.details as Record<string, unknown>).drift, "mismatch");
		ok(mismatchResult.output.includes("WARNING skill_drift"));

		rmSync(join(manifestDir, "registry.yaml"), { force: true });
		const absentResult = await tool.run({ name: "pinned" }, { pendingSkillPolicy: pendingPolicy("pinned") });
		strictEqual(absentResult.kind, "ok");
		if (absentResult.kind !== "ok") return;
		strictEqual((absentResult.details as Record<string, unknown>).drift, undefined);
	});

	it("read_skill include_tree lists sibling resources without executing them", async () => {
		const cwd = join(scratch, "project");
		const dir = join(cwd, ".clio", "skills", "with-tree");
		mkdirSync(join(dir, "scripts"), { recursive: true });
		mkdirSync(join(dir, "references"), { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			["---", 'name: "with-tree"', 'description: "Has resources."', "---", "", "Body.", ""].join("\n"),
		);
		writeFileSync(join(dir, "scripts", "run.sh"), "echo hi\n");
		writeFileSync(join(dir, "references", "doc.md"), "# Doc\n");
		const tool = createReadSkillTool({ getCwd: () => cwd });
		const result = await tool.run(
			{ name: "with-tree", include_tree: true },
			{ pendingSkillPolicy: pendingPolicy("with-tree") },
		);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("resources:"));
		ok(result.output.includes("scripts/run.sh"));
		ok(result.output.includes("references/doc.md"));
	});

	it("read_skill refuses skills hidden from model invocation", async () => {
		const cwd = join(scratch, "project");
		writeSkillDir(join(cwd, ".clio", "skills"), "hidden", [
			'name: "hidden"',
			'description: "Hidden skill."',
			"disable-model-invocation: true",
		]);
		const tool = createReadSkillTool({ getCwd: () => cwd });
		const result = await tool.run({ name: "hidden" }, { pendingSkillPolicy: pendingPolicy("hidden") });
		strictEqual(result.kind, "error");
	});

	it("create_skill writes a SKILL.md folder", async () => {
		const cwd = join(scratch, "project");
		mkdirSync(cwd, { recursive: true });
		const tool = createSkillTool({ getCwd: () => cwd });
		const result = await tool.run({
			name: "made-skill",
			description: "A created skill.",
			body: "# Steps\n\nDo work.",
		});
		strictEqual(result.kind, "ok");
		const file = join(cwd, ".clio", "skills", "made-skill", "SKILL.md");
		ok(existsSync(file));
		const content = readFileSync(file, "utf8");
		ok(content.includes("name: made-skill"));
		ok(content.includes("description: A created skill."));
		ok(content.includes("Do work."));
	});

	it("create_skill with_scaffold creates resource folders", async () => {
		const cwd = join(scratch, "project");
		mkdirSync(cwd, { recursive: true });
		const tool = createSkillTool({ getCwd: () => cwd });
		const result = await tool.run({
			name: "scaffold-skill",
			description: "Scaffolded skill.",
			body: "Body.",
			with_scaffold: true,
		});
		strictEqual(result.kind, "ok");
		const base = join(cwd, ".clio", "skills", "scaffold-skill");
		ok(existsSync(join(base, "scripts")));
		ok(existsSync(join(base, "references")));
		ok(existsSync(join(base, "assets")));
	});

	it("create_skill refuses to overwrite without the overwrite flag", async () => {
		const cwd = join(scratch, "project");
		mkdirSync(cwd, { recursive: true });
		const tool = createSkillTool({ getCwd: () => cwd });
		const first = await tool.run({ name: "dup-skill", description: "First.", body: "One." });
		strictEqual(first.kind, "ok");
		const second = await tool.run({ name: "dup-skill", description: "Second.", body: "Two." });
		strictEqual(second.kind, "error");
		const third = await tool.run({ name: "dup-skill", description: "Third.", body: "Three.", overwrite: true });
		strictEqual(third.kind, "ok");
	});

	it("create_skill renders optional frontmatter that round-trips through the loader", async () => {
		const cwd = join(scratch, "project");
		mkdirSync(cwd, { recursive: true });
		const tool = createSkillTool({ getCwd: () => cwd });
		const result = await tool.run({
			name: "rich-skill",
			description: "Rich frontmatter skill.",
			body: "Body.",
			license: "Apache-2.0",
			allowed_tools: ["Read", "Edit"],
		});
		strictEqual(result.kind, "ok");
		const list = loadSkills({ roots: [projectRoot(join(cwd, ".clio", "skills"))] });
		const skill = list.items.find((s) => s.name === "rich-skill");
		ok(skill);
		strictEqual(skill.metadata.license, "Apache-2.0");
		deepStrictEqual(skill.allowedTools, ["Read", "Edit"]);
	});

	it("read_skill with a recipe-bound policy admits exactly the declared skills", async () => {
		const cwd = join(scratch, "project");
		writeSkillDir(join(cwd, ".clio", "skills"), "cut-it", ['name: "cut-it"', 'description: "Slice plans."'], "SLICE");
		writeSkillDir(join(cwd, ".clio", "skills"), "other", ['name: "other"', 'description: "Other skill."'], "OTHER");
		const policy = agentSkillToolPolicy(["cut-it"]);
		ok(policy);
		strictEqual(policy.toolsExpanded, true);
		const tool = createReadSkillTool({ getCwd: () => cwd });

		const denied = await tool.run({ name: "other" }, { pendingSkillPolicy: policy });
		strictEqual(denied.kind, "error");
		if (denied.kind === "error") {
			strictEqual(denied.message, "read_skill: this agent run may load only its declared skill(s): cut-it.");
		}

		const loaded = await tool.run({ name: "cut-it" }, { pendingSkillPolicy: policy });
		strictEqual(loaded.kind, "ok");
		if (loaded.kind === "ok") {
			ok(loaded.output.includes("SLICE"));
			strictEqual(loaded.output.includes("Pending skill request"), false);
		}

		const repeated = await tool.run({ name: "cut-it" }, { pendingSkillPolicy: policy });
		strictEqual(repeated.kind, "error");
		if (repeated.kind === "error") {
			strictEqual(repeated.message, "read_skill: skill cut-it is already loaded in this run; continue with its workflow.");
		}
	});

	it("read_skill records the skill's declared tool policy on the pending policy", async () => {
		const cwd = join(scratch, "project");
		writeSkillDir(
			join(cwd, ".clio", "skills"),
			"narrow",
			[
				'name: "narrow"',
				'description: "Narrow tool surface."',
				"allowed-tools:",
				"  - read",
				"  - grep",
				"disallowed-tools:",
				"  - bash",
			],
			"NARROW BODY",
		);
		const policy = pendingPolicy("narrow");
		const tool = createReadSkillTool({ getCwd: () => cwd });
		const result = await tool.run({ name: "narrow" }, { pendingSkillPolicy: policy });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const details = result.details as Record<string, unknown>;
		deepStrictEqual(details.allowedTools, ["read", "grep"]);
		deepStrictEqual(details.disallowedTools, ["bash"]);
		deepStrictEqual(policy.loadedSkillPolicies.get("narrow"), {
			allowedTools: ["read", "grep"],
			disallowedTools: ["bash"],
		});
	});

	it("diagnostics warn about missing skill requirements", () => {
		const root = scratchDir();
		writeSkillDir(root, "dep-skill", [
			'name: "dep-skill"',
			'description: "Dependent skill."',
			"requires:",
			"  - skill:non-existent-skill",
		]);
		const list = loadSkills({ roots: [projectRoot(root)] });
		strictEqual(list.items.length, 1);
		const warnings = list.diagnostics.map((d) => d.message);
		ok(warnings.some((w) => w.includes('requires skill "non-existent-skill"')));
	});
});

describe("contracts/skills post-activation tool surface merge", () => {
	const HOST = ["read", "grep", "edit", "write", "bash", "read_skill", "ask_user"];

	function loadedPolicy(
		entries: Array<[string, SkillDeclaredToolPolicy]>,
		allowedSkillNames = entries.map(([name]) => name),
	) {
		return {
			allowedSkillNames,
			loadedSkillNames: new Set(entries.map(([name]) => name)),
			loadedSkillPolicies: new Map(entries),
		};
	}

	it("returns null before any skill has loaded", () => {
		strictEqual(
			mergePendingSkillToolSurface(HOST, {
				allowedSkillNames: ["grill-me"],
				loadedSkillNames: new Set(),
				loadedSkillPolicies: new Map(),
			}),
			null,
		);
	});

	it("expands to the full host surface when the loaded skill declares no policy", () => {
		const merged = mergePendingSkillToolSurface(HOST, loadedPolicy([["grill-me", {}]]));
		deepStrictEqual(merged, ["read", "grep", "edit", "write", "bash", "ask_user"]);
	});

	it("intersects a declared allowed-tools list with host policy: host always wins", () => {
		const merged = mergePendingSkillToolSurface(
			HOST,
			loadedPolicy([["narrow", { allowedTools: ["read", "grep", "dispatch", "rm_rf_everything"] }]]),
		);
		deepStrictEqual(merged, ["read", "grep", "ask_user"]);
	});

	it("subtracts disallowed-tools as self-restriction", () => {
		const merged = mergePendingSkillToolSurface(
			HOST,
			loadedPolicy([["careful", { disallowedTools: ["bash", "write"] }]]),
		);
		deepStrictEqual(merged, ["read", "grep", "edit", "ask_user"]);
	});

	it("keeps ask_user through allowed-tools narrowing but honors an explicit disallow", () => {
		const narrowed = mergePendingSkillToolSurface(HOST, loadedPolicy([["narrow", { allowedTools: ["read"] }]]));
		ok(narrowed?.includes("ask_user"));
		const disallowed = mergePendingSkillToolSurface(
			HOST,
			loadedPolicy([["silent", { allowedTools: ["read"], disallowedTools: ["ask_user"] }]]),
		);
		strictEqual(disallowed?.includes("ask_user"), false);
	});

	it("keeps read_skill only while requested skills remain unloaded", () => {
		const partial = mergePendingSkillToolSurface(HOST, loadedPolicy([["first", {}]], ["first", "second"]));
		ok(partial?.includes("read_skill"));
		const complete = mergePendingSkillToolSurface(HOST, loadedPolicy([["first", {}]]));
		strictEqual(complete?.includes("read_skill"), false);
	});

	it("unions declarations when several requested skills loaded", () => {
		const merged = mergePendingSkillToolSurface(
			HOST,
			loadedPolicy([
				["alpha", { allowedTools: ["read"] }],
				["beta", { allowedTools: ["grep", "edit"] }],
			]),
		);
		deepStrictEqual(merged, ["read", "grep", "edit", "ask_user"]);
	});
});
