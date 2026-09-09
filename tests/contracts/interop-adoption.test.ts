import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyInteropAdoption, planInteropAdoption } from "../../src/domains/interop/adopt.js";
import { discoverInteropInventory } from "../../src/domains/interop/inventory.js";
import { interopAgentKind } from "../../src/domains/interop/registry.js";
import type { InteropAgentId, InteropInventory } from "../../src/domains/interop/types.js";
import {
	clearPluginSnapshots,
	listInstalledPlugins,
	PLUGIN_SCHEMA,
	readPluginInstallRecord,
} from "../../src/domains/plugins/index.js";
import { loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let cwd: string;
let home: string;
function file(relative: string, text: string): string {
	const target = path.join(home, relative);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, text);
	return target;
}
function inventory(host: InteropAgentId): InteropInventory {
	const kind = interopAgentKind(host);
	ok(kind);
	return discoverInteropInventory(kind, home, cwd);
}
const realWtfpBundle = process.env.WTFP_CLAUDE_BUNDLE ?? "/home/akougkas/projects/wtf-p/vendors/claude";
const skill = "---\nname: example\ndescription: A fixture skill\n---\nRead the task carefully.\n";

describe("interop discovery and adoption", () => {
	beforeEach(async () => {
		env = await isolateClioEnv("clio-interop-adopt-");
		home = path.join(env.dir, "foreign");
		cwd = path.join(env.dir, "project");
		mkdirSync(home);
		mkdirSync(cwd);
		clearPluginSnapshots();
	});
	afterEach(() => {
		clearPluginSnapshots();
		env.restore();
	});
	for (const [host, root, project] of [
		["claude-code", ".claude", ".claude"],
		["codex", ".codex", ".codex"],
		["antigravity", ".gemini/config", ".agents"],
		["copilot", ".copilot", ".github"],
		["opencode", ".config/opencode", ".opencode"],
	] as const) {
		it(`discovers ${host} resources at both scopes without executing a host`, () => {
			file(`${root}/skills/example/SKILL.md`, skill);
			file(`${root}/agents/check.md`, "---\nname: check\n---\nReview the evidence.");
			mkdirSync(path.join(cwd, project, "skills", "project"), { recursive: true });
			writeFileSync(path.join(cwd, project, "skills", "project", "SKILL.md"), skill);
			const found = inventory(host);
			strictEqual(found.status, "known");
			strictEqual(found.items.filter((item) => item.kind === "skill").length, 2);
			ok(found.items.some((item) => item.kind === "agent" && item.scope === "user"));
			ok(found.items.some((item) => item.kind === "skill" && item.scope === "project"));
		});
	}

	it("reads Codex cache marketplace and activation evidence", () => {
		file(
			".codex/plugins/cache/market/example/1.2.3/plugin.json",
			JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "example", version: "1.2.3" }),
		);
		file(
			".codex/config.toml",
			'[plugins."example@market"]\nenabled = false\n[mcp_servers.one]\ncommand = "do-not-run"\n[mcp_servers.two]\nurl = "https://example.invalid"\n',
		);
		const found = inventory("codex");
		const plugin = found.items.find((item) => item.kind === "plugin");
		ok(plugin);
		strictEqual(plugin.marketplace, "market");
		strictEqual(plugin.installation, "installed");
		strictEqual(plugin.enabled, false);
		strictEqual(found.items.filter((item) => item.kind === "mcp").length, 2);
	});
	it("resolves Copilot local directory marketplace registrations", () => {
		const root = path.join(home, "market");
		file(
			"market/.claude-plugin/marketplace.json",
			JSON.stringify({ name: "market", plugins: [{ name: "example", source: "./example" }] }),
		);
		file("market/example/plugin.json", JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "example", version: "1.0.0" }));
		file("market/example/skills/example/SKILL.md", skill);
		file(
			".copilot/settings.json",
			JSON.stringify({
				extraKnownMarketplaces: { market: { source: { source: "directory", path: root } } },
				enabledPlugins: { "example@market": true },
			}),
		);
		const found = inventory("copilot");
		const plugin = found.items.find((item) => item.kind === "plugin");
		ok(plugin);
		strictEqual(plugin.path, path.join(root, "example"));
		strictEqual(plugin.installation, "installed");
		strictEqual(plugin.marketplace, "market");
		strictEqual(found.items.filter((item) => item.kind === "skill").length, 1);
	});
	it("converts Markdown and TOML agents into validated read-only Clio recipes", () => {
		file(
			".claude/agents/review.md",
			"---\nname: review\ndescription: Read evidence\ntools: Bash,Write\nhooks: dangerous\n---\nReview the evidence.\n",
		);
		file(
			".codex/agents/check.toml",
			'name = "check"\ndescription = "Inspect evidence"\ndeveloper_instructions = "Check the evidence."\nsandbox_mode = "danger-full-access"\n',
		);
		for (const host of ["claude-code", "codex"] as const) {
			const plan = planInteropAdoption({ host, inventory: inventory(host), cwd, kind: "agent" });
			strictEqual(plan.entries[0]?.action, "install", plan.entries[0]?.reason);
			const result = applyInteropAdoption(plan, true);
			deepStrictEqual(result.diagnostics, []);
			strictEqual(result.installed.length, 1);
			const files = Object.values(plan.entries[0]?.files ?? {}).join("\n");
			ok(files.includes("read-only"));
			ok(!files.includes("danger-full-access"));
			ok(!files.includes("hooks: dangerous"));
		}
	});
	it("registers /interop as the existing connection overlay route", () => {
		deepStrictEqual(parseSlashCommand("/interop"), { kind: "agents", connect: true });
	});
	it("keeps CLI dry-run and missing approval read-only, then installs with --yes", () => {
		file(".claude/skills/example/SKILL.md", skill);
		const childEnv = {
			...process.env,
			HOME: home,
			CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
			CODEX_HOME: path.join(home, ".codex"),
			ANTIGRAVITY_HOME: path.join(home, ".gemini/config"),
			OPENCODE_CONFIG_DIR: path.join(home, ".config/opencode"),
			COPILOT_HOME: path.join(home, ".copilot"),
		};
		const cli = (...args: string[]) =>
			spawnSync(
				process.execPath,
				["--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"), "interop", ...args],
				{ cwd, env: childEnv, encoding: "utf8", timeout: 30000 },
			);
		// Resolve the tsx loader from the repository even when the child cwd is a fixture.
		const inspected = cli("inspect", "--json");
		strictEqual(inspected.status, 0, inspected.stderr);
		const snapshot = JSON.parse(inspected.stdout) as {
			agents: Array<{ id: string; inventory: { counts: Record<string, number> } | null }>;
		};
		strictEqual(snapshot.agents.find((agent) => agent.id === "claude-code")?.inventory?.counts.skill, 1);
		ok(!inspected.stdout.includes(home));
		const dry = cli("adopt", "claude-code", "--dry-run");
		strictEqual(dry.status, 0, dry.stderr);
		ok(dry.stdout.includes("INSTALL skill"));
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 0);
		const no = cli("adopt", "claude-code");
		strictEqual(no.status, 1, no.stderr);
		ok(no.stderr.includes("Approval required"));
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 0);
		const yes = cli("adopt", "claude-code", "--yes");
		strictEqual(yes.status, 0, yes.stderr);
		ok(yes.stdout.includes("Installed"));
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 1);
	});
	it("records Claude marketplace identity and ignores other project installations", () => {
		const root = file("bundle/.claude-plugin/plugin.json", JSON.stringify({ name: "example", version: "1.2.3" }));
		file("bundle/skills/example/SKILL.md", skill);
		file(
			".claude/plugins/installed_plugins.json",
			JSON.stringify({
				version: 2,
				plugins: {
					"example@test-market": [
						{ scope: "user", installPath: path.dirname(path.dirname(root)), version: "1.2.3" },
						{ scope: "project", projectPath: "/another-project", installPath: "/not-read" },
					],
				},
			}),
		);
		const found = inventory("claude-code");
		const plugins = found.items.filter((item) => item.kind === "plugin");
		strictEqual(plugins.length, 1);
		strictEqual(plugins[0]?.marketplace, "test-market");
		strictEqual(plugins[0]?.version, "1.2.3");
		const plan = planInteropAdoption({ host: "claude-code", inventory: found, cwd, kind: "plugin" });
		ok(plan.entries[0]?.reason.includes("root plugin.json"));
	});
	it("reports malformed configuration and symlink roots as unknown", () => {
		file(".claude/settings.json", "invalid json");
		symlinkSync(home, path.join(home, ".claude", "skills"));
		strictEqual(inventory("claude-code").status, "unknown");
	});

	it("finds Claude and OpenCode project-root MCP declarations without exposing values", () => {
		file(".claude.json", JSON.stringify({ mcpServers: { userServer: { command: "never-run" } } }));
		writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { projectServer: { token: "hidden" } } }));
		writeFileSync(
			path.join(cwd, "opencode.json"),
			JSON.stringify({ mcp: { projectServer: { command: ["never-run"] } }, plugin: ["sample-plugin"] }),
		);
		const claude = inventory("claude-code");
		strictEqual(claude.items.filter((item) => item.kind === "mcp").length, 2);
		const opencode = inventory("opencode");
		strictEqual(opencode.items.filter((item) => item.kind === "mcp").length, 1);
		ok(opencode.items.some((item) => item.kind === "executable" && item.name === "sample-plugin"));
		ok(!JSON.stringify(claude).includes("hidden"));
	});
	it("lists hooks and MCP names without credentials and refuses adoption", () => {
		file(".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ command: "do-not-run" }] } }));
		file(".claude/.mcp.json", JSON.stringify({ mcpServers: { private: { env: { SECRET: "never-show-this" } } } }));
		const found = inventory("claude-code");
		ok(!JSON.stringify(found).includes("never-show-this"));
		const plan = planInteropAdoption({ host: "claude-code", inventory: found, cwd });
		strictEqual(plan.entries.length, 2);
		ok(plan.entries.every((entry) => entry.action === "skip"));
	});
	it("requires approval, keeps origins and pins, skips duplicates and does not change the source", () => {
		const source = file(".claude/skills/example/SKILL.md", skill);
		const plan = planInteropAdoption({ host: "claude-code", inventory: inventory("claude-code"), cwd });
		strictEqual(plan.entries[0]?.action, "install");
		deepStrictEqual(applyInteropAdoption(plan, false).installed, []);
		strictEqual(listInstalledPlugins(cwd, { all: true }).length, 0);
		const result = applyInteropAdoption(plan, true);
		deepStrictEqual(result.diagnostics, []);
		strictEqual(result.installed.length, 1);
		strictEqual(readFileSync(source, "utf8"), skill);
		const installed = listInstalledPlugins(cwd, { all: true })[0];
		ok(installed);
		strictEqual(installed.trust, "foreign");
		ok(installed.provenance?.contentDigest);
		const record = readPluginInstallRecord(installed.id, { scope: "user", cwd });
		deepStrictEqual(record?.origin, { kind: "interop", host: "claude-code", source });
		const again = planInteropAdoption({ host: "claude-code", inventory: inventory("claude-code"), cwd });
		ok(again.entries[0]?.reason.includes("Already installed"));
		const loaded = loadSkills({ cwd, home: path.join(home, "empty") }).items.find(
			(item) => item.source === `plugin:${installed.id}` || item.filePath.startsWith(installed.rootPath),
		);
		ok(loaded);
		strictEqual(loaded.trusted, false);
	});

	it("skips a skill already installed in Clio's native skill root", () => {
		file(".claude/skills/example/SKILL.md", skill);
		const native = path.join(cwd, ".clio-coder/skills/example/SKILL.md");
		mkdirSync(path.dirname(native), { recursive: true });
		writeFileSync(native, skill);
		const plan = planInteropAdoption({ host: "claude-code", inventory: inventory("claude-code"), cwd });
		strictEqual(plan.entries[0]?.action, "skip");
		ok(plan.entries[0]?.reason.includes("same skill content digest"));
	});
	it("rejects changed sources and executable or symlinked companion files", () => {
		const source = file(".claude/skills/example/SKILL.md", skill);
		const plan = planInteropAdoption({ host: "claude-code", inventory: inventory("claude-code"), cwd });
		writeFileSync(source, `${skill}Changed`);
		ok(applyInteropAdoption(plan, true).diagnostics[0]?.includes("changed"));
		file(".claude/skills/example/run.sh", "echo no");
		const executable = planInteropAdoption({ host: "claude-code", inventory: inventory("claude-code"), cwd });
		strictEqual(executable.entries[0]?.action, "skip");
		chmodSync(source, 0o755);
		strictEqual(
			planInteropAdoption({ host: "claude-code", inventory: inventory("claude-code"), cwd }).entries[0]?.action,
			"skip",
		);
	});
	it("adopts a project prompt to user scope without granting trust", () => {
		const source = path.join(cwd, ".claude/commands/example.md");
		mkdirSync(path.dirname(source), { recursive: true });
		writeFileSync(source, "Explain the evidence.");
		const plan = planInteropAdoption({
			host: "claude-code",
			inventory: inventory("claude-code"),
			cwd,
			kind: "prompt",
			scope: "user",
		});
		const result = applyInteropAdoption(plan, true);
		deepStrictEqual(result.diagnostics, []);
		const pkg = listInstalledPlugins(cwd, { all: true })[0];
		ok(pkg);
		const prompts = loadPromptTemplates({ cwd: home, home: path.join(home, "empty") });
		const adopted = prompts.items.find((item) => item.filePath.startsWith(pkg.rootPath));
		ok(adopted);
		strictEqual(adopted.trusted, false);
	});

	it("projects a portable plugin and skips its already-provided child resources", () => {
		const source = path.join(home, "portable");
		file("portable/plugin.json", JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "portable", version: "1.0.0" }));
		const skillPath = file("portable/skills/example/SKILL.md", skill);
		file("portable/hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: [{ command: "do-not-run" }] } }));
		const script = file("portable/scripts/run.sh", "#!/bin/sh\nexit 99\n");
		chmodSync(script, 0o755);
		file("portable/.mcp.json", JSON.stringify({ mcpServers: { secret: { token: "do-not-copy" } } }));
		const found: InteropInventory = {
			status: "known",
			listing: "unknown",
			diagnostics: [],
			items: [
				{ kind: "plugin", name: "portable", scope: "user", path: source },
				{ kind: "skill", name: "example", scope: "user", path: skillPath, plugin: source },
			],
		};
		const plan = planInteropAdoption({ host: "claude-code", inventory: found, cwd });
		strictEqual(plan.entries[0]?.action, "install");
		strictEqual(plan.entries[1]?.action, "skip");
		ok(plan.entries[0]?.omitted?.includes("hooks"));
		ok(plan.entries[0]?.omitted?.includes(".mcp.json"));
		const installed = applyInteropAdoption(plan, true);
		deepStrictEqual(installed.diagnostics, []);
		deepStrictEqual(installed.installed, ["portable"]);
		const again = planInteropAdoption({ host: "claude-code", inventory: found, cwd });
		ok(again.entries.every((entry) => entry.action === "skip"));
	});
	it("adopts the real WTF-P Claude portable bundle as a data-only wtfp plugin", {
		skip: existsSync(path.join(realWtfpBundle, "plugin.json"))
			? false
			: "Set WTFP_CLAUDE_BUNDLE to a generated Claude bundle to run this external integration contract.",
	}, () => {
		const source = realWtfpBundle;
		ok(existsSync(path.join(source, "plugin.json")), "the generated WTF-P bundle must be present for this contract");
		const before = readFileSync(path.join(source, "plugin.json"), "utf8");
		const found: InteropInventory = {
			status: "known",
			listing: "unknown",
			diagnostics: [],
			items: [{ kind: "plugin", name: "wtfp", scope: "user", path: source, marketplace: "wtfp" }],
		};
		const plan = planInteropAdoption({ host: "claude-code", inventory: found, cwd, kind: "plugin" });
		strictEqual(plan.entries[0]?.action, "install", plan.entries[0]?.reason);
		const result = applyInteropAdoption(plan, true);
		deepStrictEqual(result.diagnostics, []);
		deepStrictEqual(result.installed, ["wtfp"]);
		const pkg = listInstalledPlugins(cwd, { all: true })[0];
		ok(pkg);
		strictEqual(pkg.valid, true);
		strictEqual(pkg.trust, "foreign");
		ok(!existsSync(path.join(pkg.rootPath, "hooks")));
		ok(!existsSync(path.join(pkg.rootPath, "tools")));
		strictEqual(JSON.parse(readFileSync(path.join(pkg.rootPath, "plugin.json"), "utf8")).$schema, PLUGIN_SCHEMA);
		strictEqual(readFileSync(path.join(source, "plugin.json"), "utf8"), before);
	});
});
