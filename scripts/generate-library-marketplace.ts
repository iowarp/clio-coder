/**
 * Regenerate `.claude-plugin/marketplace.json`: the standard Claude Code
 * repository marketplace that makes the canonical `library/` packages
 * installable by another agent without duplicating a single recipe body.
 *
 * Run through `pnpm run library:pin`; verified by `pnpm run library:check`,
 * which `lint` runs, so a stale marketplace fails the gate.
 * `scripts/verify-portable-hosts.sh` reproduces the host behavior this file
 * relies on, against real host CLIs in throwaway homes.
 *
 * Behavior measured against Claude Code 2.1.267 rather than assumed:
 *
 * - Every entry is a relative-path source into the canonical tree. Claude Code
 *   resolves it against the marketplace root, which is the repository root, and
 *   copies those bytes into its own plugin cache at install.
 * - A package with a root `SKILL.md`, no `skills/` subdirectory and no
 *   top-level `skills` manifest field loads as a single-skill plugin. Its
 *   invocation name comes from the `SKILL.md` frontmatter, so it survives the
 *   versioned cache directory. This is the standalone skill layout.
 * - A package with a `skills/` directory publishes exactly those skills.
 * - No package needs a `.claude-plugin/plugin.json` and no entry needs
 *   `strict: false`. Claude Code reads only `.claude-plugin/plugin.json`, treats
 *   it as optional, and takes display metadata from the entry.
 *
 * The entries are derived from `library/registry.yaml`, which `pin-library.ts`
 * generates from the actual package manifests and content digests. This file is
 * therefore a projection of the curated packages, never a second catalog anyone
 * edits by hand.
 *
 * References: Agent Skills specification (https://agentskills.io/specification);
 * the Claude Code plugins and plugin-marketplace references; the Codex "Build
 * skills" guide.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/** Public-facing marketplace id: users type `<plugin>@clio-coder` to install. */
const MARKETPLACE_NAME = "clio-coder";
const MARKETPLACE_DESCRIPTION =
	"The Clio Coder resource library: curated skills for planning, research, git and scientific software work, plus the Materio materials-research bundle.";
const OWNER_NAME = "IOWarp";

/** Entry fields Claude Code documents; anything else would fail `validate --strict`. */
interface MarketplaceEntry {
	name: string;
	source: string;
	description?: string;
	version?: string;
	category?: string;
	license?: string;
	author?: { name: string; email?: string; url?: string };
}

interface RegistryEntry {
	kind: string;
	name: string;
	description?: string;
	category?: string;
	version: string;
	sourceUrl: string;
}

interface PortableManifest {
	name?: string;
	version?: string;
	license?: string;
	author?: { name?: string; email?: string; url?: string } | string;
	skills?: unknown;
}

/**
 * Directories and files Claude Code loads by default from a plugin root, with
 * no manifest and no marketplace field asking it to. Measured on 2.1.267 by
 * publishing the composite authoring template, whose root `agents/` holds a
 * Clio strict-v1 recipe: `claude plugin details` reported `Agents (1)
 * data-curator`, and `claude plugin validate --strict` did not object.
 *
 * The library accepts agent-, prompt- and fleet-only packages and its composite
 * template uses ordinary top-level `agents/` and `prompts/` directories. Those
 * are first-class library packages; they simply have no vendor projection here.
 * Clio `prompts/` and `fleets/` are inert to Claude Code, but a root `agents/`
 * would silently present a Clio agent recipe as a native Claude agent, with
 * tools, model and budget fields the host never honors. A package like that is
 * not publishable, and saying so is the point: the alternative is a claimed
 * compatibility that was never measured. An author who wants one package to
 * serve both audiences declares its Clio resource roots at paths no host scans,
 * such as `native/agents`, through the resources map in the manifest.
 */
const HOST_SCANNED_ROOTS = ["agents", "commands", "hooks", "output-styles", ".mcp.json", ".claude-plugin"] as const;

/** Why a pinned package is not published to the Claude Code marketplace. */
interface Exclusion {
	name: string;
	sourceUrl: string;
	reason: string;
}

/**
 * The portable inclusion rule, in one place: a package publishes only when it
 * has a skill surface Claude Code actually loads, and carries nothing Claude
 * Code would default-scan into a host-native component.
 *
 * Returning a reason rather than throwing is deliberate. A future native-only
 * package is a normal library contribution, not a pinning failure, so it is
 * reported and skipped instead of breaking `library:pin` for everything else.
 */
function portabilityVerdict(directory: string, manifest: PortableManifest): { publish: boolean; reason?: string } {
	for (const scanned of HOST_SCANNED_ROOTS) {
		if (existsSync(path.join(directory, scanned))) {
			return {
				publish: false,
				reason: `a root ${scanned} would be default-scanned by Claude Code as a host-native component; the package stays a valid library package, and to publish it too, declare its Clio resource roots at a path no host scans, such as native/agents`,
			};
		}
	}

	const skillsDirectory = path.join(directory, "skills");
	const hasSkillsDirectory = existsSync(skillsDirectory);
	if (hasSkillsDirectory) {
		const published = readdirSync(skillsDirectory, { withFileTypes: true }).filter(
			(item) => item.isDirectory() && existsSync(path.join(skillsDirectory, item.name, "SKILL.md")),
		);
		if (published.length === 0) {
			return { publish: false, reason: "skills/ holds no <name>/SKILL.md, so a host would publish nothing" };
		}
		return { publish: true };
	}

	if (!existsSync(path.join(directory, "SKILL.md"))) {
		return {
			publish: false,
			reason: "no portable skill surface: neither a root SKILL.md nor a skills/ directory, so a host would load nothing",
		};
	}
	if (manifest.skills !== undefined) {
		return {
			publish: false,
			reason: "a top-level skills manifest field suppresses the root SKILL.md fallback; add a skills/ directory instead",
		};
	}
	return { publish: true };
}

export interface GenerateMarketplaceOptions {
	root?: string;
	check?: boolean;
}

export interface GenerateMarketplaceResult {
	ok: boolean;
	path: string;
	content: string;
	drift: boolean;
	driftLines: string[];
	errors: string[];
	entries: MarketplaceEntry[];
	excluded: Exclusion[];
}

/** `library/registry.yaml` records `sourceUrl` relative to `library/`. */
function entrySource(registrySourceUrl: string): string {
	return `./library/${registrySourceUrl}`;
}

/**
 * Marketplace-visible author, from the package's own portable manifest. A bare
 * string author has no documented object form here, so it is dropped rather
 * than guessed at.
 */
function entryAuthor(manifest: PortableManifest): MarketplaceEntry["author"] {
	const author = manifest.author;
	if (!author || typeof author === "string" || typeof author.name !== "string") return undefined;
	return {
		name: author.name,
		...(author.email ? { email: author.email } : {}),
		...(author.url ? { url: author.url } : {}),
	};
}

function readJson<T>(file: string): T {
	return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function renderLibraryMarketplace(options: GenerateMarketplaceOptions = {}): {
	content: string;
	entries: MarketplaceEntry[];
	excluded: Exclusion[];
	errors: string[];
} {
	const root = options.root ? path.resolve(options.root) : path.resolve(import.meta.dirname, "..");
	const registryPath = path.join(root, "library", "registry.yaml");
	const errors: string[] = [];

	if (!existsSync(registryPath)) {
		return {
			content: "",
			entries: [],
			excluded: [],
			errors: [`${registryPath} is missing; run pnpm run library:pin first`],
		};
	}

	const parsed = parse(readFileSync(registryPath, "utf8")) as { entries?: RegistryEntry[] } | null;
	const registry = Array.isArray(parsed?.entries) ? parsed.entries : [];
	if (registry.length === 0) errors.push("library/registry.yaml has no entries");

	const entries: MarketplaceEntry[] = [];
	const excluded: Exclusion[] = [];
	for (const entry of registry) {
		const directory = path.join(root, "library", entry.sourceUrl);
		const manifestPath = path.join(directory, "plugin.json");
		if (!existsSync(manifestPath)) {
			errors.push(`${entry.name}: no portable plugin.json at library/${entry.sourceUrl}`);
			continue;
		}
		const manifest = readJson<PortableManifest>(manifestPath);
		if (manifest.name !== entry.name) {
			errors.push(`${entry.name}: manifest name is ${JSON.stringify(manifest.name)}`);
		}
		if (manifest.version !== entry.version) {
			errors.push(`${entry.name}: manifest version ${manifest.version} does not match pinned ${entry.version}`);
		}
		const verdict = portabilityVerdict(directory, manifest);
		if (!verdict.publish) {
			excluded.push({ name: entry.name, sourceUrl: entry.sourceUrl, reason: verdict.reason ?? "not portable" });
			continue;
		}
		const author = entryAuthor(manifest);
		entries.push({
			name: entry.name,
			source: entrySource(entry.sourceUrl),
			...(entry.description ? { description: entry.description } : {}),
			version: entry.version,
			...(entry.category ? { category: entry.category } : {}),
			...(manifest.license ? { license: manifest.license } : {}),
			...(author ? { author } : {}),
		});
	}

	const packageJson = readJson<{ homepage?: string; repository?: { url?: string } }>(path.join(root, "package.json"));
	const marketplace = {
		name: MARKETPLACE_NAME,
		owner: {
			name: OWNER_NAME,
			...(packageJson.homepage ? { url: packageJson.homepage } : {}),
		},
		description: MARKETPLACE_DESCRIPTION,
		plugins: entries,
	};

	return { content: `${JSON.stringify(marketplace, null, "\t")}\n`, entries, excluded, errors };
}

/** Which entries a stale file is missing, holding stale, or holding orphaned. */
function describeDrift(current: string, expected: ReadonlyArray<MarketplaceEntry>): string[] {
	let actual: MarketplaceEntry[] = [];
	try {
		const parsed = JSON.parse(current) as { plugins?: MarketplaceEntry[] };
		actual = Array.isArray(parsed.plugins) ? parsed.plugins : [];
	} catch {
		return ["marketplace.json is not parseable JSON"];
	}
	const lines: string[] = [];
	const actualByName = new Map(actual.map((entry) => [entry.name, entry]));
	const expectedByName = new Map(expected.map((entry) => [entry.name, entry]));
	for (const entry of expected) {
		const found = actualByName.get(entry.name);
		if (!found) lines.push(`${entry.name}: pinned in the library but missing from the marketplace`);
		else if (found.version !== entry.version || found.source !== entry.source) {
			lines.push(`${entry.name}: marketplace entry is stale`);
		}
	}
	for (const entry of actual) {
		if (!expectedByName.has(entry.name)) lines.push(`${entry.name}: in the marketplace but not a pinned library package`);
	}
	return lines;
}

export function generateLibraryMarketplace(options: GenerateMarketplaceOptions = {}): GenerateMarketplaceResult {
	const root = options.root ? path.resolve(options.root) : path.resolve(import.meta.dirname, "..");
	const destination = path.join(root, ".claude-plugin", "marketplace.json");
	const { content, entries, excluded, errors } = renderLibraryMarketplace({ root });

	if (errors.length > 0) {
		return { ok: false, path: destination, content, drift: false, driftLines: [], errors, entries, excluded };
	}

	const current = existsSync(destination) ? readFileSync(destination, "utf8") : null;
	if (options.check) {
		const drift = current !== content;
		return {
			ok: !drift,
			path: destination,
			content,
			drift,
			driftLines: drift ? describeDrift(current ?? "", entries) : [],
			errors,
			entries,
			excluded,
		};
	}

	mkdirSync(path.dirname(destination), { recursive: true });
	writeFileSync(destination, content);
	return {
		ok: true,
		path: destination,
		content,
		drift: current !== content,
		driftLines: [],
		errors,
		entries,
		excluded,
	};
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(import.meta.filename)) {
	const check = process.argv.includes("--check");
	const result = generateLibraryMarketplace({ check });
	for (const error of result.errors) process.stderr.write(`generate-library-marketplace: ${error}\n`);
	for (const skip of result.excluded) {
		process.stdout.write(`not published to Claude Code: ${skip.name} (library/${skip.sourceUrl}) — ${skip.reason}\n`);
	}
	if (!result.ok) {
		if (check && result.drift) {
			process.stderr.write(".claude-plugin/marketplace.json does not match the pinned library packages\n");
			for (const line of result.driftLines) process.stderr.write(`  ${line}\n`);
			process.stderr.write("Run `pnpm run library:pin` and commit the result.\n");
		}
		process.exit(1);
	}
	process.stdout.write(
		`${check ? "Verified" : "Generated"} ${result.entries.length} Claude Code marketplace entries.\n`,
	);
}
