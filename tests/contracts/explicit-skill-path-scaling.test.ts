import { ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { countFsCalls, installFsCounters } from "../harness/fs-counter.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// An explicit skill path is matched against every package root to find its
// owning plugin. The skill loader canonicalizes those roots once per load, so
// each further explicit path costs its own realpath and no more. The loader
// canonicalizes with realpathSync.native. Counters are installed before any
// product module loads so their fs imports see the wrappers.
const home = mkdtempSync(join(tmpdir(), "clio-coder-explicit-skill-"));
Object.assign(process.env, scratchClioEnvVars(home), { HOME: home });
await installFsCounters();
const plugins = await import("../../src/domains/plugins/index.js");
const { loadSkills } = await import("../../src/domains/resources/skills/loader.js");

const PACKAGES = 12;
const EXPLICIT = 8;
const scratch: string[] = [home];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, relative: string, text: string): void {
	const file = join(root, relative);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function skillDir(prefix: string, name: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	write(dir, "SKILL.md", `---\nname: ${name}\ndescription: Explicit path fixture.\n---\nRead.\n`);
	return dir;
}

describe("explicit skill path scaling", () => {
	it("canonicalizes package roots once per load, not once per explicit path", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-explicit-skill-project-")));
		scratch.push(cwd);
		for (let index = 0; index < PACKAGES; index++) {
			const source = mkdtempSync(join(tmpdir(), "clio-coder-explicit-skill-source-"));
			scratch.push(source);
			write(source, `skills/kit-${index}/SKILL.md`, `---\nname: kit-${index}\ndescription: Kit.\n---\nRead.\n`);
			write(
				source,
				"plugin.json",
				JSON.stringify({
					$schema: plugins.PLUGIN_SCHEMA,
					name: `kit-${index}`,
					version: "1.0.0",
					description: "Explicit path fixture",
					extensions: { "ai.iowarp.clio": { manifestVersion: 1, resources: { skills: "skills" } } },
				}),
			);
			ok(plugins.installPlugin(source, { cwd, scope: "project" }).plugin);
		}
		const explicit = Array.from({ length: EXPLICIT }, (_, index) =>
			skillDir("clio-coder-explicit-skill-path-", `explicit-${index}`),
		);
		const previous = process.cwd();
		process.chdir(cwd);
		try {
			plugins.reloadPluginResources(cwd);
			const count = async (paths: number): Promise<number> => {
				// The first load fills settings and snapshot caches; count the second.
				loadSkills({ cwd, explicitSkillPaths: explicit.slice(0, paths) });
				const { value, byName } = await countFsCalls(async () =>
					loadSkills({ cwd, explicitSkillPaths: explicit.slice(0, paths) }),
				);
				ok(
					value.items.some((skill) => skill.name === "explicit-0"),
					"the explicit skill loads",
				);
				return byName["fs.realpathSync.native"] ?? 0;
			};
			const perPath = ((await count(EXPLICIT)) - (await count(1))) / (EXPLICIT - 1);
			// Canonicalizing every package root per path cost 16 here.
			ok(perPath <= 3, `each explicit path cost ${perPath.toFixed(1)} realpaths with ${PACKAGES} packages`);
		} finally {
			process.chdir(previous);
		}
	});
});
