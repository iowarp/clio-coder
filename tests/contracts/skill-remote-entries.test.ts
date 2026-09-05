import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import yaml from "yaml";
import { normalizedSkillHash } from "../../src/domains/resources/skills/content-hash.js";
import { installSkillFromSource, updateSkills } from "../../src/domains/resources/skills/install.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { discoverMarketplaceSkills } from "../../src/domains/resources/skills/marketplace.js";

/**
 * Remote marketplace entries: a skill whose content lives in another
 * repository at a pinned ref, installed as that upstream tree with a
 * Clio-owned overlay laid on top and named top-level members dropped.
 * Clio never vendors the upstream; the index only points at it.
 */

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-remote-skill-"));
	roots.push(root);
	return root;
}

const PIN_SCRIPT = join(process.cwd(), "scripts", "pin-skills.ts");
const UPSTREAM_URL = "https://github.com/example/mapper/tree/v1.2.3/mapper";

function wrapperSkill(body = "Wrapper body that never runs an update check."): string {
	return [
		"---",
		"name: mapper",
		'description: "Wraps the upstream mapper renderer."',
		"triggers:",
		"  - map this repository",
		"version: 0.1.0",
		"license: MIT",
		"clio-coder:",
		"  registry-id: example/catalog",
		"  source-url: https://github.com/example/catalog/tree/main/skills/planning/mapper",
		"  audit: pass",
		"  provenance: adapted",
		`  origin: ${UPSTREAM_URL}`,
		"  eval-status: scenarios-recorded",
		"---",
		"",
		body,
		"",
	].join("\n");
}

/** A package root holding a catalog with one ordinary skill and one overlay package. */
function writeCatalogPackage(root: string, options: { remote: boolean }): { packageRoot: string; catalog: string } {
	const packageRoot = join(root, "pkg");
	const catalog = join(packageRoot, "skills");
	const plain = join(catalog, "coding", "plain");
	mkdirSync(plain, { recursive: true });
	writeFileSync(
		join(plain, "SKILL.md"),
		[
			"---",
			"name: plain",
			'description: "An ordinary catalog skill."',
			"version: 0.1.0",
			"license: MIT",
			"clio-coder:",
			"  registry-id: example/catalog",
			"  source-url: https://github.com/example/catalog/tree/main/skills/coding/plain",
			"  audit: pass",
			"  provenance: designed",
			"  eval-status: untested",
			"---",
			"",
			"Plain body.",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(join(plain, "evals.md"), "# Evals\n", "utf8");
	const overlay = join(catalog, "planning", "mapper");
	mkdirSync(overlay, { recursive: true });
	writeFileSync(join(overlay, "SKILL.md"), wrapperSkill(), "utf8");
	writeFileSync(join(overlay, "evals.md"), "# Evals\n", "utf8");
	if (options.remote) {
		writeFileSync(
			join(catalog, "remote.yaml"),
			yaml.stringify({
				version: 1,
				skills: [
					{
						name: "mapper",
						category: "planning",
						sourceUrl: UPSTREAM_URL,
						overlay: "skills/planning/mapper",
						exclude: ["test", "package-lock.json"],
					},
				],
			}),
			"utf8",
		);
	}
	return { packageRoot, catalog };
}

function runPin(catalog: string, ...args: string[]): { status: number; stderr: string } {
	try {
		execFileSync(process.execPath, ["--import", "tsx", PIN_SCRIPT, "--dir", catalog, ...args], {
			cwd: process.cwd(),
			stdio: "pipe",
		});
		return { status: 0, stderr: "" };
	} catch (err) {
		const failure = err as { status?: number; stderr?: Buffer };
		return { status: failure.status ?? 1, stderr: failure.stderr?.toString("utf8") ?? "" };
	}
}

/** A fake upstream skill package: a renderer with bin/, a test/ tree, and its own SKILL.md. */
function writeUpstream(root: string): string {
	const upstream = join(root, "upstream", "mapper");
	mkdirSync(join(upstream, "bin"), { recursive: true });
	mkdirSync(join(upstream, "test", "nested"), { recursive: true });
	mkdirSync(join(upstream, "renderers", "test"), { recursive: true });
	writeFileSync(
		join(upstream, "SKILL.md"),
		"---\nname: mapper\ndescription: Upstream mapper.\n---\n\nUpstream body. Run scripts/check-update.mjs after the first candidate.\n",
		"utf8",
	);
	writeFileSync(join(upstream, "bin", "mapper.mjs"), "console.log('render');\n", "utf8");
	writeFileSync(join(upstream, "test", "nested", "case.mjs"), "// test\n", "utf8");
	writeFileSync(join(upstream, "renderers", "test", "keep.mjs"), "// nested test dir stays\n", "utf8");
	writeFileSync(join(upstream, "package-lock.json"), "{}\n", "utf8");
	return upstream;
}

describe("remote marketplace entries", () => {
	it("publishes remote.yaml entries into the index and pins the overlay hash", () => {
		const { catalog } = writeCatalogPackage(scratch(), { remote: true });
		const pin = runPin(catalog);
		strictEqual(pin.status, 0, pin.stderr);

		const index = JSON.parse(readFileSync(join(catalog, "skill-marketplace.json"), "utf8")) as {
			skills: Array<Record<string, unknown>>;
		};
		const mapper = index.skills.find((entry) => entry.name === "mapper");
		ok(mapper);
		strictEqual(mapper.sourceUrl, UPSTREAM_URL);
		strictEqual(mapper.origin, "remote");
		strictEqual(mapper.overlay, "skills/planning/mapper");
		deepStrictEqual(mapper.exclude, ["test", "package-lock.json"]);
		strictEqual(mapper.description, "Wraps the upstream mapper renderer.");
		strictEqual(mapper.version, "0.1.0");
		strictEqual(mapper.audit, "pass");
		strictEqual(mapper.category, "planning");
		deepStrictEqual(mapper.triggers, ["map this repository"]);
		const plain = index.skills.find((entry) => entry.name === "plain");
		ok(plain);
		strictEqual(plain.origin, undefined);
		strictEqual(plain.overlay, undefined);

		const registry = yaml.parse(readFileSync(join(catalog, "registry.yaml"), "utf8")) as {
			skills: Array<{ name: string; path: string; sha256: string }>;
		};
		const pinned = registry.skills.find((entry) => entry.name === "mapper");
		ok(pinned);
		strictEqual(pinned.path, "planning/mapper");
		strictEqual(pinned.sha256, normalizedSkillHash(wrapperSkill()));
		strictEqual(runPin(catalog, "--check").status, 0);
	});

	it("fails the check on overlay drift and on a remote entry whose overlay is missing", () => {
		const { catalog } = writeCatalogPackage(scratch(), { remote: true });
		strictEqual(runPin(catalog).status, 0);
		writeFileSync(join(catalog, "planning", "mapper", "SKILL.md"), wrapperSkill("Edited body."), "utf8");
		const drift = runPin(catalog, "--check");
		strictEqual(drift.status, 1);
		match(drift.stderr, /mapper: pin is stale/);

		rmSync(join(catalog, "planning", "mapper"), { recursive: true });
		const missing = runPin(catalog);
		strictEqual(missing.status, 1);
		match(missing.stderr, /overlay skills\/planning\/mapper has no SKILL\.md/);
	});

	it("installs the upstream tree with excluded members dropped and the overlay on top", () => {
		const root = scratch();
		const upstream = writeUpstream(root);
		const { packageRoot } = writeCatalogPackage(root, { remote: true });
		const overlay = join(packageRoot, "skills", "planning", "mapper");
		const project = join(root, "project");
		mkdirSync(project);

		const result = installSkillFromSource({
			source: upstream,
			scope: "project",
			cwd: project,
			overlay,
			exclude: ["test", "package-lock.json"],
		});
		const installed = join(project, ".clio-coder", "skills", "mapper");
		strictEqual(result.path, join(installed, "SKILL.md"));
		ok(existsSync(join(installed, "bin", "mapper.mjs")));
		ok(existsSync(join(installed, "evals.md")));
		strictEqual(existsSync(join(installed, "test")), false);
		strictEqual(existsSync(join(installed, "package-lock.json")), false);
		ok(existsSync(join(installed, "renderers", "test", "keep.mjs")), "only top-level names are excluded");

		const text = readFileSync(result.path, "utf8");
		match(text, /Wrapper body that never runs an update check/);
		strictEqual(text.includes("check-update"), false);
		strictEqual(result.installedHash, normalizedSkillHash(wrapperSkill()));
		strictEqual(result.sourceUrl, upstream);
		// The fetched source itself is untouched.
		ok(existsSync(join(upstream, "test", "nested", "case.mjs")));
		match(readFileSync(join(upstream, "SKILL.md"), "utf8"), /Upstream body/);

		const loaded = loadSkills({ cwd: project }).items.find((skill) => skill.name === "mapper");
		ok(loaded);
		strictEqual(loaded.provenance?.installUrl, upstream);
		strictEqual(loaded.provenance?.installedHash, result.installedHash);
	});

	it("keeps the overlay through an update when the resolver still names it", () => {
		const root = scratch();
		const upstream = writeUpstream(root);
		const { packageRoot } = writeCatalogPackage(root, { remote: true });
		const overlay = join(packageRoot, "skills", "planning", "mapper");
		const project = join(root, "project");
		mkdirSync(project);
		installSkillFromSource({ source: upstream, scope: "project", cwd: project, overlay, exclude: ["test"] });

		writeFileSync(join(upstream, "bin", "mapper.mjs"), "console.log('render v2');\n", "utf8");
		writeFileSync(join(overlay, "SKILL.md"), wrapperSkill("Wrapper body, second edition."), "utf8");
		const reports = updateSkills({
			cwd: project,
			name: "mapper",
			resolveShaping: (skill) => (skill.sourceUrl === upstream ? { overlay, exclude: ["test"] } : undefined),
		});
		deepStrictEqual(
			reports.map((report) => report.status),
			["updated"],
		);
		const installed = join(project, ".clio-coder", "skills", "mapper");
		match(readFileSync(join(installed, "SKILL.md"), "utf8"), /second edition/);
		match(readFileSync(join(installed, "bin", "mapper.mjs"), "utf8"), /render v2/);
		strictEqual(existsSync(join(installed, "test")), false);
	});

	it("lets an overlay-bearing index entry win over its own catalog folder", () => {
		const { catalog } = writeCatalogPackage(scratch(), { remote: true });
		strictEqual(runPin(catalog).status, 0);
		const discovered = discoverMarketplaceSkills({
			catalogDir: catalog,
			indexPath: join(catalog, "skill-marketplace.json"),
		});
		const mapper = discovered.skills.find((skill) => skill.name === "mapper");
		ok(mapper);
		strictEqual(mapper.origin, "index");
		strictEqual(mapper.sourceUrl, UPSTREAM_URL);
		strictEqual(mapper.overlay, "skills/planning/mapper");
		deepStrictEqual(mapper.exclude, ["test", "package-lock.json"]);
		const plain = discovered.skills.find((skill) => skill.name === "plain");
		ok(plain);
		strictEqual(plain.origin, "catalog");
		strictEqual(discovered.skills.filter((skill) => skill.name === "mapper").length, 1);
	});
});
