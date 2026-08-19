import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import type { SkillDeclaredToolPolicy } from "../../src/core/skill-activation.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { discoverMarketplaceSkills, installSkill } from "../../src/domains/resources/skills/marketplace.js";
import { createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

/**
 * The npm-install case. Every other marketplace test runs with this
 * repository as cwd or with an explicit catalog, and from a checkout
 * `<cwd>/skills` is a catalog by accident, which is how a package whose
 * runtime never read its own catalog or index shipped: an operator in their
 * own project, with no env var set, had no marketplace at all. These tests
 * run from a working directory that is not this repository, with the two
 * marketplace env vars unset, and expect the package's own catalog to answer.
 */

const CATALOG_ROOT = join(resolvePackageRoot(), "skills");

function catalogSkillNames(): string[] {
	const names: string[] = [];
	for (const category of readdirSync(CATALOG_ROOT, { withFileTypes: true })) {
		if (!category.isDirectory()) continue;
		for (const pkg of readdirSync(join(CATALOG_ROOT, category.name), { withFileTypes: true })) {
			if (pkg.isDirectory() && existsSync(join(CATALOG_ROOT, category.name, pkg.name, "SKILL.md"))) {
				names.push(pkg.name);
			}
		}
	}
	return names.sort();
}

function pendingPolicy(name: string) {
	return {
		allowedSkillNames: [name],
		requests: [{ name, args: "", source: "slash-command" as const, installed: false }],
		loadedSkillNames: new Set<string>(),
		loadedSkillPolicies: new Map<string, SkillDeclaredToolPolicy>(),
	};
}

describe("contracts/skills fresh install: the marketplace with nothing configured", () => {
	let isolated: Awaited<ReturnType<typeof isolateClioEnv>>;
	let project: string;

	before(async () => {
		isolated = await isolateClioEnv("clio-fresh-install-");
		delete process.env.CLIO_CODER_SKILL_CATALOG_DIR;
		delete process.env.CLIO_CODER_SKILL_MARKETPLACE_INDEX;
	});
	afterEach(() => {
		if (project) rmSync(project, { recursive: true, force: true });
	});
	after(() => isolated.restore());

	function freshProject(): string {
		project = mkdtempSync(join(tmpdir(), "clio-user-project-"));
		mkdirSync(join(project, "src"), { recursive: true });
		return project;
	}

	it("resolves the package catalog when the working tree has no skills/ folder", () => {
		const cwd = freshProject();
		strictEqual(existsSync(join(cwd, "skills")), false);
		const discovery = discoverMarketplaceSkills({ cwd, indexPath: null });
		strictEqual(discovery.status, "installable", discovery.diagnostics.join("; "));
		const names = discovery.skills.map((skill) => skill.name).sort();
		const expected = catalogSkillNames();
		ok(expected.includes("grill-me"), "the catalog under test must carry grill-me");
		strictEqual(JSON.stringify(names), JSON.stringify(expected));
		const grill = discovery.skills.find((skill) => skill.name === "grill-me");
		ok(grill);
		strictEqual(grill.origin, "catalog");
		strictEqual(grill.category, "workflow");
		// Rows resolve to the local package files, so install needs no network.
		strictEqual(grill.sourceUrl, join(CATALOG_ROOT, "workflow", "grill-me"));
	});

	it("falls back to the package index when catalog discovery is off and no config-dir index exists", () => {
		const cwd = freshProject();
		strictEqual(existsSync(join(isolated.dir, "config", "skill-marketplace.json")), false);
		const discovery = discoverMarketplaceSkills({ cwd, catalogDir: null });
		strictEqual(discovery.status, "installable", discovery.diagnostics.join("; "));
		const grill = discovery.skills.find((skill) => skill.name === "grill-me");
		ok(grill, "the shipped skill-marketplace.json must list grill-me");
		strictEqual(grill.origin, "index");
		ok(grill.sourceUrl.startsWith("https://github.com/iowarp/clio-coder/"), grill.sourceUrl);
	});

	it("installs a catalog skill by bare name into the project without touching the network", () => {
		const cwd = freshProject();
		const result = installSkill({ source: "grill-me", cwd, scope: "project" });
		strictEqual(result.name, "grill-me");
		strictEqual(result.path, join(cwd, ".clio-coder", "skills", "grill-me", "SKILL.md"));
		strictEqual(result.sourceUrl, join(CATALOG_ROOT, "workflow", "grill-me"));
		const installed = readFileSync(result.path, "utf8");
		ok(installed.includes("name: grill-me"), "installed copy must be the catalog skill");
		ok(installed.includes("installed-hash:"), "install must stamp provenance");
	});

	it("context(scope=skills) lists the marketplace and refuses a marketplace-only load by name, not as unknown", async () => {
		const cwd = freshProject();
		const tool = createContextTool({ getCwd: () => cwd });
		const listing = await tool.run({ scope: "skills" }, undefined);
		strictEqual(listing.kind, "ok");
		if (listing.kind !== "ok") return;
		const details = listing.details as {
			skills: Array<{ name: string }>;
			marketplace: Array<{ name: string; category?: string }>;
		};
		const installedNames = new Set(details.skills.map((skill) => skill.name));
		const marketplaceNames = details.marketplace.map((entry) => entry.name);
		// Every catalog skill is either installed on this host (compat roots are
		// real) or offered by the marketplace; never both, never neither.
		for (const name of catalogSkillNames()) {
			ok(installedNames.has(name) || marketplaceNames.includes(name), `${name} missing from both lists`);
			ok(!(installedNames.has(name) && marketplaceNames.includes(name)), `${name} listed twice`);
		}
		ok(listing.output.includes("Marketplace (not installed"), listing.output.slice(0, 400));
		ok(listing.output.includes("/skill <name> offers to install"), listing.output.slice(0, 400));
		const sample = marketplaceNames[0];
		ok(sample, "the host has every catalog skill installed; nothing left to prove here");
		const category = details.marketplace[0]?.category;
		ok(listing.output.includes(`- ${sample}${category ? ` [${category}]` : ""}: `), listing.output);
		strictEqual(listing.output.includes("No skills are installed"), false);

		const load = await tool.run({ scope: "skills", name: sample }, { pendingSkillPolicy: pendingPolicy(sample) });
		strictEqual(load.kind, "error");
		if (load.kind === "error") {
			ok(load.message.includes(`skill "${sample}" is not installed`), load.message);
			ok(load.message.includes(`/skill ${sample}`), load.message);
			strictEqual(load.message.includes("unknown skill"), false, load.message);
		}
	});

	it("keeps marketplace rows out of every worker registry, a recipe-bound listing, and a --no-skills run", async () => {
		const cwd = freshProject();
		// The worker registry itself, unbound: installed skills only. A worker
		// cannot install a skill or address the operator who could.
		const workerRegistry = createWorkerToolRegistry();
		const workerListing = await workerRegistry.invoke({ tool: ToolNames.Context, args: { scope: "skills" } }, {});
		strictEqual(workerListing.kind, "ok");
		if (workerListing.kind === "ok") {
			strictEqual(workerListing.result.kind, "ok");
			if (workerListing.result.kind === "ok") {
				strictEqual(workerListing.result.output.includes("Marketplace ("), false, workerListing.result.output);
				const details = workerListing.result.details as { marketplace?: unknown[] };
				strictEqual((details.marketplace ?? []).length, 0);
			}
		}
		// The same flag on a bare context tool.
		const flagged = createContextTool({ getCwd: () => cwd, skillMarketplace: false });
		const flaggedListing = await flagged.run({ scope: "skills" }, undefined);
		strictEqual(flaggedListing.kind, "ok");
		if (flaggedListing.kind === "ok") strictEqual(flaggedListing.output.includes("Marketplace ("), false);
		const bound = createContextTool({ getCwd: () => cwd });
		const boundListing = await bound.run(
			{ scope: "skills" },
			{
				pendingSkillPolicy: {
					allowedSkillNames: ["ship"],
					requests: [{ name: "ship", args: "", source: "recipe" as const, installed: true }],
					loadedSkillNames: new Set<string>(),
					loadedSkillPolicies: new Map<string, SkillDeclaredToolPolicy>(),
				},
			},
		);
		strictEqual(boundListing.kind, "ok");
		if (boundListing.kind === "ok") strictEqual(boundListing.output.includes("Marketplace ("), false);

		const noSkills = createContextTool({ getCwd: () => cwd, getSkillLoaderOptions: () => ({ disableDiscovery: true }) });
		const bare = await noSkills.run({ scope: "skills" }, undefined);
		strictEqual(bare.kind, "ok");
		if (bare.kind === "ok") {
			strictEqual(bare.output, "No skills are installed and no marketplace is configured.");
		}
		// A worker registry with nothing installed says only that; it never
		// claims no marketplace is configured, because it was never offered one.
		const bareWorker = createContextTool({
			getCwd: () => cwd,
			skillMarketplace: false,
			getSkillLoaderOptions: () => ({ disableDiscovery: true }),
		});
		const workerBare = await bareWorker.run({ scope: "skills" }, undefined);
		strictEqual(workerBare.kind, "ok");
		if (workerBare.kind === "ok") strictEqual(workerBare.output, "No skills are installed.");
	});
});

describe("contracts/skills fresh install: the CLI from a foreign working directory", () => {
	const scratch = makeScratchHome("clio-fresh-cli-");
	const project = mkdtempSync(join(tmpdir(), "clio-user-project-cli-"));
	// An empty value reads as unset, so a host that exports either variable
	// cannot hand this test the marketplace it is supposed to find on its own.
	const env: NodeJS.ProcessEnv = {
		...scratch.env,
		CLIO_CODER_SKILL_CATALOG_DIR: "",
		CLIO_CODER_SKILL_MARKETPLACE_INDEX: "",
	};
	after(() => {
		scratch.cleanup();
		rmSync(project, { recursive: true, force: true });
	});

	it("skills search finds a catalog skill and install lands it by bare name", async () => {
		const search = await runCli(["skills", "search", "grill", "--json"], { env, cwd: project });
		strictEqual(search.code, 0, `stderr=${search.stderr}`);
		const payload = JSON.parse(search.stdout) as {
			marketplace: Array<{ name: string; origin: string }>;
			marketplaceDiagnostics: string[];
		};
		ok(
			payload.marketplace.some((entry) => entry.name === "grill-me" && entry.origin === "catalog"),
			`marketplace=${JSON.stringify(payload.marketplace)}`,
		);
		strictEqual(payload.marketplaceDiagnostics.length, 0, payload.marketplaceDiagnostics.join("; "));

		const install = await runCli(["skills", "install", "grill-me"], { env, cwd: project });
		strictEqual(install.code, 0, `stderr=${install.stderr}`);
		ok(install.stdout.includes("installed project skill grill-me"), install.stdout);
		ok(existsSync(join(project, ".clio-coder", "skills", "grill-me", "SKILL.md")));

		const list = await runCli(["skills", "list", "--json"], { env, cwd: project });
		strictEqual(list.code, 0, `stderr=${list.stderr}`);
		const listed = JSON.parse(list.stdout) as { skills: Array<{ name: string; scope: string }> };
		ok(listed.skills.some((skill) => skill.name === "grill-me" && skill.scope === "project"));
	});
});
