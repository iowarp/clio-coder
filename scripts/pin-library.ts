import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import {
	isLibraryResourceKind,
	LIBRARY_PROVIDES_LIMITS,
	type LibraryProvidedResource,
} from "../src/domains/resources/library-types.js";
import { validateLibraryPackage } from "../src/domains/resources/library-validation.js";
import { generateLibraryMarketplace } from "./generate-library-marketplace.js";
import { pinSkillsCatalog } from "./pin-skills.js";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.join(root, "library", "registry.yaml");
const checkMode = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// 1. Validate curated packages and authoring templates
// ---------------------------------------------------------------------------
const KIND_DIRS = [
	{ dirName: "skills", expectedKind: "skill" },
	{ dirName: "agents", expectedKind: "agent" },
	{ dirName: "prompts", expectedKind: "prompt" },
	{ dirName: "fleets", expectedKind: "fleet" },
	{ dirName: "plugins", expectedKind: "plugin" },
] as const;

interface PackageTarget {
	directory: string;
	expectedKind: string;
}

const packages: PackageTarget[] = [];
function collect(directory: string, expectedKind: string): void {
	if (existsSync(path.join(directory, "plugin.json"))) {
		packages.push({ directory, expectedKind });
		return;
	}
	for (const item of readdirSync(directory, { withFileTypes: true })) {
		if (item.isDirectory() && !item.name.startsWith(".")) collect(path.join(directory, item.name), expectedKind);
	}
}

for (const { dirName, expectedKind } of KIND_DIRS) {
	const kindDir = path.join(root, "library", dirName);
	if (existsSync(kindDir)) collect(kindDir, expectedKind);
}

// Authoring templates to validate (explicitly excluded from catalog entries)
const templatesDir = path.join(root, "library", "_authoring", "templates");
const templateTargets: string[] = [];
if (existsSync(templatesDir)) {
	for (const item of readdirSync(templatesDir, { withFileTypes: true })) {
		if (item.isDirectory() && !item.name.startsWith(".")) {
			const templatePath = path.join(templatesDir, item.name);
			if (existsSync(path.join(templatePath, "plugin.json"))) {
				templateTargets.push(templatePath);
			}
		}
	}
}

const validationErrors: string[] = [];

// Validate all curated packages
const validatedPackages: {
	directory: string;
	expectedKind: string;
	result: ReturnType<typeof validateLibraryPackage>;
}[] = [];
for (const target of packages) {
	const result = validateLibraryPackage(target.directory);
	if (!result.valid) {
		const msgs = [
			...result.diagnostics.map((d) => d.message),
			...result.validation.diagnostics.map((d) => `[${d.code}] ${d.message}`),
		];
		validationErrors.push(`${path.relative(root, target.directory)}: ${msgs.join("; ")}`);
	} else {
		validatedPackages.push({ ...target, result });
	}
}

// Validate authoring templates
for (const templatePath of templateTargets) {
	const result = validateLibraryPackage(templatePath);
	if (!result.valid) {
		const msgs = [
			...result.diagnostics.map((d) => d.message),
			...result.validation.diagnostics.map((d) => `[${d.code}] ${d.message}`),
		];
		validationErrors.push(`${path.relative(root, templatePath)}: ${msgs.join("; ")}`);
	}
}

if (validationErrors.length > 0) {
	for (const err of validationErrors) process.stderr.write(`library validation error: ${err}\n`);
	process.stderr.write(
		`library:${checkMode ? "check" : "pin"}: ${validationErrors.length} package/template validation violation(s)\n`,
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Refresh/check normalized skill evidence
// ---------------------------------------------------------------------------
const skillResult = pinSkillsCatalog({ check: checkMode });
if (!skillResult.ok) {
	if (skillResult.errors.length > 0) {
		for (const err of skillResult.errors) process.stderr.write(`pin-skills: ${err}\n`);
	}
	if (checkMode) {
		if (skillResult.manifestDrift) {
			process.stderr.write(`pin-skills: ${skillResult.manifestPath} does not match the catalog content hashes\n`);
			for (const line of skillResult.manifestDriftLines) {
				process.stderr.write(`pin-skills:   ${line}\n`);
			}
		}
		if (skillResult.indexDrift) {
			process.stderr.write(`pin-skills: ${skillResult.indexPath} does not match the catalog\n`);
		}
		process.stderr.write("pin-skills: run `pnpm run skills:pin` or `pnpm run library:pin` and commit the result\n");
	}
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Compute and check/refresh full-tree package pins (library/registry.yaml)
// ---------------------------------------------------------------------------
const names = new Set<string>();
const entries = validatedPackages
	.map(({ directory, expectedKind, result }) => {
		if (!result.manifest) {
			throw new Error(`${directory}: missing manifest`);
		}
		const manifest = result.manifest;
		const actualKind = manifest.clio.kind ?? "plugin";
		if (actualKind !== expectedKind) {
			throw new Error(`${directory}: package kind "${actualKind}" does not match kind directory "${expectedKind}"`);
		}
		const skillFile = path.join(directory, "SKILL.md");
		const frontmatter = existsSync(skillFile)
			? /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillFile, "utf8"))?.[1]
			: undefined;
		const metadata = frontmatter ? (parse(frontmatter) as Record<string, unknown>) : {};
		const triggers = Array.isArray(metadata.triggers)
			? metadata.triggers.filter((item): item is string => typeof item === "string")
			: [];

		if (names.has(manifest.name)) throw new Error(`duplicate library package identity: ${manifest.name}`);
		names.add(manifest.name);
		// Hints are the validator's actual parsed runtime names, never component
		// ids or display titles. Ancillary scripts/resources stay manifest metadata.
		const provides: LibraryProvidedResource[] = result.validation.resources
			.flatMap((resource) =>
				isLibraryResourceKind(resource.kind) && resource.valid
					? [
							{
								kind: resource.kind,
								name: resource.name,
								...(resource.description
									? { description: resource.description.slice(0, LIBRARY_PROVIDES_LIMITS.description) }
									: {}),
							},
						]
					: [],
			)
			.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
			.slice(0, LIBRARY_PROVIDES_LIMITS.entries);
		return {
			kind: manifest.clio.kind ?? "plugin",
			name: manifest.name,
			description: manifest.description ?? "",
			...(manifest.clio.kind === "skill"
				? { category: path.basename(path.dirname(directory)), audit: "pass", ...(triggers.length ? { triggers } : {}) }
				: {}),
			version: manifest.version,
			sourceUrl: path.relative(path.dirname(destination), directory).split(path.sep).join("/"),
			sha256: result.contentDigest,
			...(manifest.clio.requires ? { requires: manifest.clio.requires } : {}),
			...(provides.length ? { provides } : {}),
		};
	})
	.sort((a, b) => a.name.localeCompare(b.name));

const content = `# Generated by pnpm library:pin. SHA-256 covers every package file.\n${stringify({ entries })}`;

if (checkMode) {
	if (!existsSync(destination) || readFileSync(destination, "utf8") !== content) {
		process.stderr.write("Library pins are stale; run pnpm library:pin.\n");
		process.exit(1);
	}
} else {
	mkdirSync(path.dirname(destination), { recursive: true });
	writeFileSync(destination, content);
}

// ---------------------------------------------------------------------------
// 4. Project the pinned packages into the Claude Code repository marketplace
// ---------------------------------------------------------------------------
// The outbound catalog is a projection of the pins above, so it can only be
// generated once registry.yaml is current. Checking it here keeps a stale
// marketplace out of the gate without a second command to remember.
//
// Only packages with a skill surface a host actually loads are published, and
// only when they carry nothing Claude Code would default-scan into a native
// component. A native-only package is a normal library contribution: it is
// reported here and left out of the marketplace, never published under a
// compatibility claim and never treated as a pinning failure.
const marketplace = generateLibraryMarketplace({ root, check: checkMode });
for (const skip of marketplace.excluded) {
	process.stdout.write(`not published to Claude Code: ${skip.name} (library/${skip.sourceUrl}) — ${skip.reason}\n`);
}
if (!marketplace.ok) {
	for (const error of marketplace.errors) process.stderr.write(`library marketplace error: ${error}\n`);
	if (checkMode && marketplace.drift) {
		process.stderr.write(".claude-plugin/marketplace.json does not match the pinned library packages\n");
		for (const line of marketplace.driftLines) process.stderr.write(`  ${line}\n`);
		process.stderr.write("Run `pnpm library:pin` and commit the result.\n");
	}
	process.exit(1);
}

if (checkMode) {
	process.stdout.write(
		`Verified ${templateTargets.length} authoring templates, ${skillResult.entries.length} normalized skills, ${entries.length} full-tree library package pins, and ${marketplace.entries.length} of ${entries.length} packages published as Claude Code marketplace entries.\n`,
	);
} else {
	process.stdout.write(
		`Validated ${templateTargets.length} templates, refreshed ${skillResult.entries.length} skills, pinned ${entries.length} library packages, and published ${marketplace.entries.length} of ${entries.length} as Claude Code marketplace entries.\n`,
	);
}
