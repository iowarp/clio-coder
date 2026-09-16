/**
 * Outbound portability: the canonical `library/` sources stay installable by
 * Claude Code and loadable by Codex without a second hand-maintained catalog.
 *
 * These are static repository contracts. They deliberately do not shell out to
 * a host CLI, because a host binary is not something this repository owns or
 * can require in CI. The host layouts were measured on Claude Code 2.1.267
 * and Codex 0.153.3; these checks cover canonical sources and optional link
 * setup, not live host discovery.
 */

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	cpSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { renderLibraryMarketplace } from "../../scripts/generate-library-marketplace.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
describe("the portable inclusion rule", () => {
	/**
	 * The library accepts agent-, prompt- and fleet-only packages, and the
	 * composite authoring template puts a Clio strict-v1 recipe in a top-level
	 * `agents/` directory. Claude Code default-scans `agents/` with no manifest
	 * and no marketplace field asking it to: publishing the composite template
	 * on 2.1.267 produced `Agents (1) data-curator`, and `--strict` validation
	 * raised nothing. So the generator publishes a package only when a host
	 * would load a real skill surface from it and nothing else, and reports the
	 * rest instead of failing the pin for the whole library.
	 */
	const fixtures = mkdtempSync(join(tmpdir(), "clio-coder-portability-"));
	after(() => rmSync(fixtures, { recursive: true, force: true }));

	const TEMPLATES = join(REPO_ROOT, "library", "_authoring", "templates");

	/** A throwaway repository root holding just the named packages and their pins. */
	function fixtureRoot(name: string, packages: ReadonlyArray<{ name: string; template: string }>): string {
		const root = join(fixtures, name);
		mkdirSync(join(root, "library", "plugins"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ homepage: "https://example.invalid" }));
		const pins = packages.map((pkg) => {
			const directory = join(root, "library", "plugins", pkg.name);
			cpSync(join(TEMPLATES, pkg.template), directory, { recursive: true });
			const manifest = JSON.parse(readFileSync(join(directory, "plugin.json"), "utf8")) as {
				name: string;
				version: string;
				description?: string;
			};
			manifest.name = pkg.name;
			writeFileSync(join(directory, "plugin.json"), JSON.stringify(manifest, null, "\t"));
			return {
				kind: "plugin",
				name: pkg.name,
				description: manifest.description ?? "",
				version: manifest.version,
				sourceUrl: `plugins/${pkg.name}`,
				sha256: "0".repeat(64),
			};
		});
		writeFileSync(join(root, "library", "registry.yaml"), stringifyYaml({ entries: pins }));
		return root;
	}

	it("refuses to publish a package whose root agents/ Claude Code would claim as native", () => {
		const root = fixtureRoot("composite", [{ name: "composite", template: "plugin" }]);
		const result = renderLibraryMarketplace({ root });
		deepStrictEqual(result.errors, []);
		deepStrictEqual(result.entries, []);
		equal(result.excluded.length, 1);
		equal(result.excluded[0]?.name, "composite");
		ok(
			result.excluded[0]?.reason.includes("root agents"),
			`reason should name the host-scanned directory: ${result.excluded[0]?.reason}`,
		);
	});

	it("refuses to publish native-only packages, naming the missing skill surface", () => {
		const root = fixtureRoot("native-only", [
			{ name: "agent-only", template: "agent" },
			{ name: "prompt-only", template: "prompt" },
			{ name: "fleet-only", template: "fleet" },
		]);
		const result = renderLibraryMarketplace({ root });
		deepStrictEqual(result.errors, []);
		deepStrictEqual(result.entries, []);
		deepStrictEqual(result.excluded.map((entry) => entry.name).sort(), ["agent-only", "fleet-only", "prompt-only"]);
		const promptOnly = result.excluded.find((entry) => entry.name === "prompt-only");
		ok(promptOnly?.reason.includes("no portable skill surface"), `actionable reason expected: ${promptOnly?.reason}`);
	});

	it("still publishes a standalone skill package alongside them", () => {
		const root = fixtureRoot("mixed", [
			{ name: "portable-skill", template: "skill" },
			{ name: "agent-only", template: "agent" },
		]);
		const result = renderLibraryMarketplace({ root });
		deepStrictEqual(result.errors, []);
		deepStrictEqual(
			result.entries.map((entry) => entry.name),
			["portable-skill"],
		);
		deepStrictEqual(
			result.excluded.map((entry) => entry.name),
			["agent-only"],
		);
	});
});

describe("canonical portable skill roots", () => {
	/**
	 * The canonical trees ship in library/**. Host discovery links are optional
	 * operator setup: a01edb61 removed the generated checkout links. Exercise
	 * that setup in a temporary directory without requiring a local .agents tree.
	 */
	const roots: ReadonlyArray<[string, string]> = [
		["clio-coder", "library/skills"],
		["materio", "library/plugins/materio/skills"],
	];
	const fixture = mkdtempSync(join(tmpdir(), "clio-coder-portable-links-"));
	after(() => rmSync(fixture, { recursive: true, force: true }));

	function skillFiles(root: string): string[] {
		return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
			const file = join(root, entry.name);
			if (entry.isDirectory()) return skillFiles(file);
			return entry.name === "SKILL.md" ? [file] : [];
		});
	}

	it("ships the complete pinned skill inventory in canonical trees", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { files: string[] };
		ok(manifest.files.includes("library/**"), "The package must include the canonical library trees.");
		const registry = parseYaml(readFileSync(join(REPO_ROOT, "library/registry.yaml"), "utf8")) as {
			entries: Array<{ kind: string; name: string; sourceUrl: string; provides: Array<{ kind: string; name: string }> }>;
		};
		const curated = registry.entries.filter((entry) => entry.kind === "skill");
		ok(curated.length > 0, "The curated skill inventory must not be empty.");
		deepStrictEqual(
			skillFiles(join(REPO_ROOT, "library/skills")).sort(),
			curated.map((entry) => join(REPO_ROOT, "library", entry.sourceUrl, "SKILL.md")).sort(),
		);
		const materio = registry.entries.find((entry) => entry.kind === "plugin" && entry.name === "materio");
		ok(materio, "The Materio bundle must remain pinned.");
		const bundledSkills = materio.provides.filter((entry) => entry.kind === "skill");
		ok(bundledSkills.length > 0, "The Materio skill inventory must not be empty.");
		deepStrictEqual(
			skillFiles(join(REPO_ROOT, "library/plugins/materio/skills"))
				.map((file) => {
					const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(file, "utf8"))?.[1];
					ok(frontmatter, `${file} must have skill frontmatter.`);
					return (parseYaml(frontmatter) as { name: string }).name;
				})
				.sort(),
			bundledSkills.map((entry) => entry.name).sort(),
		);
	});

	it("exposes exactly the canonical skills through optional host links without copying bodies", () => {
		for (const [name, target] of roots) {
			const canonical = realpathSync(join(REPO_ROOT, target));
			const withinRepo = relative(realpathSync(REPO_ROOT), canonical);
			ok(
				!isAbsolute(withinRepo) && withinRepo !== ".." && !withinRepo.startsWith(`..${sep}`),
				`${target} must resolve inside the repository.`,
			);
			const link = join(fixture, name);
			const linkTarget = relative(fixture, canonical);
			symlinkSync(linkTarget, link, "dir");
			ok(lstatSync(link).isSymbolicLink(), `${name} must be a link, never a copy.`);
			equal(readlinkSync(link), linkTarget);
			equal(realpathSync(link), canonical);
			const files = skillFiles(canonical);
			ok(files.length > 0, `${target} must expose portable skills.`);
			deepStrictEqual(
				skillFiles(link)
					.map((file) => realpathSync(file))
					.sort(),
				files.map((file) => realpathSync(file)).sort(),
			);
		}
		deepStrictEqual(readdirSync(fixture).sort(), roots.map(([name]) => name).sort());
	});
});
