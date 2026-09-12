import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { readPluginCatalog } from "../../src/domains/plugins/catalog.js";
import { disablePlugin, installPlugin, removePlugin } from "../../src/domains/plugins/index.js";
import {
	classifyLibraryOrigin,
	inspectLibraryCopy,
	type LibraryResource,
	parseLibraryResourceKey,
	readLibraryInventory,
} from "../../src/domains/resources/library-inventory.js";
import { isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";

const materioSource = fileURLToPath(new URL("../../library/plugins/materio/", import.meta.url));
const cliEntry = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

function write(root: string, name: string, text: string): void {
	const file = join(root, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function skill(root: string, dir: string, name: string, description = `Fixture ${name}`): void {
	write(root, `${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`);
}

/** A small plugin with one skill, one prompt, one fleet; agents are optional. */
function fixture(root: string, name: string, options: { duplicateSkill?: boolean; brokenPrompt?: boolean } = {}): void {
	skill(root, "skills/alpha", `${name}-alpha`);
	if (options.duplicateSkill) skill(root, "skills/beta", `${name}-alpha`, "Second file claiming the same name");
	write(
		root,
		`prompts/${name}/help.md`,
		`---\ndescription: ${name} help\n---\n${options.brokenPrompt ? "Read ${component:resource:missing}" : "Help text."}\n`,
	);
	write(
		root,
		`fleets/${name}-review.md`,
		`---\nversion: 1\nname: ${name}-review\ndescription: ${name} review\nsteps:\n  - id: review\n    agent: coder\n    scope: readonly\n    dependencies: []\nmaxWorkers: 1\nonFailure: stop\n---\nReview.\n`,
	);
	write(
		root,
		"plugin.json",
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name,
			version: "1.0.0",
			description: `${name} fixture`,
			extensions: {
				"ai.iowarp.clio": {
					manifestVersion: 1,
					resources: { skills: "skills", prompts: "prompts", fleets: "fleets" },
					components: [],
				},
			},
		}),
	);
}

function byOwner(resources: ReadonlyArray<LibraryResource>, ref: string): LibraryResource[] {
	return resources.filter((item) => item.owner?.ref === ref);
}

function counts(resources: ReadonlyArray<LibraryResource>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of resources) out[item.kind] = (out[item.kind] ?? 0) + 1;
	return out;
}

function cli(env: { dir: string }, cwd: string, args: string[]): { code: number; json: unknown; stderr: string } {
	const result = spawnSync(process.execPath, [cliEntry, "library", ...args], {
		cwd,
		env: { ...process.env, ...scratchClioEnvVars(env.dir), HOME: env.dir },
		encoding: "utf8",
		timeout: 120000,
	});
	let json: unknown;
	try {
		json = JSON.parse(result.stdout);
	} catch {
		json = undefined;
	}
	return { code: result.status ?? 1, json, stderr: result.stderr };
}

describe("library inventory", () => {
	it("reports Materio's actual 6 skills, 6 agents, 17 prompts and 1 fleet with owner, runtime names and bundled origin", async () => {
		const env = await isolateClioEnv("clio-coder-inventory-materio-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const installed = installPlugin(materioSource, {
				cwd,
				scope: "user",
				origin: { kind: "catalog", source: materioSource },
			});
			ok(installed.plugin?.loadable, JSON.stringify(installed.diagnostics));

			const inventory = readLibraryInventory({ cwd, home: env.dir });
			const owned = byOwner(inventory.resources, "plugin:materio");
			deepStrictEqual(counts(owned), { skill: 6, agent: 6, prompt: 17, fleet: 1 });
			for (const item of owned) {
				strictEqual(item.owner?.scope, "user");
				strictEqual(item.availability, "available", `${item.key}: ${item.reason ?? ""}`);
				strictEqual(item.origin.kind, "bundled");
				strictEqual(item.format, "portable");
				strictEqual(item.source.class, "package");
				strictEqual(item.source.id, "plugin:user:materio");
				ok(item.key.startsWith(`${item.kind}:${item.name}@plugin:user:materio#`), item.key);
				ok(!("content" in item) && !("body" in item));
			}
			const skills = owned.filter((item) => item.kind === "skill").map((item) => item.name);
			ok(
				skills.every((name) => name.startsWith("materio-")),
				skills.join(","),
			);
			deepStrictEqual(
				owned
					.filter((item) => item.kind === "agent")
					.map((item) => item.name)
					.sort(),
				[
					"materio-lab-definer",
					"materio-literature-reviewer",
					"materio-research-explorer",
					"materio-task-executor",
					"materio-task-verifier",
					"materio-workflow-planner",
				],
			);
			ok(owned.filter((item) => item.kind === "prompt").every((item) => item.name.startsWith("materio:")));
			strictEqual(
				owned.find((item) => item.kind === "prompt" && item.name === "materio:help")?.invocation,
				"/materio:help",
			);
			strictEqual(owned.find((item) => item.kind === "fleet")?.name, "materio-execute-task");
			strictEqual(owned.find((item) => item.kind === "agent")?.invocation, 'dispatch(agent="materio-lab-definer")');

			const copy = inventory.copies.find((item) => item.ref === "plugin:materio");
			ok(copy);
			strictEqual(copy.state, "loadable");
			strictEqual(copy.origin.kind, "bundled");
			strictEqual(copy.trust, "trusted");

			// The bundled catalog row carries generated hints with the same actual names.
			const record = inventory.packages.find((item) => item.ref === "plugin:materio");
			ok(record);
			strictEqual(record.origin.kind, "bundled");
			deepStrictEqual(record.copies, [{ scope: "user", state: "loadable" }]);
			deepStrictEqual(counts(record.provides as LibraryResource[]), { skill: 6, agent: 6, prompt: 17, fleet: 1 });
			deepStrictEqual(
				(record.provides ?? []).filter((hint) => hint.kind === "agent").map((hint) => hint.name),
				owned
					.filter((item) => item.kind === "agent")
					.map((item) => item.name)
					.sort(),
			);

			// Explicit inspection keeps the declared component id separate from the runtime name.
			const inspection = inspectLibraryCopy("plugin:materio", { cwd });
			const agent = inspection.resources.find((item) => item.kind === "agent" && item.name === "materio-lab-definer");
			strictEqual(agent?.componentId, "lab-definer");
			strictEqual(inspection.resources.filter((item) => item.kind === "prompt").length, 17);
			ok(inspection.ancillary.some((item) => item.kind === "script"));
		} finally {
			env.restore();
		}
	});

	it("finds a bundle by a provided recipe kind or name and returns the owning package, without fetching", async () => {
		const env = await isolateClioEnv("clio-coder-inventory-search-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			// A remote row in the private index must be listed by metadata alone.
			write(
				env.dir,
				"config/library.yaml",
				stringify({
					entries: [
						{
							kind: "plugin",
							name: "remote-bundle",
							description: "Remote catalog row without hints",
							sourceUrl: "https://github.com/example/bundles/tree/v1/remote-bundle",
							version: "1.0.0",
							sha256: "a".repeat(64),
						},
					],
				}),
			);
			const started = Date.now();
			const agents = readLibraryInventory({ cwd, home: env.dir, kinds: ["agent"], include: { resources: false } });
			ok(Date.now() - started < 5000);
			ok(agents.packages.some((item) => item.ref === "plugin:materio"));
			ok(agents.packages.every((item) => item.kind === "agent" || item.provides?.some((hint) => hint.kind === "agent")));
			ok(!agents.packages.some((item) => item.ref === "plugin:remote-bundle"));

			const byName = readLibraryInventory({
				cwd,
				home: env.dir,
				query: "materio-task-verifier",
				include: { resources: false },
			});
			deepStrictEqual(
				byName.packages.map((item) => item.ref),
				["plugin:materio"],
			);
			deepStrictEqual(byName.packages[0]?.copies, []);

			const remote = readLibraryInventory({
				cwd,
				home: env.dir,
				ref: "plugin:remote-bundle",
				include: { resources: false },
			});
			strictEqual(remote.packages.length, 1);
			deepStrictEqual(remote.packages[0]?.origin, {
				kind: "remote",
				url: "https://github.com/example/bundles/tree/v1/remote-bundle",
				catalog: join(env.dir, "config", "library.yaml"),
			});
			strictEqual(remote.packages[0]?.provides, undefined);
		} finally {
			env.restore();
		}
	});

	it("lists core and loose recipes as unmanaged sources with honest origin, trust and audience filtering", async () => {
		const env = await isolateClioEnv("clio-coder-inventory-loose-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			skill(cwd, ".clio-coder/skills/project-skill", "project-skill");
			skill(env.dir, "config/skills/user-skill", "user-skill");
			skill(cwd, ".claude/skills/foreign-skill", "foreign-skill");
			write(cwd, ".clio-coder/prompts/local-help.md", "---\ndescription: Local help\n---\nHelp.\n");

			const operator = readLibraryInventory({ cwd, home: env.dir, trustProjectCompatRoots: false });
			const coder = operator.resources.find((item) => item.kind === "agent" && item.name === "coder");
			ok(coder);
			deepStrictEqual(coder.origin, { kind: "core" });
			strictEqual(coder.source.class, "core");
			strictEqual(coder.owner, undefined);
			strictEqual(coder.audience, "base");
			ok(!operator.resources.some((item) => item.name === "researcher"), "shadow agent hidden by default");
			ok(!operator.resources.some((item) => item.name === "context-bootstrap"), "internal agent hidden by default");
			ok(!operator.copies.some((item) => item.name === "coder"), "core recipes are not packages");

			const project = operator.resources.find((item) => item.name === "project-skill");
			ok(project);
			strictEqual(project.source.class, "project");
			strictEqual(project.source.id, "project");
			strictEqual(project.owner, undefined);
			deepStrictEqual(project.origin, { kind: "local", path: join(cwd, ".clio-coder/skills/project-skill/SKILL.md") });
			strictEqual(project.key, "skill:project-skill@project#.clio-coder/skills/project-skill/SKILL.md");
			strictEqual(project.invocation, "/skill project-skill");

			const user = operator.resources.find((item) => item.name === "user-skill");
			strictEqual(user?.source.class, "user");
			strictEqual(user?.source.id, "config");

			const foreign = operator.resources.find((item) => item.name === "foreign-skill");
			ok(foreign);
			strictEqual(foreign.source.class, "compat");
			strictEqual(foreign.availability, "untrusted");
			strictEqual(foreign.invocation, undefined);
			strictEqual(foreign.format, "claude-code");
			strictEqual(foreign.origin.kind, "local");
			strictEqual(foreign.origin.kind === "local" ? foreign.origin.host : undefined, "claude");

			strictEqual(operator.resources.find((item) => item.name === "local-help")?.invocation, "/local-help");

			const all = readLibraryInventory({ cwd, home: env.dir, all: true, kinds: ["agent"] });
			ok(all.resources.some((item) => item.name === "researcher" && item.audience === "shadow"));
			ok(all.resources.some((item) => item.name === "context-bootstrap" && item.audience === "internal"));

			const model = readLibraryInventory({
				cwd,
				home: env.dir,
				audience: "model",
				all: true,
				trustProjectCompatRoots: false,
			});
			strictEqual(model.audience, "model");
			ok(!model.resources.some((item) => item.name === "researcher"), "model never sees shadow agents");
			ok(!model.resources.some((item) => item.name === "foreign-skill"), "model never sees untrusted recipes");
			ok(model.resources.some((item) => item.name === "project-skill"));

			const trusted = readLibraryInventory({ cwd, home: env.dir, trustProjectCompatRoots: true, ref: "foreign-skill" });
			strictEqual(trusted.resources[0]?.availability, "available");

			const onlyCore = readLibraryInventory({ cwd, home: env.dir, sources: ["core"] });
			ok(onlyCore.resources.length > 0);
			ok(onlyCore.resources.every((item) => item.source.class === "core"));
		} finally {
			env.restore();
		}
	});

	it("keeps two scoped copies with actual precedence: a disabled valid project copy still shadows the user copy", async () => {
		const env = await isolateClioEnv("clio-coder-inventory-scopes-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const source = join(env.dir, "source");
			fixture(source, "twin");
			ok(installPlugin(source, { cwd, scope: "user" }).plugin?.loadable);
			ok(installPlugin(source, { cwd, scope: "project" }).plugin?.loadable);

			let inventory = readLibraryInventory({ cwd, home: env.dir, ref: "plugin:twin" });
			deepStrictEqual(
				inventory.copies.map((item) => [item.scope, item.state, item.overriddenBy]),
				[
					["project", "loadable", undefined],
					["user", "shadowed", "project"],
				],
			);
			deepStrictEqual(inventory.packages[0]?.copies, [
				{ scope: "project", state: "loadable" },
				{ scope: "user", state: "shadowed" },
			]);
			for (const copy of inventory.copies) deepStrictEqual(copy.origin, { kind: "local", path: source });
			const owned = byOwner(inventory.resources, "plugin:twin");
			deepStrictEqual(counts(owned), { skill: 1, prompt: 1, fleet: 1 });
			ok(owned.every((item) => item.owner?.scope === "project"));
			const userInspection = inspectLibraryCopy("plugin:twin", { cwd, scope: "user" });
			strictEqual(userInspection.copy.effective, false);
			strictEqual(userInspection.copy.state, "shadowed");
			strictEqual(userInspection.copy.loadable, false);

			deepStrictEqual(disablePlugin("twin", { cwd, scope: "project" }).diagnostics, []);
			inventory = readLibraryInventory({ cwd, home: env.dir, ref: "plugin:twin" });
			deepStrictEqual(
				inventory.copies.map((item) => [item.scope, item.state, item.enabled, item.effective]),
				[
					["project", "disabled", false, true],
					["user", "shadowed", true, false],
				],
			);
			strictEqual(byOwner(inventory.resources, "plugin:twin").length, 0, "no fallback while the project copy exists");

			// Explicit inspection still enumerates the disabled copy's members.
			const inspection = inspectLibraryCopy("plugin:twin", { cwd, scope: "project" });
			strictEqual(inspection.copy.state, "disabled");
			strictEqual(inspectLibraryCopy("plugin:twin", { cwd, scope: "user" }).copy.effective, false);
			deepStrictEqual(
				inspection.resources.map((item) => [item.kind, item.name, item.valid]),
				[
					["skill", "twin-alpha", true],
					["prompt", "twin:help", true],
					["fleet", "twin-review", true],
				],
			);

			ok(removePlugin("twin", { cwd, scope: "project" }).removed);
			inventory = readLibraryInventory({ cwd, home: env.dir, ref: "plugin:twin" });
			deepStrictEqual(
				inventory.copies.map((item) => [item.scope, item.state]),
				[["user", "loadable"]],
			);
			ok(byOwner(inventory.resources, "plugin:twin").every((item) => item.owner?.scope === "user"));
			strictEqual(inspectLibraryCopy("plugin:twin", { cwd, scope: "user" }).copy.loadable, true);
		} finally {
			env.restore();
		}
	});

	it("keeps damaged, invalid, unavailable, colliding and same-owner duplicate resources inspectable with distinct keys", async () => {
		const env = await isolateClioEnv("clio-coder-inventory-damage-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const damagedSource = join(env.dir, "damaged");
			fixture(damagedSource, "damaged");
			const damaged = installPlugin(damagedSource, { cwd, scope: "user" });
			ok(damaged.plugin?.loadable);
			writeFileSync(
				join(damaged.plugin.rootPath, "skills/alpha/SKILL.md"),
				"---\nname: damaged-alpha\ndescription: edited\n---\n",
			);

			const brokenSource = join(env.dir, "broken");
			fixture(brokenSource, "broken", { brokenPrompt: true, duplicateSkill: true });
			ok(installPlugin(brokenSource, { cwd, scope: "user" }).plugin?.loadable);

			const invalidSource = join(env.dir, "invalid");
			fixture(invalidSource, "invalid");
			const invalid = installPlugin(invalidSource, { cwd, scope: "project" });
			ok(invalid.plugin?.loadable);
			rmSync(join(invalid.plugin.rootPath, "plugin.json"));

			skill(cwd, ".clio-coder/skills/shared", "shared-skill", "project copy");
			skill(env.dir, "config/skills/shared", "shared-skill", "user copy");
			write(cwd, ".clio-coder/agents/bad-agent.md", "---\nname: Bad\n---\nno schema\n");

			const inventory = readLibraryInventory({ cwd, home: env.dir });
			const states = new Map(inventory.copies.map((item) => [`${item.ref}@${item.scope}`, item.state]));
			strictEqual(states.get("plugin:damaged@user"), "damaged");
			strictEqual(states.get("plugin:broken@user"), "loadable");
			strictEqual(states.get("plugin:invalid@project"), "invalid");
			strictEqual(byOwner(inventory.resources, "plugin:damaged").length, 0, "drifted copies are not admitted");
			ok(inventory.copies.find((item) => item.name === "damaged")?.diagnostics.some((m) => m.includes("drift")));

			const prompt = inventory.resources.find((item) => item.kind === "prompt" && item.name === "broken:help");
			strictEqual(prompt?.availability, "unavailable");
			ok(prompt?.reason?.includes("component"), prompt?.reason);
			strictEqual(prompt?.invocation, undefined);

			// Same runtime name, same owner, two physical files: both rows, distinct keys.
			const duplicates = inventory.resources.filter((item) => item.kind === "skill" && item.name === "broken-alpha");
			strictEqual(duplicates.length, 2);
			ok(duplicates.every((item) => item.owner?.ref === "plugin:broken"));
			deepStrictEqual(duplicates.map((item) => parseLibraryResourceKey(item.key)?.relativePath).sort(), [
				"skills/alpha/SKILL.md",
				"skills/beta/SKILL.md",
			]);
			deepStrictEqual(duplicates.map((item) => item.availability).sort(), ["available", "shadowed"]);
			const [, second] = duplicates;
			ok(second);
			const exact = readLibraryInventory({ cwd, home: env.dir, ref: second.key });
			deepStrictEqual(
				exact.resources.map((item) => item.key),
				[second.key],
			);
			deepStrictEqual(
				exact.packages.map((item) => item.ref),
				["plugin:broken"],
				"an exact owned key answers only with its owner",
			);

			const shared = inventory.resources.filter((item) => item.name === "shared-skill");
			deepStrictEqual(shared.map((item) => [item.source.class, item.availability]).sort(), [
				["project", "available"],
				["user", "shadowed"],
			]);

			const bad = inventory.resources.find((item) => item.kind === "agent" && item.name === "bad-agent");
			strictEqual(bad?.availability, "invalid");
			strictEqual(bad?.source.class, "project");
			ok(bad?.reason);

			const fleets = inventory.resources.filter((item) => item.kind === "fleet" && item.source.class === "core");
			ok(fleets.some((item) => item.availability === "unavailable" && item.reason));
			ok(inventory.resources.every((item) => item.diagnostics.length <= 8));
		} finally {
			env.restore();
		}
	});

	it("classifies origin from evidence only and keeps foreign imports visibly foreign", async () => {
		const env = await isolateClioEnv("clio-coder-inventory-origin-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			const source = join(env.dir, "vendor");
			fixture(source, "vendored");
			// Author metadata claims nothing; the install record does.
			const imported = installPlugin(source, {
				cwd,
				scope: "user",
				origin: {
					kind: "interop",
					host: "claude-code",
					source: "/home/someone/.claude/plugins/marketplaces/acme/vendored",
					format: "claude-code",
					marketplace: "acme",
				},
			});
			ok(imported.plugin, JSON.stringify(imported.diagnostics));
			strictEqual(imported.plugin.trust, "foreign");
			const inventory = readLibraryInventory({ cwd, home: env.dir, ref: "plugin:vendored" });
			const copy = inventory.copies[0];
			deepStrictEqual(copy?.origin, {
				kind: "imported",
				agent: "claude-code",
				path: "/home/someone/.claude/plugins/marketplaces/acme/vendored",
				marketplace: "acme",
			});
			strictEqual(copy?.format, "claude-code");
			strictEqual(copy?.trust, "foreign");
			strictEqual(copy?.state, "loadable");
			const members = byOwner(inventory.resources, "plugin:vendored");
			ok(members.length > 0);
			for (const item of members) {
				strictEqual(item.origin.kind, "imported");
				strictEqual(item.format, "claude-code");
			}
			// Loadable copy, but a foreign skill is not admitted to the model without the opt-in.
			strictEqual(members.find((item) => item.kind === "skill")?.availability, "untrusted");

			deepStrictEqual(
				classifyLibraryOrigin({
					kind: "install-record",
					rootPath: cwd,
					record: {
						installedAt: "",
						source: "https://github.com/example/pkg/tree/v1/pkg",
						contentDigest: "0".repeat(64),
						origin: {
							kind: "import",
							transport: "github",
							source: "https://github.com/example/pkg/tree/v1/pkg",
							format: "codex",
						},
					},
				}),
				{ origin: { kind: "remote", url: "https://github.com/example/pkg/tree/v1/pkg" }, format: "codex" },
			);
			deepStrictEqual(
				classifyLibraryOrigin({ kind: "install-record", rootPath: cwd, record: undefined }).origin.kind,
				"unknown",
			);
			strictEqual(
				classifyLibraryOrigin({ kind: "resource-root", sourceId: "plugin:project:uncorrelated", path: cwd }).origin.kind,
				"unknown",
				"a resource without its copy record must not invent local package provenance",
			);
			deepStrictEqual(
				classifyLibraryOrigin({
					kind: "catalog-row",
					entry: {
						kind: "plugin",
						name: "x",
						description: "",
						sourceUrl: join(env.dir, "somewhere"),
						origin: "catalog",
						index: join(env.dir, "config", "library.yaml"),
					},
				}).origin,
				{ kind: "local", path: join(env.dir, "somewhere"), catalog: join(env.dir, "config", "library.yaml") },
			);
		} finally {
			env.restore();
		}
	});

	it("accepts indexes without hints, drops malformed hints without dropping the row, and never writes index evidence back", async () => {
		const env = await isolateClioEnv("clio-coder-inventory-index-");
		try {
			const file = join(env.dir, "index.yaml");
			const base = {
				kind: "plugin",
				description: "row",
				sourceUrl: "https://github.com/example/repo/tree/v1/pkg",
				version: "1.0.0",
				sha256: "b".repeat(64),
			};
			writeFileSync(
				file,
				stringify({
					entries: [
						{ ...base, name: "plain" },
						{ ...base, name: "hinted", provides: [{ kind: "agent", name: "helper", description: "Helps" }] },
						{ ...base, name: "malformed", provides: [{ kind: "plugin", name: "nested" }] },
						{
							...base,
							name: "oversized",
							provides: Array.from({ length: 300 }, (_, i) => ({ kind: "skill", name: `s${i}` })),
						},
					],
				}),
			);
			const diagnostics: string[] = [];
			const rows = readPluginCatalog(file, diagnostics);
			deepStrictEqual(
				rows.map((row) => [row.name, row.provides?.length ?? null, row.index]),
				[
					["plain", null, file],
					["hinted", 1, file],
					["malformed", null, file],
					["oversized", null, file],
				],
			);
			strictEqual(diagnostics.length, 2);
			ok(diagnostics.every((message) => message.includes("provides ignored")));
		} finally {
			env.restore();
		}
	});

	it("keeps the GUI skills inventory wire contract fixed and exposes the recipes read through the CLI", async () => {
		const env = await isolateClioEnv("clio-coder-inventory-cli-");
		try {
			const cwd = join(env.dir, "workspace");
			mkdirSync(cwd);
			ok(
				installPlugin(materioSource, { cwd, scope: "project", origin: { kind: "catalog", source: materioSource } }).plugin
					?.loadable,
			);
			skill(cwd, ".clio-coder/skills/local", "local-skill");

			const gui = cli(env, cwd, ["inventory", "--json"]);
			strictEqual(gui.code, 0, gui.stderr);
			const snapshot = gui.json as Record<string, unknown>;
			deepStrictEqual(Object.keys(snapshot).sort(), [
				"diagnostics",
				"generatedAt",
				"invalidReason",
				"modelVisible",
				"skills",
				"skillsTruncated",
				"total",
				"valid",
				"version",
			]);
			strictEqual(snapshot.version, 1);
			const guiSkill = (snapshot.skills as Array<Record<string, unknown>>).find((item) => item.name === "local-skill");
			ok(guiSkill);
			deepStrictEqual(Object.keys(guiSkill).sort(), [
				"allowedTools",
				"audit",
				"description",
				"diagnostics",
				"disallowedTools",
				"installedAt",
				"installedByWorker",
				"modelInvocable",
				"modelVisible",
				"name",
				"precedence",
				"scope",
				"source",
				"trusted",
				"updatable",
				"updatedAt",
			]);

			const recipes = cli(env, cwd, ["recipes", "--kind", "agent", "--json"]);
			strictEqual(recipes.code, 0, recipes.stderr);
			const read = recipes.json as {
				version: number;
				resources: LibraryResource[];
				packages?: unknown;
				truncated: unknown;
			};
			strictEqual(read.version, 1);
			strictEqual(read.packages, undefined);
			ok(read.resources.every((item) => item.kind === "agent"));
			strictEqual(byOwner(read.resources, "plugin:materio").length, 6);
			ok(read.resources.some((item) => item.name === "coder" && item.origin.kind === "core"));
			ok(!read.resources.some((item) => item.audience === "shadow" || item.audience === "internal"));
			ok(
				!JSON.stringify(read).includes("materials research interviews, supplied-corpus synthesis, lab feasibility"),
				"no package descriptions leak into recipe rows",
			);

			const search = cli(env, cwd, ["search", "materio-execute-task", "--kind", "fleet", "--json"]);
			strictEqual(search.code, 0, search.stderr);
			const found = (search.json as { entries: Array<Record<string, unknown>> }).entries;
			deepStrictEqual(
				found.map((item) => [item.kind, item.name, (item.provenance as { kind: string }).kind]),
				[["plugin", "materio", "bundled"]],
			);
			ok(Array.isArray(found[0]?.provides));
			ok(Array.isArray(found[0]?.installed));

			const inspect = cli(env, cwd, ["inspect", "plugin:materio", "--json"]);
			strictEqual(inspect.code, 0, inspect.stderr);
			const detail = inspect.json as { id: string; scope: string; library: ReturnType<typeof inspectLibraryCopy> };
			strictEqual(detail.id, "materio");
			strictEqual(detail.scope, "project");
			strictEqual(detail.library.copy.origin.kind, "bundled");
			strictEqual(detail.library.resources.length, 30);
			strictEqual(
				detail.library.resources.find((item) => item.name === "materio-task-verifier")?.componentId,
				"task-verifier",
			);

			const bad = cli(env, cwd, ["recipes", "--kind", "plugin", "--json"]);
			strictEqual(bad.code, 1);
		} finally {
			env.restore();
		}
	});
});
