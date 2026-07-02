#!/usr/bin/env node
/**
 * Audits the npm package contents via `npm pack --dry-run --json`.
 *
 * Fails on files that must never ship (caches, source maps, benchmarks),
 * missing runtime resources (dist entries, prompt fragments, builtin agents,
 * model catalogs, bundled docs), and size regressions. Runs in `ci:release`
 * so a publish cannot ship an unaudited tarball.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Tarball is ~0.93 MB and unpacked ~3.9 MB today; budgets leave headroom for
// organic growth but catch accidental payloads (maps alone were 5.3 MB).
const MAX_TARBALL_BYTES = 2_000_000;
const MAX_UNPACKED_BYTES = 6_000_000;

const FORBIDDEN = [
	{ test: (f) => f.includes("__pycache__") || f.endsWith(".pyc"), reason: "python bytecode cache" },
	{ test: (f) => f.endsWith(".map"), reason: "source map (excluded by release policy)" },
	{ test: (f) => f.startsWith("benchmarks/"), reason: "benchmarks are not part of the package" },
	{ test: (f) => f.endsWith(".tsbuildinfo"), reason: "typescript build cache" },
	{ test: (f) => /(^|\/)\.env(\.|$)/.test(f), reason: "environment file" },
	{ test: (f) => f.includes("node_modules/"), reason: "vendored node_modules" },
];

// Exact files the CLI resolves from the installed package root at runtime.
const REQUIRED_FILES = [
	"dist/cli/index.js",
	"dist/worker/entry.js",
	"src/domains/prompts/fragments/identity/clio.md",
	"assets/clio-coder-logo-128.webp",
	"docs/html/index.html",
	"damage-control-rules.yaml",
	"CLIO.md",
	"README.md",
	"LICENSE",
	"NOTICE",
	"CHANGELOG.md",
];

// Resource trees loaded by directory scan; require at least one entry each so
// a `files` allowlist edit cannot silently drop a whole tree.
const REQUIRED_PREFIXES = [
	"src/domains/prompts/fragments/",
	"src/domains/agents/builtins/",
	"src/domains/providers/models/",
	"docs/html/",
];

const errors = [];

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
	process.stderr.write(`check-pack: npm pack --dry-run failed: ${err instanceof Error ? err.message : String(err)}\n`);
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

if (report.size > MAX_TARBALL_BYTES) {
	errors.push(`tarball ${report.size} bytes exceeds budget ${MAX_TARBALL_BYTES}`);
}
if (report.unpackedSize > MAX_UNPACKED_BYTES) {
	errors.push(`unpacked ${report.unpackedSize} bytes exceeds budget ${MAX_UNPACKED_BYTES}`);
}

if (errors.length > 0) {
	for (const error of errors) process.stderr.write(`check-pack: ${error}\n`);
	process.exit(1);
}

process.stdout.write(
	`check-pack: ok (${report.entryCount} files, tarball ${(report.size / 1e6).toFixed(2)} MB, unpacked ${(report.unpackedSize / 1e6).toFixed(2)} MB)\n`,
);
process.exit(0);
