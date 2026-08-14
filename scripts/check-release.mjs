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
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHEBANG = "#!/usr/bin/env node";
const ENTRIES = ["dist/cli/index.js", "dist/worker/entry.js"];

// Budgets catch an accidental payload, not intended content. Source maps alone
// were 5.3 MB once, which is the shape these numbers exist to stop.
//
// Measured at 0.3.0: tarball 1.41 MB, unpacked 5.84 MB across 194 entries.
// Unminified dist/ is 4.25 MB of that (73%); docs/html is 906 KB (16%), which
// compresses to ~192 KB in the tarball. The rest is the markdown corpus, the
// model catalogs, and the prompt fragments.
//
// docs/html was briefly dropped from the package to buy headroom, which broke
// `clio-coder docs` in every installed copy: src/cli/docs.ts serves that directory
// from resolvePackageRoot(). Shrinking it instead was measured and rejected.
// Roughly 250 KB is duplicated inline <style> boilerplate across twenty
// hand-authored pages and 17% is source indentation, but 16 pages carry <pre>
// blocks and 28 carry template literals in inline script, so whitespace-level
// minification needs a real HTML parser, and no test covers how these pages
// render. That is a large untested diff against a tripwire. The budget moves to
// 7 MB instead, leaving 1.16 MB of headroom over the measured figure.
const MAX_TARBALL_BYTES = 2_000_000;
const MAX_UNPACKED_BYTES = 7_000_000;

const FORBIDDEN = [
	{ test: (f) => f.includes("__pycache__") || f.endsWith(".pyc"), reason: "python bytecode cache" },
	{ test: (f) => f.endsWith(".map"), reason: "source map (excluded by release policy)" },
	{ test: (f) => f.startsWith("benchmarks/"), reason: "benchmarks are not part of the package" },
	{ test: (f) => f.startsWith("scripts/"), reason: "repo scripts operate on a source checkout only" },
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

const entrySet = new Set(ENTRIES);
for (const dirent of readdirSync(join(root, "dist"), { recursive: true, withFileTypes: true })) {
	if (!dirent.isFile() || !dirent.name.endsWith(".js")) continue;
	const abs = join(dirent.parentPath, dirent.name);
	const rel = abs.slice(root.length).replaceAll("\\", "/");
	if (entrySet.has(rel)) continue;
	if (firstLine(abs) === SHEBANG) errors.push(`unexpected shebang on non-entry chunk: ${rel}`);
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
		if (rule.test(file)) errors.push(`forbidden file in package: ${file} (${rule.reason})`);
	}
}

for (const required of REQUIRED_FILES) {
	if (!fileSet.has(required)) errors.push(`missing required file: ${required}`);
}

for (const prefix of REQUIRED_PREFIXES) {
	if (!files.some((f) => f.startsWith(prefix))) errors.push(`no files under required tree: ${prefix}`);
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
const sourceRecipeDir = join(root, "src", "domains", "agents", "builtins");
const distRecipeDir = join(root, "dist", "domains", "agents", "builtins");
for (const name of readdirSync(sourceRecipeDir)
	.filter((entry) => entry.endsWith(".md"))
	.sort()) {
	const distPath = join(distRecipeDir, name);
	const packagePath = `dist/domains/agents/builtins/${name}`;
	if (!fileSet.has(packagePath)) {
		errors.push(`missing built recipe in dist/package: ${packagePath}`);
		continue;
	}
	try {
		const raw = readFileSync(distPath, "utf8");
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		const frontmatter = match ? parseYaml(match[1]) : null;
		if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
			errors.push(`invalid built recipe frontmatter: ${packagePath}`);
			continue;
		}
		const keys = Object.keys(frontmatter);
		if (
			frontmatter.version !== 1 ||
			keys.some((key) => !allowedRecipeKeys.has(key)) ||
			[...requiredRecipeKeys].some((key) => !keys.includes(key))
		) {
			errors.push(`built recipe is not the strict v1 schema: ${packagePath}`);
		}
	} catch (error) {
		errors.push(
			`unable to inspect built recipe ${packagePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

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
	`check-release: ok (${report.entryCount} files, tarball ${(report.size / 1e6).toFixed(2)} MB, unpacked ${(report.unpackedSize / 1e6).toFixed(2)} MB)\n`,
);
process.exit(0);
