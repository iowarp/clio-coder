import { ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { countFsCalls, installFsCounters } from "../harness/fs-counter.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// Boot runs agent recipe discovery and a skill catalog load before the
// interactive editor accepts input. Both must read each installed plugin tree a
// bounded number of times: when a skill-binding recipe re-listed every plugin
// per recipe, a checkout with 52 installed plugins spent ten seconds here with
// the event loop blocked. Counters are installed before any product module
// loads so their fs imports see the wrappers.
const home = mkdtempSync(join(tmpdir(), "clio-coder-plugin-discovery-fs-"));
Object.assign(process.env, scratchClioEnvVars(home));
await installFsCounters();
const { PLUGIN_SCHEMA, clearPluginSnapshots, installPlugin } = await import("../../src/domains/plugins/index.js");
const { discoverAgentRecipes } = await import("../../src/domains/agents/registry.js");
const { loadSkills } = await import("../../src/domains/resources/skills/loader.js");

const REFERENCES_PER_PLUGIN = 8;
// plugin.json, one SKILL.md, and the reference files.
const FILES_PER_PLUGIN = REFERENCES_PER_PLUGIN + 2;
const PLUGINS = 6;
/**
 * Counted fs calls per installed plugin file, above a project holding only the
 * agent plugin. One integrity walk costs about 12 calls per file (lstat, open,
 * the stable-read fstats, read, close, realpath) and boot discovery runs two
 * passes, one per domain, for 25.0. The skill loader's symlink containment
 * checks add realpathSync.native calls, which the counter has counted since it
 * learned to wrap them, for 26.4. Re-listing plugins per skill-binding recipe
 * measured 118.4 before the native calls were counted. Lower the ceiling when
 * the count drops.
 */
const PER_FILE_CEILING = 27;

const scratch: string[] = [home];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, relative: string, text: string): void {
	const file = join(root, relative);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function manifest(name: string, resources?: Record<string, string>): string {
	return JSON.stringify({
		$schema: PLUGIN_SCHEMA,
		name,
		version: "1.0.0",
		description: "Discovery scaling fixture",
		...(resources ? { extensions: { "ai.iowarp.clio": { manifestVersion: 1, resources } } } : {}),
	});
}

/** Skills-only packages are what most installations hold. */
function skillPlugin(name: string): string {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-plugin-discovery-source-"));
	scratch.push(root);
	write(root, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Scaling fixture skill.\n---\nRead.\n`);
	for (let index = 0; index < REFERENCES_PER_PLUGIN; index++)
		write(root, `skills/${name}/references/note-${index}.md`, `Reference ${index} for ${name}.\n`);
	write(root, "plugin.json", manifest(name));
	return root;
}

/** One package recipe binds its own skill, so the plugin recipe path is exercised. */
function agentPlugin(name: string): string {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-plugin-discovery-source-"));
	scratch.push(root);
	write(root, "skills/bound/SKILL.md", "---\nname: bound-skill\ndescription: Bound fixture skill.\n---\nRead.\n");
	const recipe = readFileSync(resolve("src/domains/agents/builtins/researcher.md"), "utf8")
		.replace("audience: shadow", "audience: custom")
		.replace("required: [read]", "required: [read, context]")
		.replace("optional: [web_fetch, context, ledger]", "optional: [web_fetch, ledger]")
		.replace("skills: []", "skills: [bound-skill]");
	write(root, "agents/bound-researcher.md", recipe);
	write(root, "plugin.json", manifest(name, { skills: "skills", agents: "agents" }));
	return root;
}

function project(skillPlugins: number): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-plugin-discovery-project-")));
	scratch.push(cwd);
	const installs = [agentPlugin("bound-agents")];
	for (let index = 0; index < skillPlugins; index++) installs.push(skillPlugin(`scale-kit-${index}`));
	for (const source of installs) ok(installPlugin(source, { cwd, scope: "project" }).plugin, source);
	return cwd;
}

/** What the agents and resources domains run at boot, in that order. */
function bootDiscovery(cwd: string): void {
	const diagnostics: Parameters<typeof discoverAgentRecipes>[1] = [];
	const recipes = discoverAgentRecipes(cwd, diagnostics);
	ok(
		recipes.some((recipe) => recipe.source === "plugin" && recipe.boundSkillPaths?.length === 1),
		`fixture recipe did not bind its skill: ${JSON.stringify(diagnostics)} ${JSON.stringify(recipes.map((r) => [r.id, r.source]))}`,
	);
	loadSkills({ cwd });
}

async function counted(cwd: string): Promise<number> {
	const previous = process.cwd();
	process.chdir(cwd);
	try {
		clearPluginSnapshots();
		// Let install I/O drain so it cannot land inside the counted window.
		await new Promise((settle) => setImmediate(settle));
		await new Promise((settle) => setImmediate(settle));
		return (await countFsCalls(async () => bootDiscovery(cwd))).total;
	} finally {
		process.chdir(previous);
	}
}

describe("boot plugin discovery fs calls", () => {
	it("reads each installed plugin file a bounded number of times, linearly in plugin count", async () => {
		const baseline = project(0);
		const single = project(PLUGINS);
		const double = project(PLUGINS * 2);
		// One uncounted discovery loads lazily imported modules and fills
		// settings caches, so each counted window measures discovery alone.
		await counted(baseline);
		const base = await counted(baseline);
		const first = await counted(single);
		const second = await counted(double);
		const perFile = (first - base) / (PLUGINS * FILES_PER_PLUGIN);
		ok(
			perFile <= PER_FILE_CEILING,
			`boot discovery made ${perFile.toFixed(1)} fs calls per plugin file (> ${PER_FILE_CEILING}); counts ${base}/${first}/${second}`,
		);
		// Differences cancel loader and cache noise; a repeated walk that grows
		// with the plugin set shows up as a second increment larger than the first.
		ok(
			second - first <= (first - base) * 1.1,
			`boot discovery grew superlinearly: +${first - base} then +${second - first} for ${PLUGINS} more plugins`,
		);
	});
});
