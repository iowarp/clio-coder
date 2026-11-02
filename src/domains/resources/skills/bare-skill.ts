import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { isSemanticVersion } from "../../extensions/compatibility.js";
import { isPluginId, PLUGIN_EXTENSION_KEY, PLUGIN_SCHEMA } from "../../plugins/index.js";
import { splitYamlFrontmatter, stringField } from "../common-loader.js";

/**
 * A bare skill is what the Agent Skills format publishes: a directory holding a
 * SKILL.md and whatever it bundles, with no package manifest. The library
 * installs packages, so a bare skill reaches it one of two ways, and this module
 * is what both share: `library import` projects a reviewed text-only copy, and
 * `library package` writes a manifest beside the skill for an ordinary install.
 */

/** Every name that makes a directory a package rather than a bare skill. */
const PACKAGE_MANIFESTS = [
	"plugin.json",
	"clio-coder-extension.yaml",
	"clio-coder-extension.yml",
	"clio-coder-extension.json",
	".claude-plugin/plugin.json",
	".codex-plugin/plugin.json",
];

const NESTED_SKILL_SEARCH_DEPTH = 3;
const NESTED_SKILL_LIMIT = 8;
/** Directories that hold build or VCS state, never a skill worth naming. */
const NESTED_SKILL_IGNORED = new Set([".git", "node_modules", "__pycache__", ".venv"]);

function isRegularFile(file: string): boolean {
	try {
		return lstatSync(file).isFile();
	} catch {
		return false;
	}
}

function exists(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

export function isBareSkillDirectory(dir: string): boolean {
	return isRegularFile(path.join(dir, "SKILL.md")) && !PACKAGE_MANIFESTS.some((name) => exists(path.join(dir, name)));
}

/**
 * Skill directories below a root that holds none itself, bounded so a repository
 * of skills gets a useful answer and a home directory does not get walked.
 */
export function nestedSkillDirectories(root: string): string[] {
	const found: string[] = [];
	const visit = (dir: string, depth: number): void => {
		if (depth > NESTED_SKILL_SEARCH_DEPTH || found.length >= NESTED_SKILL_LIMIT) return;
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (found.length >= NESTED_SKILL_LIMIT) return;
			if (NESTED_SKILL_IGNORED.has(name)) continue;
			const child = path.join(dir, name);
			try {
				if (!lstatSync(child).isDirectory()) continue;
			} catch {
				continue;
			}
			if (isRegularFile(path.join(child, "SKILL.md"))) found.push(path.relative(root, child).split(path.sep).join("/"));
			else visit(child, depth + 1);
		}
	};
	visit(root, 1);
	return found;
}

/** The operator's two routes, named wherever a bare skill is refused as a package. */
export function bareSkillRemedy(dir: string): string {
	return (
		`${dir} is a bare skill: it has a SKILL.md and no plugin.json. ` +
		`Review a text-only copy with \`clio-coder library import ${dir}\`, ` +
		`or keep its scripts by writing a manifest with \`clio-coder library package ${dir}\` and installing that.`
	);
}

function declaredVersion(frontmatter: Record<string, unknown>): string | undefined {
	const metadata = frontmatter.metadata;
	const nested =
		metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>).version
			: undefined;
	for (const raw of [frontmatter.version, nested]) {
		const value = typeof raw === "number" ? String(raw) : raw;
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

export interface BareSkillIdentity {
	id: string;
	version: string;
	description: string;
	license?: string;
	/** What the projection had to decide, for the operator's review. */
	notes: string[];
}

/**
 * The package identity a SKILL.md implies. A version the format leaves free-form
 * (`"1.0"`) gains the missing parts; anything else projects as 0.0.0 and says so,
 * because a package version has to be a Semantic Version.
 */
export function bareSkillIdentity(
	root: string,
	raw = readFileSync(path.join(root, "SKILL.md"), "utf8"),
): BareSkillIdentity {
	const split = splitYamlFrontmatter(raw);
	if (!split.ok) throw new Error(`SKILL.md frontmatter is invalid: ${split.reason}`);
	const description = stringField(split.frontmatter, "description");
	if (!description) throw new Error("SKILL.md requires a description");
	const id = stringField(split.frontmatter, "name") ?? path.basename(path.resolve(root));
	if (!isPluginId(id)) throw new Error(`skill name "${id}" is not a portable package identifier`);
	const notes: string[] = [];
	const declared = declaredVersion(split.frontmatter);
	let version = "0.0.0";
	const semantic: boolean = isSemanticVersion(declared);
	if (declared === undefined) notes.push("SKILL.md declares no version; packaged as 0.0.0.");
	else if (semantic) version = declared;
	else if (/^\d+(?:\.\d+)?$/u.test(declared)) {
		version = declared.includes(".") ? `${declared}.0` : `${declared}.0.0`;
		notes.push(`SKILL.md version ${declared} packaged as ${version}.`);
	} else notes.push(`SKILL.md version ${JSON.stringify(declared)} is not a Semantic Version; packaged as 0.0.0.`);
	const license = stringField(split.frontmatter, "license");
	return { id, version, description, ...(license ? { license } : {}), notes };
}

export interface PackagedBareSkill {
	identity: BareSkillIdentity;
	manifestPath: string;
	manifest: string;
	written: boolean;
}

/**
 * Write the manifest that turns a bare skill directory into an installable
 * package, and nothing else: the skill and everything it bundles stay as they
 * are, so its scripts survive where a text-only import would refuse them.
 */
export function packageBareSkill(dir: string, options: { force?: boolean; dryRun?: boolean } = {}): PackagedBareSkill {
	const root = path.resolve(dir);
	if (!isRegularFile(path.join(root, "SKILL.md"))) {
		const nested = nestedSkillDirectories(root);
		throw new Error(
			nested.length > 0
				? `${root} has no SKILL.md; package one skill directory at a time: ${nested.join(", ")}`
				: `${root} has no SKILL.md`,
		);
	}
	const manifestPath = path.join(root, "plugin.json");
	const vendor = PACKAGE_MANIFESTS.filter((name) => name !== "plugin.json").find((name) =>
		exists(path.join(root, name)),
	);
	if (vendor) throw new Error(`${root} already carries ${vendor}; it is a package, not a bare skill`);
	if (exists(manifestPath) && !options.force)
		throw new Error(`${manifestPath} already exists; use --force to replace it`);
	const identity = bareSkillIdentity(root);
	const manifest = bareSkillManifest(identity, ".", "SKILL.md");
	if (!options.dryRun) safeResourceWrite(manifestPath, manifest, { encoding: "utf8" });
	return { identity, manifestPath, manifest, written: !options.dryRun };
}

/** The portable manifest of one skill, with the skill at `componentPath` inside `skillsRoot`. */
export function bareSkillManifest(identity: BareSkillIdentity, skillsRoot: string, componentPath: string): string {
	return `${JSON.stringify(
		{
			$schema: PLUGIN_SCHEMA,
			name: identity.id,
			version: identity.version,
			description: identity.description,
			...(identity.license ? { license: identity.license } : {}),
			extensions: {
				[PLUGIN_EXTENSION_KEY]: {
					manifestVersion: 1,
					kind: "skill",
					resources: { skills: skillsRoot },
					components: [{ kind: "skill", id: identity.id, path: componentPath }],
				},
			},
		},
		null,
		"\t",
	)}\n`;
}
