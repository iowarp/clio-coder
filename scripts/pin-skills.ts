/**
 * Regenerate skills/registry.yaml: the local pinned manifest of marketplace
 * skill content hashes (provenance-stripped, so installed copies stamped with
 * install-lifecycle frontmatter still compare equal to their audited source).
 * Run with `npm run skills:pin` after editing any skills/<name>/SKILL.md.
 *
 * Modes:
 *   default          rewrite the manifest from the catalog
 *   --check          verify the manifest matches the catalog; exit 1 on drift
 *   --dir <path>     operate on a different catalog directory (tests)
 *
 * Malformed frontmatter is a hard failure in both modes: a skill file whose
 * YAML cannot be parsed must never be silently pinned under its folder name.
 * The catalog publishing contract (skills/README.md) is enforced here too:
 * every catalog skill must carry the required provenance frontmatter with
 * `audit: pass` and ship an evals.md beside its SKILL.md.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { normalizedSkillHash } from "../src/domains/resources/skills/content-hash.js";

/** Top-level frontmatter every published catalog skill must carry (skills/README.md). */
const REQUIRED_CORE_KEYS = ["name", "description", "version", "license"] as const;
/** Keys required inside the reserved nested `clio:` block (skills/README.md). */
const REQUIRED_CLIO_KEYS = ["registry-id", "source-url", "provenance", "eval-status"] as const;

const argv = process.argv.slice(2);
const checkMode = argv.includes("--check");
const dirFlagIndex = argv.indexOf("--dir");
const repoRoot = path.resolve(import.meta.dirname, "..");
const catalogDir =
	dirFlagIndex >= 0 && argv[dirFlagIndex + 1]
		? path.resolve(argv[dirFlagIndex + 1] as string)
		: path.join(repoRoot, "skills");
const manifestPath = path.join(catalogDir, "registry.yaml");

interface PinEntry {
	name: string;
	/** Catalog-relative package path, e.g. "git/create-pr" (or just the folder name in a flat catalog). */
	path: string;
	version: string | null;
	sha256: string;
}

/**
 * Skill package directories, recursively: a directory carrying its own
 * SKILL.md is a package (its subfolders such as references/ belong to it); a
 * directory without one is a category folder to descend into. Flat catalogs
 * are the depth-1 case of the same rule.
 */
function collectPackageDirs(dir: string, rel: string): string[] {
	const found: string[] = [];
	for (const dirent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!dirent.isDirectory() || dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
		const childRel = rel.length > 0 ? `${rel}/${dirent.name}` : dirent.name;
		const child = path.join(dir, dirent.name);
		if (existsSync(path.join(child, "SKILL.md"))) found.push(childRel);
		else found.push(...collectPackageDirs(child, childRel));
	}
	return found;
}

function collectEntries(): { entries: PinEntry[]; errors: string[] } {
	const entries: PinEntry[] = [];
	const errors: string[] = [];
	for (const relPath of collectPackageDirs(catalogDir, "")) {
		const skillPath = path.join(catalogDir, relPath, "SKILL.md");
		const raw = readFileSync(skillPath, "utf8");
		const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		if (!fmMatch?.[1]) {
			errors.push(`${skillPath}: missing YAML frontmatter`);
			continue;
		}
		let fm: Record<string, unknown> | null;
		try {
			const parsed = yaml.parse(fmMatch[1]) as unknown;
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				errors.push(`${skillPath}: frontmatter must be a YAML object`);
				continue;
			}
			fm = parsed as Record<string, unknown>;
		} catch (err) {
			errors.push(`${skillPath}: invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		let name = path.basename(relPath);
		let version: string | null = null;
		if (typeof fm.name === "string" && fm.name.trim().length > 0) name = fm.name.trim();
		const fmVersion = fm.version ?? (fm.metadata as Record<string, unknown> | undefined)?.version;
		if (typeof fmVersion === "string" && fmVersion.trim().length > 0) version = fmVersion.trim();
		for (const key of REQUIRED_CORE_KEYS) {
			const value = fm[key];
			if (typeof value !== "string" || value.trim().length === 0) {
				errors.push(`${skillPath}: missing required catalog frontmatter "${key}"`);
			}
		}
		const clio =
			fm.clio !== null && typeof fm.clio === "object" && !Array.isArray(fm.clio)
				? (fm.clio as Record<string, unknown>)
				: null;
		if (!clio) {
			errors.push(`${skillPath}: missing the required nested "clio:" frontmatter block`);
		} else {
			for (const key of REQUIRED_CLIO_KEYS) {
				const value = clio[key];
				if (typeof value !== "string" || value.trim().length === 0) {
					errors.push(`${skillPath}: missing required catalog frontmatter "clio.${key}"`);
				}
			}
			if (clio.audit !== "pass") {
				errors.push(
					`${skillPath}: catalog skills must carry "audit: pass" under clio: (found ${JSON.stringify(clio.audit ?? null)})`,
				);
			}
		}
		if (!existsSync(path.join(catalogDir, relPath, "evals.md"))) {
			errors.push(`${skillPath}: catalog skills must ship an evals.md beside SKILL.md`);
		}
		entries.push({ name, path: relPath, version, sha256: normalizedSkillHash(raw) });
	}
	return { entries, errors };
}

/**
 * Render the manifest grouped by catalog category (the directory a package
 * lives under), with a comment heading per group so the file reads as the
 * catalog's table of contents. Still one YAML document with a single
 * `skills:` list; comments are invisible to the parser.
 */
function renderManifest(entries: ReadonlyArray<PinEntry>): string {
	const sorted = [...entries].sort((a, b) => {
		const categoryOrder = path.dirname(a.path).localeCompare(path.dirname(b.path));
		return categoryOrder !== 0 ? categoryOrder : a.name.localeCompare(b.name);
	});
	const lines: string[] = ["skills:"];
	let currentCategory: string | null = null;
	for (const entry of sorted) {
		const category = path.dirname(entry.path);
		if (category !== currentCategory) {
			currentCategory = category;
			lines.push(`  # ── ${category === "." ? "(catalog root)" : category} ──`);
		}
		const rendered = yaml.stringify([entry]).trimEnd();
		lines.push(...rendered.split("\n").map((line) => `  ${line}`));
	}
	return [
		"# Pinned marketplace skill content hashes (provenance-stripped sha256).",
		"# Generated by `npm run skills:pin`. At activation, an installed skill",
		"# carrying registry-id provenance is compared against its pinned hash;",
		"# a mismatch surfaces a drift warning.",
		`${lines.join("\n")}\n`,
	].join("\n");
}

/** Human drift summary: which pins are missing, stale, or orphaned. */
function describeDrift(current: string, expected: ReadonlyArray<PinEntry>): string[] {
	const lines: string[] = [];
	let pinned: PinEntry[] = [];
	try {
		const parsed = yaml.parse(current) as { skills?: PinEntry[] } | null;
		pinned = Array.isArray(parsed?.skills) ? parsed.skills : [];
	} catch {
		return ["registry.yaml is not parseable YAML"];
	}
	const pinnedByName = new Map(pinned.map((entry) => [entry.name, entry]));
	const expectedByName = new Map(expected.map((entry) => [entry.name, entry]));
	for (const entry of expected) {
		const pin = pinnedByName.get(entry.name);
		if (!pin) lines.push(`${entry.name}: in catalog but not pinned`);
		else if (pin.sha256 !== entry.sha256 || pin.version !== entry.version) lines.push(`${entry.name}: pin is stale`);
	}
	for (const pin of pinned) {
		if (!expectedByName.has(pin.name)) lines.push(`${pin.name}: pinned but not in catalog`);
	}
	return lines;
}

const { entries, errors } = collectEntries();
if (errors.length > 0) {
	for (const error of errors) process.stderr.write(`pin-skills: ${error}\n`);
	process.stderr.write(
		`pin-skills: ${errors.length} catalog contract violation(s); nothing was ${checkMode ? "checked" : "pinned"}\n`,
	);
	process.exit(1);
}

const manifest = renderManifest(entries);

if (checkMode) {
	let current: string | null = null;
	try {
		current = readFileSync(manifestPath, "utf8");
	} catch {
		current = null;
	}
	if (current === manifest) {
		process.stdout.write(`registry pin check ok (${entries.length} skills)\n`);
		process.exit(0);
	}
	process.stderr.write(`pin-skills: ${manifestPath} does not match the catalog content hashes\n`);
	for (const line of describeDrift(current ?? "", entries)) process.stderr.write(`pin-skills:   ${line}\n`);
	process.stderr.write("pin-skills: run `npm run skills:pin` and commit the result\n");
	process.exit(1);
}

writeFileSync(manifestPath, manifest, "utf8");
process.stdout.write(`pinned ${entries.length} skills -> ${manifestPath}\n`);
