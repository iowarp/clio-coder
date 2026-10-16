import { deepStrictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { interopUserHome } from "../../src/core/xdg.js";
import { discoverInteropInventory } from "../../src/domains/interop/inventory.js";
import { INTEROP_AGENT_KINDS } from "../../src/domains/interop/registry.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function writeSkill(root: string, name: string): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\nBody.\n`);
}

function claudeKind() {
	const kind = INTEROP_AGENT_KINDS.find((candidate) => candidate.id === "claude-code");
	if (!kind) throw new Error("claude-code is not registered");
	return kind;
}

it("a CLIO_CODER_HOME install still loads the operator's ~/.claude skills", async (t) => {
	const env = await isolateClioEnv("clio-interop-home-");
	t.after(() => env.restore());
	const operatorHome = join(env.dir, "operator");
	writeSkill(join(operatorHome, ".claude", "skills"), "operator-only");
	const cwd = join(env.dir, "workspace");
	mkdirSync(cwd, { recursive: true });
	process.env.HOME = operatorHome;
	process.env.XDG_CONFIG_HOME = join(env.dir, "xdg-config");
	delete process.env.CLIO_CODER_INTEROP_HOME;

	deepStrictEqual(
		loadSkills({ cwd }).items.some((item) => item.name === "operator-only"),
		true,
	);
});

it("CLIO_CODER_INTEROP_HOME=none reads no foreign user root, CLAUDE_CONFIG_DIR included", async (t) => {
	const env = await isolateClioEnv("clio-interop-none-");
	t.after(() => env.restore());
	const operatorHome = join(env.dir, "operator");
	const configDir = join(env.dir, "claude-config");
	writeSkill(join(operatorHome, ".claude", "skills"), "operator-only");
	writeSkill(join(configDir, "skills"), "explicit-only");
	const cwd = join(env.dir, "workspace");
	mkdirSync(cwd, { recursive: true });
	process.env.HOME = operatorHome;
	process.env.CLAUDE_CONFIG_DIR = configDir;
	process.env.CLIO_CODER_INTEROP_HOME = "none";
	const names = loadSkills({ cwd }).items.map((item) => item.name);
	const inventory = discoverInteropInventory(claudeKind(), interopUserHome(), cwd, process.env);

	deepStrictEqual(
		names.filter((name) => name === "operator-only" || name === "explicit-only"),
		[],
	);
	deepStrictEqual(
		inventory.items.filter((item) => item.scope === "user"),
		[],
	);
});

it("CLAUDE_CONFIG_DIR skills load and are inventoried from that directory", async (t) => {
	const env = await isolateClioEnv("clio-interop-agent-home-");
	t.after(() => env.restore());
	const configDir = join(env.dir, "claude-config");
	writeSkill(join(configDir, "skills"), "explicit-only");
	const cwd = join(env.dir, "workspace");
	mkdirSync(cwd, { recursive: true });
	process.env.HOME = join(env.dir, "operator");
	process.env.CLAUDE_CONFIG_DIR = configDir;
	process.env.XDG_CONFIG_HOME = join(env.dir, "xdg-config");
	delete process.env.CLIO_CODER_INTEROP_HOME;
	const inventory = discoverInteropInventory(claudeKind(), interopUserHome(), cwd, process.env);

	deepStrictEqual(
		loadSkills({ cwd }).items.some((item) => item.name === "explicit-only"),
		true,
	);
	deepStrictEqual(
		inventory.items.some((item) => item.kind === "skill" && item.scope === "user" && item.path.startsWith(configDir)),
		true,
	);
});

it("opencode skills under XDG_CONFIG_HOME load from the root inventory lists", async (t) => {
	const env = await isolateClioEnv("clio-interop-xdg-");
	t.after(() => env.restore());
	const xdg = join(env.dir, "xdg-config");
	writeSkill(join(xdg, "opencode", "skills"), "xdg-only");
	const cwd = join(env.dir, "workspace");
	mkdirSync(cwd, { recursive: true });
	process.env.HOME = join(env.dir, "operator");
	process.env.XDG_CONFIG_HOME = xdg;
	delete process.env.OPENCODE_CONFIG_DIR;
	delete process.env.CLIO_CODER_INTEROP_HOME;

	deepStrictEqual(
		loadSkills({ cwd }).items.some((item) => item.name === "xdg-only"),
		true,
	);
});
