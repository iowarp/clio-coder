import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";

import { resetXdgCache } from "../../src/core/xdg.js";
import { applyLibraryImport, planLibraryImport } from "../../src/domains/interop/import.js";
import {
	disablePlugin,
	listInstalledPlugins,
	pluginBaseDir,
	pluginContentDigest,
	pluginStatePath,
	readPluginInstallRecord,
	removePlugin,
	withPluginScopeLock,
} from "../../src/domains/plugins/index.js";
import type { PluginScope } from "../../src/domains/plugins/types.js";
import {
	applyLibraryLifecycle,
	type LibraryRefreshHost,
	libraryImportOutcome,
	planLibraryLifecycle,
	releaseLibraryLifecycle,
	retryLibraryRefresh,
} from "../../src/domains/resources/library-actions.js";

let root: string;
let previousConfig: string | undefined;
let previousCwd: string;

interface PackageSpec {
	name: string;
	version?: string;
	kind?: "plugin" | "skill";
	requires?: string[];
	skill?: string;
}

function source(spec: PackageSpec): string {
	const location = path.join(root, "sources", `${spec.name}-${spec.version ?? "1.0.0"}`);
	mkdirSync(path.join(location, "assets"), { recursive: true });
	const clio =
		spec.kind === "skill"
			? {
					manifestVersion: 1,
					kind: "skill",
					...(spec.requires ? { requires: spec.requires } : {}),
					resources: { skills: "." },
					components: [{ kind: "skill", id: spec.skill ?? spec.name, path: "SKILL.md" }],
				}
			: spec.requires
				? { manifestVersion: 1, requires: spec.requires, resources: {}, components: [] }
				: undefined;
	writeFileSync(
		path.join(location, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: spec.name,
			version: spec.version ?? "1.0.0",
			description: `Lifecycle fixture ${spec.name}`,
			...(clio ? { extensions: { "ai.iowarp.clio": clio } } : {}),
		}),
	);
	if (spec.kind === "skill")
		writeFileSync(
			path.join(location, "SKILL.md"),
			`---\nname: ${spec.skill ?? spec.name}\ndescription: Lifecycle skill ${spec.name}\n---\nUse it.\n`,
		);
	writeFileSync(path.join(location, "assets", "evidence.txt"), `evidence ${spec.version ?? "1.0.0"}`);
	return location;
}

function catalog(sources: string[]): void {
	writeFileSync(
		path.join(root, "config", "library.yaml"),
		stringify({
			entries: sources.map((location) => {
				const manifest = JSON.parse(readFileSync(path.join(location, "plugin.json"), "utf8"));
				const clio = manifest.extensions?.["ai.iowarp.clio"];
				return {
					kind: clio?.kind ?? "plugin",
					name: manifest.name,
					version: manifest.version,
					description: manifest.description,
					sourceUrl: location,
					sha256: pluginContentDigest(location),
					...(clio?.requires ? { requires: clio.requires } : {}),
				};
			}),
		}),
	);
}

function install(ref: string, scope: PluginScope = "user", withRequirements = false) {
	const plan = planLibraryLifecycle({ operation: "install", ref, scope, cwd: root, withRequirements });
	const result = applyLibraryLifecycle(plan);
	equal(
		result.failed,
		0,
		JSON.stringify(
			result.outcomes.map((item) => item.error),
			null,
			1,
		),
	);
	return result;
}

/** Both scopes are listed so precedence is the real cross-scope rule, not a single-scope view. */
function copy(scope: PluginScope, id: string) {
	return listInstalledPlugins(root, { all: true }).find((item) => item.id === id && item.scope === scope);
}

function stubHost(): { host: LibraryRefreshHost; calls: number } {
	const state = {
		calls: 0,
		host: (() => ({ status: "refreshed", generation: 1, changed: true })) as LibraryRefreshHost,
	};
	state.host = () => {
		state.calls += 1;
		return { status: "refreshed", generation: state.calls, changed: true };
	};
	return state;
}

function cli(args: string[]): { code: number; json: Record<string, unknown> } {
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			new URL("../../src/cli/index.ts", import.meta.url).pathname,
			"library",
			...args,
			"--json",
		],
		{ cwd: root, env: process.env, encoding: "utf8" },
	);
	const text = result.stdout || result.stderr;
	return { code: result.status ?? 1, json: JSON.parse(text) };
}

describe("library lifecycle plans", () => {
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "clio-coder-library-lifecycle-"));
		previousConfig = process.env.CLIO_CODER_CONFIG_DIR;
		previousCwd = process.cwd();
		process.env.CLIO_CODER_CONFIG_DIR = path.join(root, "config");
		mkdirSync(path.join(root, "config"));
		process.chdir(root);
		resetXdgCache();
	});
	afterEach(() => {
		process.chdir(previousCwd);
		if (previousConfig === undefined) delete process.env.CLIO_CODER_CONFIG_DIR;
		else process.env.CLIO_CODER_CONFIG_DIR = previousConfig;
		resetXdgCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses stale content, state and origin facts inside the writer lock", () => {
		catalog([source({ name: "alpha" })]);
		install("plugin:alpha");
		const stateFile = pluginStatePath("user", root);

		const removal = planLibraryLifecycle({ operation: "remove", ref: "plugin:alpha", scope: "user", cwd: root });
		writeFileSync(path.join(pluginBaseDir("user", root), "alpha", "assets", "evidence.txt"), "edited after review");
		const staleTree = applyLibraryLifecycle(removal);
		equal(staleTree.outcomes[0]?.status, "failed");
		equal(staleTree.outcomes[0]?.error?.code, "stale_plan");
		equal(staleTree.outcomes[0]?.error?.changed?.fact, "tree");
		ok(copy("user", "alpha"), "stale plan wrote nothing");

		const toggle = planLibraryLifecycle({ operation: "disable", ref: "plugin:alpha", scope: "user", cwd: root });
		disablePlugin("alpha", { cwd: root, scope: "user" });
		const staleState = applyLibraryLifecycle(toggle);
		equal(staleState.outcomes[0]?.error?.code, "stale_plan");
		equal(staleState.outcomes[0]?.error?.changed?.fact, "enabled");

		// Restore the recorded bytes so only provenance differs from the reviewed plan.
		writeFileSync(path.join(pluginBaseDir("user", root), "alpha", "assets", "evidence.txt"), "evidence 1.0.0");
		const enable = planLibraryLifecycle({ operation: "enable", ref: "plugin:alpha", scope: "user", cwd: root });
		equal(enable.applicable, true, enable.steps[0]?.refusal);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		state.installed.alpha.trust = "foreign";
		state.installed.alpha.origin = {
			kind: "import",
			source: path.join(root, "sources", "alpha-1.0.0"),
			transport: "local",
			format: "portable",
		};
		writeFileSync(stateFile, JSON.stringify(state));
		const staleOrigin = applyLibraryLifecycle(enable);
		equal(staleOrigin.outcomes[0]?.error?.code, "stale_plan");
		ok(["trust", "origin"].includes(String(staleOrigin.outcomes[0]?.error?.changed?.fact)));
		equal(copy("user", "alpha")?.enabled, false, "identical bytes with changed provenance did not enable");
	});

	it("keeps a disabled project copy shadowing the user copy and reveals it on removal", () => {
		catalog([source({ name: "shared", kind: "skill" })]);
		install("skill:shared", "user");
		install("skill:shared", "project");
		const disable = planLibraryLifecycle({ operation: "disable", ref: "skill:shared", scope: "project", cwd: root });
		equal(disable.steps[0]?.effectiveAfter?.scope, "project");
		equal(disable.steps[0]?.effectiveAfter?.loadable, false);
		match(disable.steps[0]?.fallbackNote ?? "", /still shadows the user copy/);
		const disabled = applyLibraryLifecycle(disable);
		equal(disabled.committed, 1);
		deepStrictEqual(disabled.outcomes[0]?.verification?.effective, { scope: "project", loadable: false });
		equal(copy("user", "shared")?.loadable, false);

		const remove = planLibraryLifecycle({ operation: "remove", ref: "skill:shared", scope: "project", cwd: root });
		equal(remove.steps[0]?.effectiveAfter?.scope, "user");
		const removed = applyLibraryLifecycle(remove);
		equal(removed.outcomes[0]?.status, "committed");
		equal(removed.outcomes[0]?.verification?.tree, "absent");
		equal(removed.outcomes[0]?.verification?.record, "absent");
		deepStrictEqual(removed.outcomes[0]?.verification?.effective, { scope: "user", loadable: true });
		equal(copy("user", "shared")?.loadable, true);
	});

	it("refuses newly broken dependents but not pre-existing breakage, in plans and raw writers", () => {
		catalog([
			source({ name: "dep", kind: "skill" }),
			source({ name: "consumer", requires: ["skill:dep"] }),
			source({ name: "orphan", requires: ["skill:never"] }),
			source({ name: "spare" }),
		]);
		install("skill:dep");
		install("plugin:consumer");
		install("plugin:spare");
		// An orphan with an unmet requirement is pre-existing breakage; install it through the raw writer.
		const orphanPlan = planLibraryLifecycle({ operation: "install", ref: "plugin:orphan", scope: "user", cwd: root });
		equal(orphanPlan.applicable, false);
		match(orphanPlan.steps[0]?.refusal ?? "", /library_requirement_missing: skill:never/);
		releaseLibraryLifecycle(orphanPlan);

		const remove = planLibraryLifecycle({ operation: "remove", ref: "skill:dep", scope: "user", cwd: root });
		equal(remove.applicable, false);
		deepStrictEqual(remove.steps[0]?.dependents.newlyBroken, [
			{ ref: "plugin:consumer", scope: "user", missing: ["skill:dep"] },
		]);
		const refused = applyLibraryLifecycle(remove);
		equal(refused.outcomes[0]?.error?.code, "refused");
		ok(copy("user", "dep"));

		const raw = removePlugin("dep", { cwd: root, scope: "user" });
		equal(raw.diagnostics[0]?.code, "dependents");
		ok(copy("user", "dep"), "raw writer cannot bypass dependency safety");
		equal(disablePlugin("dep", { cwd: root, scope: "user" }).diagnostics[0]?.code, "dependents");

		const spare = planLibraryLifecycle({ operation: "remove", ref: "plugin:spare", scope: "user", cwd: root });
		equal(spare.applicable, true, "unrelated removal is not blocked by other packages");
		equal(applyLibraryLifecycle(spare).committed, 1);

		const consumer = planLibraryLifecycle({ operation: "disable", ref: "plugin:consumer", scope: "user", cwd: root });
		equal(applyLibraryLifecycle(consumer).committed, 1);
		const afterwards = planLibraryLifecycle({ operation: "remove", ref: "skill:dep", scope: "user", cwd: root });
		equal(afterwards.applicable, true, "a disabled dependent is not newly broken");
	});

	it("catches dependents installed after planning at the writer boundary", () => {
		catalog([source({ name: "dep", kind: "skill" }), source({ name: "late", requires: ["skill:dep"] })]);
		install("skill:dep");
		const remove = planLibraryLifecycle({ operation: "remove", ref: "skill:dep", scope: "user", cwd: root });
		equal(remove.applicable, true);
		install("plugin:late");
		const result = applyLibraryLifecycle(remove);
		equal(result.outcomes[0]?.status, "failed");
		equal(result.outcomes[0]?.error?.code, "refused");
		ok(copy("user", "dep"));
	});

	it("retains committed dependency writes, lists unattempted work and refreshes after a partial batch", () => {
		const first = source({ name: "first", kind: "skill" });
		const second = source({ name: "second", kind: "skill" });
		const target = source({ name: "target", requires: ["skill:first", "skill:second"] });
		catalog([first, second, target]);
		const plan = planLibraryLifecycle({
			operation: "install",
			ref: "plugin:target",
			scope: "user",
			cwd: root,
			withRequirements: true,
		});
		deepStrictEqual(
			plan.steps.map((step) => step.identity.ref),
			["skill:first", "skill:second", "plugin:target"],
		);
		equal(
			plan.steps[2]?.expected.some((fact) => fact.id === "first"),
			false,
			"a batch never stales itself",
		);
		// Change the second dependency's source after review so its writer refuses the pinned digest.
		writeFileSync(path.join(second, "assets", "evidence.txt"), "changed after review");
		const refresh = stubHost();
		const result = applyLibraryLifecycle(plan, { refresh: refresh.host });
		deepStrictEqual(
			result.outcomes.map((item) => item.status),
			["committed", "failed", "unattempted"],
		);
		equal(result.committed, 1);
		equal(result.unattempted, 1);
		ok(copy("user", "first")?.loadable, "the committed dependency is retained");
		equal(copy("user", "second"), undefined);
		equal(copy("user", "target"), undefined);
		equal(result.refresh.status, "refreshed");
		equal(refresh.calls, 1, "refresh runs once after a partial batch");
		equal(result.outcomes[0]?.verification?.evidence, "post-refresh");
		equal(result.outcomes[0]?.verification?.resources[0]?.available, true);
	});

	it("preserves edited trees as recovery copies on update and removal", () => {
		const v1 = source({ name: "edited" });
		catalog([v1]);
		install("plugin:edited");
		const installed = path.join(pluginBaseDir("user", root), "edited");
		writeFileSync(path.join(installed, "assets", "evidence.txt"), "local work");
		const blocked = planLibraryLifecycle({ operation: "update", ref: "plugin:edited", scope: "user", cwd: root });
		equal(blocked.applicable, false);
		match(blocked.steps[0]?.refusal ?? "", /plugin_local_changes/);
		releaseLibraryLifecycle(blocked);

		const v2 = source({ name: "edited", version: "1.1.0" });
		catalog([v2]);
		const update = planLibraryLifecycle({
			operation: "update",
			ref: "plugin:edited",
			scope: "user",
			cwd: root,
			force: true,
		});
		equal(update.applicable, true);
		const updated = applyLibraryLifecycle(update);
		equal(updated.outcomes[0]?.status, "committed");
		const backup = updated.outcomes[0]?.recovery?.packageBackup;
		ok(backup && existsSync(backup));
		equal(readFileSync(path.join(backup, "assets", "evidence.txt"), "utf8"), "local work");
		equal(copy("user", "edited")?.version, "1.1.0");

		writeFileSync(path.join(installed, "assets", "evidence.txt"), "more local work");
		const remove = planLibraryLifecycle({ operation: "remove", ref: "plugin:edited", scope: "user", cwd: root });
		const removed = applyLibraryLifecycle(remove);
		equal(removed.outcomes[0]?.status, "committed");
		ok(removed.outcomes[0]?.recovery?.packageBackup && existsSync(removed.outcomes[0].recovery.packageBackup));
	});

	it("releases every staged remote source on cancel, failure and success", () => {
		const bundle = source({ name: "remote" });
		const tools = path.join(root, "bin");
		mkdirSync(tools);
		const clones = path.join(root, "clones.txt");
		writeFileSync(
			path.join(tools, "git"),
			`#!${process.execPath}\nconst fs=require('node:fs');const p=require('node:path');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(clones)},args.at(-1)+"\\n");fs.cpSync(${JSON.stringify(bundle)},p.join(args.at(-1),'plugins','remote'),{recursive:true});\n`,
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
		try {
			writeFileSync(
				path.join(root, "config", "library.yaml"),
				stringify({
					entries: [
						{
							kind: "plugin",
							name: "remote",
							version: "1.0.0",
							description: "remote fixture",
							sourceUrl: "https://github.com/example/repo/tree/v1/plugins/remote",
							sha256: pluginContentDigest(bundle),
						},
					],
				}),
			);
			const stagedDirs = () => readFileSync(clones, "utf8").trim().split("\n");
			const cancelled = planLibraryLifecycle({ operation: "install", ref: "plugin:remote", scope: "user", cwd: root });
			equal(cancelled.steps[0]?.source?.staged, true);
			ok(existsSync(stagedDirs()[0] as string));
			releaseLibraryLifecycle(cancelled);
			equal(existsSync(stagedDirs()[0] as string), false);
			equal(copy("user", "remote"), undefined, "cancel writes nothing");

			const committed = planLibraryLifecycle({ operation: "install", ref: "plugin:remote", scope: "user", cwd: root });
			const dry = applyLibraryLifecycle(committed, { dryRun: true });
			equal(dry.unattempted, 1);
			equal(copy("user", "remote"), undefined, "dry run writes nothing");
			equal(existsSync(stagedDirs()[1] as string), false, "dry run released its staging");

			const real = planLibraryLifecycle({ operation: "install", ref: "plugin:remote", scope: "user", cwd: root });
			equal(applyLibraryLifecycle(real).committed, 1);
			equal(existsSync(stagedDirs()[2] as string), false);
			const temp = readdirSync(tmpdir()).filter((name) => name.startsWith("clio-coder-plugin-"));
			for (const dir of stagedDirs()) ok(!temp.includes(path.basename(dir)));
		} finally {
			process.env.PATH = previousPath;
		}
	});

	it("reports refresh failure separately, retries refresh only, and re-verifies after a successful refresh", () => {
		catalog([source({ name: "refreshed", kind: "skill" })]);
		const plan = planLibraryLifecycle({ operation: "install", ref: "skill:refreshed", scope: "user", cwd: root });
		const failing: LibraryRefreshHost = () => {
			throw new Error("namespace clash");
		};
		const result = applyLibraryLifecycle(plan, { refresh: failing });
		equal(result.committed, 1);
		deepStrictEqual(result.refresh, { status: "failed", error: "namespace clash" });
		equal(result.outcomes[0]?.verification?.evidence, "pre-refresh");
		const installedAt = readPluginInstallRecord("refreshed", { cwd: root, scope: "user" })?.installedAt;
		const retry = stubHost();
		equal(retryLibraryRefresh(root, retry.host).status, "refreshed");
		equal(retry.calls, 1);
		equal(readPluginInstallRecord("refreshed", { cwd: root, scope: "user" })?.installedAt, installedAt, "no reinstall");
		equal(retryLibraryRefresh(root).status, "not-applicable");
	});

	it("keeps a durable commit when read-back verification fails and still refreshes", () => {
		catalog([source({ name: "durable" })]);
		const plan = planLibraryLifecycle({ operation: "install", ref: "plugin:durable", scope: "user", cwd: root });
		const refresh = stubHost();
		const corrupting: LibraryRefreshHost = (cwd) => {
			writeFileSync(pluginStatePath("user", root), "{broken");
			return refresh.host(cwd);
		};
		const result = applyLibraryLifecycle(plan, { refresh: corrupting });
		equal(result.outcomes[0]?.status, "committed");
		equal(result.committed, 1);
		equal(result.refresh.status, "refreshed");
		equal(result.outcomes[0]?.error?.code, "verification");
		equal(result.outcomes[0]?.verification?.evidence, "post-refresh");
		equal(result.outcomes[0]?.verification?.record, "unreadable");
		ok(existsSync(path.join(pluginBaseDir("user", root), "durable")), "the committed tree is still on disk");
	});

	it("fails fast with a locked code while another scope operation holds the peer lock", () => {
		catalog([source({ name: "locked", kind: "skill" })]);
		install("skill:locked", "user");
		install("skill:locked", "project");
		const plan = planLibraryLifecycle({ operation: "remove", ref: "skill:locked", scope: "project", cwd: root });
		ok(
			plan.steps[0]?.expected.some((fact) => fact.scope === "user"),
			"peer copy is a reviewed fact",
		);
		const held = withPluginScopeLock("user", root, () => applyLibraryLifecycle(plan));
		equal(held.outcomes[0]?.error?.code, "locked");
		ok(copy("project", "locked"));
		const again = planLibraryLifecycle({ operation: "remove", ref: "skill:locked", scope: "project", cwd: root });
		equal(applyLibraryLifecycle(again).committed, 1);
	});

	it("projects an import into the outcome shape with its actual kind and separate admission", () => {
		const foreign = source({ name: "imported", kind: "skill", skill: "imported-skill" });
		const plan = planLibraryImport(foreign, { cwd: root, scope: "project" });
		equal(plan.action, "install", plan.reasons.join("; "));
		const result = applyLibraryImport(plan, true, { trustProjectImports: false });
		equal(result.published, true);
		const outcome = libraryImportOutcome(plan, result);
		equal(outcome.status, "committed");
		equal(outcome.identity.ref, "skill:imported");
		equal(outcome.identity.scope, "project");
		equal(outcome.verification?.tree, "present");
		equal(copy("project", "imported")?.trust, "foreign");
		const admission = outcome.verification?.resources.find((item) => item.name === "imported-skill");
		ok(admission, "the published skill is visible to verification");
		equal(admission.available, false, "publication is not admission for foreign content");
	});

	it("exposes plans and outcomes through the CLI with additive JSON and dry-run for every mutation", () => {
		catalog([source({ name: "cli", kind: "skill" }), source({ name: "user", requires: ["skill:cli"] })]);
		const dry = cli(["install", "skill:cli", "--dry-run"]);
		equal(dry.code, 0, JSON.stringify(dry.json));
		equal(dry.json.confirmed, false);
		equal((dry.json.apply as { unattempted: number }).unattempted, 1);
		equal(copy("user", "cli"), undefined);
		const installed = cli(["install", "skill:cli"]);
		equal(installed.code, 0, JSON.stringify(installed.json));
		equal(installed.json.confirmed, true);
		equal((installed.json.writes as unknown[]).length, 1);
		equal((installed.json.apply as { refresh: { status: string } }).refresh.status, "not-applicable");
		const disableDry = cli(["disable", "skill:cli", "--dry-run"]);
		equal(disableDry.code, 0);
		equal(copy("user", "cli")?.enabled, true, "dry-run disable writes nothing");
		equal(cli(["install", "plugin:user"]).code, 0);
		const refused = cli(["remove", "skill:cli"]);
		equal(refused.code, 1);
		equal(refused.json.ok, false);
		match(String(refused.json.error), /would break user:plugin:user/);
		ok(copy("user", "cli"));
		const disabled = cli(["disable", "plugin:user"]);
		equal(disabled.code, 0);
		equal((disabled.json.plugin as { enabled: boolean }).enabled, false);
		const removed = cli(["remove", "skill:cli"]);
		equal(removed.code, 0, JSON.stringify(removed.json));
		equal(removed.json.removed, "skill:cli");
		equal(copy("user", "cli"), undefined);
	});

	it("keeps lifecycle code out of native workers and headless discovery", () => {
		const forbidden = [
			"src/worker",
			"src/engine/worker-runtime.ts",
			"src/domains/plugins/resources.ts",
			"src/domains/agents",
		];
		const repo = path.resolve(new URL("../..", import.meta.url).pathname);
		const walk = (target: string): string[] => {
			const full = path.join(repo, target);
			if (!existsSync(full)) return [];
			if (!readdirSync(path.dirname(full)).includes(path.basename(full))) return [];
			try {
				return readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
					entry.isDirectory() ? walk(path.join(target, entry.name)) : [path.join(target, entry.name)],
				);
			} catch {
				return [target];
			}
		};
		for (const file of forbidden.flatMap(walk).filter((file) => file.endsWith(".ts")))
			ok(!readFileSync(path.join(repo, file), "utf8").includes("library-actions"), `${file} imports lifecycle code`);
	});
});
