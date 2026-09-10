/**
 * Outbound portability: the canonical `library/` sources stay installable by
 * Claude Code and loadable by Codex without a second hand-maintained catalog.
 *
 * These are static repository contracts. They deliberately do not shell out to
 * a host CLI, because a host binary is not something this repository owns or
 * can require in CI. `scripts/verify-portable-hosts.sh` reproduces the host
 * behavior asserted here against the real Claude Code and Codex CLIs in
 * throwaway homes; the layouts below were measured on Claude Code 2.1.267 and
 * Codex 0.153.3.
 */

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { renderLibraryMarketplace } from "../../scripts/generate-library-marketplace.js";
import { parseFrontmatter } from "../../src/domains/agents/frontmatter.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MARKETPLACE_PATH = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
const REGISTRY_PATH = join(REPO_ROOT, "library", "registry.yaml");

interface MarketplaceEntry {
	name: string;
	source: string;
	description?: string;
	version?: string;
	category?: string;
}

interface Marketplace {
	name: string;
	owner: { name: string; url?: string };
	description?: string;
	plugins: MarketplaceEntry[];
}

interface RegistryEntry {
	kind: string;
	name: string;
	description?: string;
	category?: string;
	version: string;
	sourceUrl: string;
}

const marketplace = JSON.parse(readFileSync(MARKETPLACE_PATH, "utf8")) as Marketplace;
const registry = (parseYaml(readFileSync(REGISTRY_PATH, "utf8")) as { entries: RegistryEntry[] }).entries;

/** Marketplace names Anthropic reserves for its own use (marketplace reference). */
const RESERVED_MARKETPLACE_NAMES = new Set([
	"claude-code-marketplace",
	"claude-code-plugins",
	"claude-plugins-official",
	"claude-plugins-community",
	"claude-community",
	"anthropic-marketplace",
	"anthropic-plugins",
	"agent-skills",
	"anthropic-agent-skills",
	"knowledge-work-plugins",
	"life-sciences",
	"claude-for-legal",
	"claude-for-financial-services",
	"financial-services-plugins",
	"first-party-plugins",
	"claude-tag-plugins",
	"healthcare",
]);

describe("generated Claude Code marketplace", () => {
	it("is exactly what the generator produces from the pinned packages", () => {
		const rendered = renderLibraryMarketplace({ root: REPO_ROOT });
		deepStrictEqual(rendered.errors, []);
		equal(
			readFileSync(MARKETPLACE_PATH, "utf8"),
			rendered.content,
			".claude-plugin/marketplace.json is stale; run `pnpm run library:pin`",
		);
	});

	it("carries the metadata Claude Code requires of a marketplace", () => {
		ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(marketplace.name), `marketplace name must be kebab-case: ${marketplace.name}`);
		ok(!RESERVED_MARKETPLACE_NAMES.has(marketplace.name), `${marketplace.name} is reserved for Anthropic`);
		ok(marketplace.owner.name.length > 0, "marketplace owner needs a name");
		ok((marketplace.description ?? "").length > 0, "marketplace needs a description");
	});

	/**
	 * Parity is against the packages the inclusion rule says are publishable, not
	 * against the whole registry. A future agent-, prompt- or fleet-only package
	 * is a legitimate library contribution with no peer-host projection, and it
	 * must not fail this contract; what must never happen is the marketplace
	 * naming a package the library does not pin, or dropping a publishable one.
	 */
	it("has one entry per publishable library package and no others", () => {
		const rendered = renderLibraryMarketplace({ root: REPO_ROOT });
		const publishable = registry
			.map((entry) => entry.name)
			.filter((name) => !rendered.excluded.some((skip) => skip.name === name));
		deepStrictEqual(marketplace.plugins.map((entry) => entry.name).sort(), publishable.sort());
		equal(new Set(marketplace.plugins.map((entry) => entry.name)).size, marketplace.plugins.length);
		const pinnedNames = new Set(registry.map((entry) => entry.name));
		for (const entry of marketplace.plugins) {
			ok(pinnedNames.has(entry.name), `${entry.name} is published but not pinned in the library`);
		}
	});

	it("keeps every entry's identity in parity with the pinned package", () => {
		const pinned = new Map(registry.map((entry) => [entry.name, entry]));
		for (const entry of marketplace.plugins) {
			const pin = pinned.get(entry.name);
			ok(pin, `${entry.name} is not a pinned library package`);
			equal(entry.version, pin.version, `${entry.name}: version drifted from the pin`);
			equal(entry.description, pin.description, `${entry.name}: description drifted from the pin`);
			equal(entry.source, `./library/${pin.sourceUrl}`, `${entry.name}: source drifted from the pinned path`);
			if (pin.category) equal(entry.category, pin.category, `${entry.name}: category drifted from the pin`);
			ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name), `${entry.name} must be kebab-case for plugin install`);
		}
	});

	it("contains every source path inside the repository", () => {
		for (const entry of marketplace.plugins) {
			ok(entry.source.startsWith("./"), `${entry.name}: source must start with ./ (got ${entry.source})`);
			ok(!entry.source.split("/").includes(".."), `${entry.name}: source must not traverse upward`);
			const resolved = resolve(REPO_ROOT, entry.source);
			const inside = relative(REPO_ROOT, resolved);
			ok(inside.length > 0 && !inside.startsWith(".."), `${entry.name}: source escapes the marketplace root`);
			ok(existsSync(resolved), `${entry.name}: source directory ${entry.source} does not exist`);
		}
	});

	it("never publishes the authoring templates", () => {
		for (const entry of marketplace.plugins) {
			ok(!entry.source.includes("_authoring"), `${entry.name} must not publish an authoring template`);
		}
		ok(existsSync(join(REPO_ROOT, "library", "_authoring", "templates")), "templates should still exist for authors");
	});
});

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

	/**
	 * The floor the rule may never drop below. Every skill-kind package and the
	 * Materio bundle must keep publishing. Anything else the rule excludes is
	 * allowed, so a later native-only contribution does not break this.
	 */
	it("keeps publishing every skill package and the Materio bundle", () => {
		const result = renderLibraryMarketplace({ root: REPO_ROOT });
		deepStrictEqual(result.errors, []);
		const published = new Set(result.entries.map((entry) => entry.name));
		for (const entry of registry) {
			if (entry.kind !== "skill") continue;
			ok(published.has(entry.name), `skill package ${entry.name} stopped publishing: it must always have a projection`);
		}
		ok(published.has("materio"), "the Materio bundle must keep publishing its portable skills");
		ok(published.size >= 34, `the curated catalog must keep publishing at least 34 entries, got ${published.size}`);
	});
});

describe("marketplace entries are installable as the host loads them", () => {
	/**
	 * Claude Code loads a plugin's root `SKILL.md` only when there is no
	 * `skills/` directory and no `skills` manifest field, and takes the
	 * invocation name from that file's frontmatter. A package that grew a
	 * `skills/` directory without changing its entry would silently stop
	 * publishing its skill, so both layouts are asserted, not assumed.
	 */
	it("gives every skill entry a root SKILL.md whose frontmatter name is the entry name", () => {
		const skillEntries = marketplace.plugins.filter(
			(entry) => registry.find((pin) => pin.name === entry.name)?.kind === "skill",
		);
		equal(
			skillEntries.length,
			registry.filter((entry) => entry.kind === "skill").length,
			"every pinned skill package should publish",
		);
		ok(
			skillEntries.length >= 33,
			`the curated catalog must keep publishing at least 33 skills, got ${skillEntries.length}`,
		);
		for (const entry of skillEntries) {
			const root = resolve(REPO_ROOT, entry.source);
			const skillFile = join(root, "SKILL.md");
			ok(existsSync(skillFile), `${entry.name}: no root SKILL.md at ${entry.source}`);
			ok(!existsSync(join(root, "skills")), `${entry.name}: a skills/ directory would suppress the root SKILL.md`);
			const { frontmatter } = parseFrontmatter(readFileSync(skillFile, "utf8"), skillFile);
			equal(
				frontmatter.name,
				entry.name,
				`${entry.name}: SKILL.md frontmatter name decides the invocation name after install`,
			);
			ok(
				typeof frontmatter.description === "string" && frontmatter.description.length > 0,
				`${entry.name}: SKILL.md needs a description for host skill selection`,
			);
			const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")) as { skills?: unknown };
			equal(manifest.skills, undefined, `${entry.name}: a top-level skills field would suppress the root SKILL.md`);
		}
	});

	it("publishes exactly Materio's six portable skills and none of its Clio-native resources", () => {
		const materio = marketplace.plugins.find((entry) => entry.name === "materio");
		ok(materio, "materio should be published");
		const root = resolve(REPO_ROOT, materio.source);
		const skills = readdirSync(join(root, "skills"), { withFileTypes: true })
			.filter((item) => item.isDirectory())
			.map((item) => item.name)
			.sort();
		deepStrictEqual(skills, [
			"materio-lab-definer",
			"materio-literature-reviewer",
			"materio-research-explorer",
			"materio-task-executor",
			"materio-task-verifier",
			"materio-workflow-planner",
		]);
		for (const skill of skills) {
			ok(existsSync(join(root, "skills", skill, "SKILL.md")), `${skill} needs a SKILL.md`);
		}
		// Clio-native resources stay under the optional ai.iowarp.clio overlay,
		// which no host scans, so they travel with the bytes without ever being
		// presented as Claude-native agents, commands or output styles.
		for (const hostScanned of ["agents", "commands", "hooks", "output-styles"]) {
			ok(!existsSync(join(root, hostScanned)), `materio must not expose a host-scanned ${hostScanned}/ directory`);
		}
		ok(existsSync(join(root, "ai.iowarp.clio", "agents")), "Materio's Clio agents should stay in the Clio overlay");
	});

	it("keeps every companion file a published package's manifest points at", () => {
		for (const entry of marketplace.plugins) {
			const root = resolve(REPO_ROOT, entry.source);
			const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")) as {
				extensions?: { "ai.iowarp.clio"?: { components?: { id: string; path: string }[] } };
			};
			for (const component of manifest.extensions?.["ai.iowarp.clio"]?.components ?? []) {
				ok(
					existsSync(join(root, component.path)),
					`${entry.name}: component ${component.id} points at missing ${component.path}`,
				);
			}
		}
	});
});

describe("Codex skills roots", () => {
	/**
	 * Codex scans `$REPO_ROOT/.agents/skills`, recurses into subdirectories and
	 * follows symlinks at that location. Two links therefore publish the whole
	 * canonical catalog to a Codex session started in a clone, with no copied
	 * SKILL.md bodies and no wrapper tree.
	 */
	const expected: ReadonlyArray<[string, string]> = [
		["clio-coder", "../../library/skills"],
		["materio", "../../library/plugins/materio/skills"],
	];

	it("links the canonical directories and nothing else", () => {
		const root = join(REPO_ROOT, ".agents", "skills");
		const entries = readdirSync(root).sort();
		deepStrictEqual(entries, expected.map(([name]) => name).sort());
		for (const [name, target] of expected) {
			const link = join(root, name);
			ok(lstatSync(link).isSymbolicLink(), `.agents/skills/${name} must stay a symlink, never a copy`);
			equal(readlinkSync(link).split("\\").join("/"), target, `.agents/skills/${name} must point at the canonical tree`);
			const resolved = resolve(root, target);
			ok(existsSync(join(resolved)), `.agents/skills/${name} target is missing`);
			ok(!relative(REPO_ROOT, resolved).startsWith(".."), `.agents/skills/${name} must stay inside the repository`);
		}
	});

	it("exposes every curated skill Codex discovers, by its canonical name", () => {
		const found: string[] = [];
		const walk = (directory: string): void => {
			for (const item of readdirSync(directory, { withFileTypes: true })) {
				if (!item.isDirectory()) continue;
				const child = join(directory, item.name);
				if (existsSync(join(child, "SKILL.md"))) found.push(item.name);
				else walk(child);
			}
		};
		for (const [name] of expected) walk(join(REPO_ROOT, ".agents", "skills", name));
		for (const entry of registry.filter((pin) => pin.kind === "skill")) {
			ok(found.includes(entry.name), `${entry.name} should be reachable through the Codex skills root`);
		}
		const materioSkills = readdirSync(join(REPO_ROOT, "library", "plugins", "materio", "skills"), {
			withFileTypes: true,
		}).filter((item) => item.isDirectory());
		for (const skill of materioSkills) {
			ok(found.includes(skill.name), `${skill.name} should be reachable through the Codex skills root`);
		}
		equal(found.length, registry.filter((pin) => pin.kind === "skill").length + materioSkills.length);
		ok(found.length >= 39, `the curated catalog must stay reachable to Codex, got ${found.length}`);
	});

	it("keeps the authoring templates out of every Codex skills root", () => {
		for (const [name, target] of expected) {
			ok(!target.includes("_authoring"), `.agents/skills/${name} must not expose authoring templates`);
		}
	});
});

describe("npm distribution carries the outbound metadata", () => {
	const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { files: string[] };
	const releaseManifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "release-manifest.json"), "utf8")) as {
		requiredFiles: string[];
	};

	it("ships the marketplace manifest so the installed package is itself a marketplace", () => {
		ok(
			packageJson.files.includes(".claude-plugin/marketplace.json"),
			"package.json files must ship .claude-plugin/marketplace.json",
		);
		ok(
			releaseManifest.requiredFiles.includes(".claude-plugin/marketplace.json"),
			"the release gate must require .claude-plugin/marketplace.json",
		);
	});

	it("ships every path the marketplace entries resolve to", () => {
		const shipsLibrary = packageJson.files.some((pattern) => pattern === "library/**" || pattern === "library");
		ok(shipsLibrary, "marketplace sources point into library/, which must ship");
		for (const entry of marketplace.plugins) {
			ok(entry.source.startsWith("./library/"), `${entry.name}: source must resolve inside the shipped library tree`);
		}
	});
});
