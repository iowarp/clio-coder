import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { validateLibraryPackage } from "../src/domains/resources/library-validation.js";
import { generateLibraryMarketplace } from "./generate-library-marketplace.js";
import {
	buildRegistryRow,
	type RegistryRow,
	readBlessedRemoteRows,
	refreshBlessedRemoteRow,
} from "./pin-library-remote.js";
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
const localEntries: RegistryRow[] = validatedPackages.map(({ directory, expectedKind, result }) => {
	if (!result.manifest) {
		throw new Error(`${directory}: missing manifest`);
	}
	const actualKind = result.manifest.clio.kind ?? "plugin";
	if (actualKind !== expectedKind) {
		throw new Error(`${directory}: package kind "${actualKind}" does not match kind directory "${expectedKind}"`);
	}
	if (names.has(result.manifest.name)) throw new Error(`duplicate library package identity: ${result.manifest.name}`);
	names.add(result.manifest.name);
	const sourceUrl = path.relative(path.dirname(destination), directory).split(path.sep).join("/");
	return buildRegistryRow(directory, result, sourceUrl, path.basename(path.dirname(directory)));
});

// ---------------------------------------------------------------------------
// 3b. Refresh blessed remote packages (GitHub-hosted rows already pinned in
// the committed registry.yaml). Their content is never scanned from a local
// directory, so they are read back from the previous pin, always re-fetched
// to verify the digest, and only left unchanged when the fetch itself fails.
// ---------------------------------------------------------------------------
const previousRemoteRows = readBlessedRemoteRows(destination);

let retainedRemotePins = 0;
const remoteEntries: RegistryRow[] = previousRemoteRows.map((row) => {
	// A collision with a local package name is always an error: it does not
	// depend on whether the remote fetch itself succeeds.
	if (names.has(row.name)) throw new Error(`duplicate library package identity: ${row.name}`);
	const { row: refreshedRow, refreshed, warning } = refreshBlessedRemoteRow(row);
	if (!refreshed) retainedRemotePins++;
	if (warning) process.stderr.write(`library:pin warning: ${warning}\n`);
	names.add(refreshedRow.name);
	return refreshedRow;
});

const entries: RegistryRow[] = [...localEntries, ...remoteEntries].sort((a, b) => a.name.localeCompare(b.name));

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
	process.stdout.write(
		`not published to Claude Code: ${skip.name} (${/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(skip.sourceUrl) ? skip.sourceUrl : `library/${skip.sourceUrl}`}) — ${skip.reason}\n`,
	);
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
		`Verified ${templateTargets.length} authoring templates, ${skillResult.entries.length} normalized skills, ${entries.length - retainedRemotePins} full-tree library package pins (${retainedRemotePins} remote pins retained without verification), and ${marketplace.entries.length} of ${entries.length} packages published as Claude Code marketplace entries.\n`,
	);
} else {
	process.stdout.write(
		`Validated ${templateTargets.length} templates, refreshed ${skillResult.entries.length} skills, pinned ${entries.length} library packages, and published ${marketplace.entries.length} of ${entries.length} as Claude Code marketplace entries.\n`,
	);
}
