#!/usr/bin/env node
/**
 * Release gate for the built dist/ and the npm package contents.
 *
 * Dist integrity: the two executable entries must exist and carry the
 * shebang, and no shared chunk may carry one (a shebang on a chunk means a
 * global banner leaked back into tsup.config.ts).
 *
 * Package audit via `npm pack --dry-run --json`: forbids files that must
 * never ship (caches, source maps, benchmarks), requires the runtime
 * resources the CLI resolves from the installed package root, and enforces
 * size budgets. Runs in `ci:release`, so a publish cannot ship an unaudited
 * tarball.
 *
 * Version coherence: the version in package.json must be the version the top
 * of CHANGELOG.md describes. `prepublishOnly` runs this gate, so without the
 * check a publish could ship with the release notes still sitting under an
 * `## Unreleased` heading, which is what the tree looked like when this was
 * added.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { releaseVersionErrors } from "./release-version-policy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHEBANG = "#!/usr/bin/env node";
const ENTRIES = ["dist/cli/index.js", "dist/worker/entry.js"];

// Size budgets serve as a tripwire against packaging defects such as leaked
// node_modules or doubled dist, rather than policing documentation size or
// enforcing an artificial package diet. Pack composition changed deliberately
// in #66: about 19MB of vendored tree-sitter grammars (dist/assets/grammars/),
// Clio's own source (src/**), and her code map (dist/assets/codewiki.json)
// ride inside the tarball so the install needs neither grammar collection.
// Raised for 0.3.6 by operator decision: the unpacked ceiling moves to 50MB to
// carry this release's added source, and the tarball ceiling tightens to 10MB
// because the measured artifact sits near 6MB and a jump past 10MB would mean
// a packaging defect rather than growth.
const MAX_TARBALL_BYTES = 10_000_000;
const MAX_UNPACKED_BYTES = 50_000_000;

const FORBIDDEN = [
	{
		test: (f) => f.includes("__pycache__") || f.endsWith(".pyc"),
		reason: "python bytecode cache",
	},
	{
		test: (f) => f.endsWith(".map"),
		reason: "source map (excluded by release policy)",
	},
	{
		test: (f) => f.startsWith("benchmarks/"),
		reason: "benchmarks are not part of the package",
	},
	{
		test: (f) => f.startsWith("scripts/"),
		reason: "repo scripts operate on a source checkout only",
	},
	{ test: (f) => f.endsWith(".tsbuildinfo"), reason: "typescript build cache" },
	{ test: (f) => /(^|\/)\.env(\.|$)/.test(f), reason: "environment file" },
	{ test: (f) => f.includes("node_modules/"), reason: "vendored node_modules" },
];

// Exact files the CLI resolves from the installed package root at runtime, and
// the resource trees it loads by directory scan. Shared with the packaging
// contract test, which holds this list against the package.json `files`
// allowlist so the gate cannot outlive what the allowlist actually ships.
const manifest = JSON.parse(readFileSync(join(root, "scripts", "release-manifest.json"), "utf8"));
const REQUIRED_FILES = manifest.requiredFiles;
const REQUIRED_PREFIXES = manifest.requiredPrefixes;

const errors = [];

function firstLine(abs) {
	try {
		return readFileSync(abs, "utf8").slice(0, SHEBANG.length);
	} catch {
		return null;
	}
}

for (const rel of ENTRIES) {
	const head = firstLine(join(root, rel));
	if (head === null) errors.push(`missing ${rel}`);
	else if (head !== SHEBANG) errors.push(`bad shebang in ${rel}`);
}

checkVersionCoherence();

/**
 * The published version and the release notes for it must name the same number.
 *
 * `prepublishOnly` runs this gate, and until now nothing in it read
 * package.json's version at all: the tree could be published with every note
 * for the release still under `## Unreleased`, or with the version bumped and
 * the changelog never touched. Both are silent at publish time and permanent
 * afterwards, because a published version cannot be replaced.
 *
 * Development branches may keep `## Unreleased`. An explicit publish context,
 * a hosted tag build, or an exact local version tag is immutable and requires
 * `## <version> - YYYY-MM-DD`.
 */
function checkVersionCoherence() {
	let version;
	try {
		version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	} catch (error) {
		errors.push(`unable to read package.json version: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	let changelog;
	try {
		changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	} catch (error) {
		errors.push(`unable to read CHANGELOG.md: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	const explicitRelease = process.env.CLIO_CODER_RELEASE_CONTEXT === "publish";
	const hostedTag = process.env.GITHUB_REF?.startsWith("refs/tags/") ?? false;
	let exactVersionTag = false;
	if (typeof version === "string" && version.length > 0) {
		try {
			const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			exactVersionTag = tags.split(/\r?\n/).includes(`v${version}`);
		} catch {
			// A packed source tree may have no Git metadata. npm publish supplies
			// the explicit release context, so absence of Git never weakens it.
		}
	}
	errors.push(
		...releaseVersionErrors({
			version,
			changelog,
			releaseContext: explicitRelease || hostedTag || exactVersionTag,
		}),
	);
}

const entrySet = new Set(ENTRIES);
for (const dirent of readdirSync(join(root, "dist"), {
	recursive: true,
	withFileTypes: true,
})) {
	if (!dirent.isFile() || !dirent.name.endsWith(".js")) continue;
	const abs = join(dirent.parentPath, dirent.name);
	const rel = abs.slice(root.length).replaceAll("\\", "/");
	if (entrySet.has(rel)) continue;
	if (firstLine(abs) === SHEBANG) {
		errors.push(`unexpected shebang on non-entry chunk: ${rel}`);
	}
}

let report;
try {
	const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
	});
	report = JSON.parse(raw)[0];
} catch (err) {
	process.stderr.write(
		`check-release: npm pack --dry-run failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
}

const files = report.files.map((f) => f.path);
const fileSet = new Set(files);

for (const file of files) {
	for (const rule of FORBIDDEN) {
		if (rule.test(file)) {
			errors.push(`forbidden file in package: ${file} (${rule.reason})`);
		}
	}
}

for (const required of REQUIRED_FILES) {
	if (!fileSet.has(required)) errors.push(`missing required file: ${required}`);
}

for (const prefix of REQUIRED_PREFIXES) {
	if (!files.some((f) => f.startsWith(prefix))) {
		errors.push(`no files under required tree: ${prefix}`);
	}
}

const requiredRecipeKeys = new Set([
	"version",
	"name",
	"description",
	"tools",
	"skills",
	"audience",
	"category",
	"capabilityClass",
	"latencyClass",
	"projectContextTier",
	"budget",
	"resultContract",
	"tags",
]);
const optionalRecipeKeys = new Set(["product"]);
const allowedRecipeKeys = new Set([...requiredRecipeKeys, ...optionalRecipeKeys]);
// Builtin recipes ship from their one canonical location, src/domains/agents/
// builtins/, which is what src/domains/agents/extension.ts reads at runtime.
// Every recipe must be in the pack and carry the strict v1 frontmatter schema.
const recipeDir = join(root, "src", "domains", "agents", "builtins");
for (const name of readdirSync(recipeDir)
	.filter((entry) => entry.endsWith(".md"))
	.sort()) {
	const packagePath = `src/domains/agents/builtins/${name}`;
	if (!fileSet.has(packagePath)) {
		errors.push(`missing builtin recipe in package: ${packagePath}`);
		continue;
	}
	try {
		const raw = readFileSync(join(recipeDir, name), "utf8");
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		const frontmatter = match ? parseYaml(match[1]) : null;
		if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
			errors.push(`invalid builtin recipe frontmatter: ${packagePath}`);
			continue;
		}
		const keys = Object.keys(frontmatter);
		if (
			frontmatter.version !== 1 ||
			keys.some((key) => !allowedRecipeKeys.has(key)) ||
			[...requiredRecipeKeys].some((key) => !keys.includes(key))
		) {
			errors.push(`builtin recipe is not the strict v1 schema: ${packagePath}`);
		}
	} catch (error) {
		errors.push(
			`unable to inspect builtin recipe ${packagePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Advisories against packages that reach the published tarball.
 *
 * `npm audit` is not run by any other gate: `.github/workflows/ci.yml` installs
 * with `--no-audit`, and this script previously audited package *contents*
 * without ever asking whether those contents were vulnerable. Five advisories
 * shipped to users for months that way, all of them production dependencies
 * arriving through the agent SDK's MCP chain, and all five were assumed to be
 * development-surface until someone checked (#199).
 *
 * `--omit=dev` is the whole point: a development dependency's advisory is a
 * maintenance question, and one in a shipped dependency is something users
 * installed. High and critical fail the release; moderate and low are printed
 * so a maintainer sees them without a release being blocked by, say, a JSX
 * advisory in an HTTP framework this runtime never renders with.
 *
 * There is no environment-variable escape. Shipping a known high in the
 * published tarball should take an explicit, reviewable edit: bump it, override
 * it, or add it here with the reason.
 */
function checkShippedAdvisories() {
	let raw;
	try {
		raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		// npm audit exits non-zero when it finds anything, and still prints the
		// report on stdout. A genuinely failed run leaves stdout empty.
		raw = typeof error?.stdout === "string" ? error.stdout : "";
		if (raw.trim().length === 0) {
			errors.push(
				`unable to run npm audit: ${error instanceof Error ? error.message : String(error)}. The release gate does not pass on an unknown advisory state.`,
			);
			return;
		}
	}
	let report;
	try {
		report = JSON.parse(raw);
	} catch {
		errors.push("npm audit did not return JSON; the release gate does not pass on an unknown advisory state");
		return;
	}
	const found = Object.entries(report.vulnerabilities ?? {});
	const blocking = found.filter(([, v]) => v.severity === "high" || v.severity === "critical");
	const noted = found.filter(([, v]) => v.severity === "moderate" || v.severity === "low");
	for (const [name, v] of noted) {
		process.stdout.write(`check-release: note: ${v.severity} advisory in shipped dependency ${name} (${v.range})\n`);
	}
	for (const [name, v] of blocking) {
		const fix =
			v.fixAvailable === true
				? "npm audit fix"
				: v.fixAvailable
					? `upgrade to ${v.fixAvailable.name}@${v.fixAvailable.version}`
					: "no fix available";
		errors.push(`${v.severity} advisory in shipped dependency ${name} (${v.range}); ${fix}`);
	}
}

checkShippedAdvisories();

if (report.size > MAX_TARBALL_BYTES) {
	errors.push(`tarball ${report.size} bytes exceeds budget ${MAX_TARBALL_BYTES}`);
}
if (report.unpackedSize > MAX_UNPACKED_BYTES) {
	errors.push(`unpacked ${report.unpackedSize} bytes exceeds budget ${MAX_UNPACKED_BYTES}`);
}

if (errors.length > 0) {
	for (const error of errors) process.stderr.write(`check-release: ${error}\n`);
	process.exit(1);
}

process.stdout.write(
	`check-release: ok (${report.entryCount} files, tarball ${(report.size / 1e6).toFixed(
		2,
	)} MB, unpacked ${(report.unpackedSize / 1e6).toFixed(2)} MB)\n`,
);
process.exit(0);
