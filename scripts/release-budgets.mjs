/**
 * Package size budgets, shared by the release gate (scripts/check-release.mjs, which reads the
 * packed tarball) and the preflight (scripts/preflight.mjs, which reads the source tree before
 * anything is built), so a class that outgrew its ceiling is reported in seconds.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("release-manifest.json", import.meta.url)), "utf8"));
export const SHIPPED_SCRIPTS = new Set(manifest.requiredFiles.filter((file) => file.startsWith("scripts/")));

// Size budgets are tripwires against packaging defects such as leaked
// node_modules or doubled dist. Per-class ceilings follow the package measured
// at fbd590900, so spare capacity in one payload cannot hide growth in another.
// Grammars stay local for offline use, and src/** supports Clio reading its own
// code (#66). The total unpacked ceiling is derived from the class ceilings.
// At release, re-pin each class ceiling to its last qualified release size rounded
// up to the next 0.5 MB plus that class's cycle allowance. A re-pin needs the
// maintainer's explicit approval in the release session; a gate the release
// session raises on its own gates nothing (#442).
export const CODEMAP = "dist/assets/codemap.json.gz";
export const SOURCE_PACK = "dist/assets/source.pack";
export const SIZE_BUDGETS = [
	{
		class: "grammars",
		match: (path) => path.startsWith("dist/assets/grammars/"),
		// The 0.7.0 candidate measured 11,870,828 bytes: 12.0 MB rounded up plus a 0.5 MB cycle allowance (#442).
		maxBytes: 12_500_000,
	},
	{
		class: "codemap",
		match: (path) => path === CODEMAP,
		// The 0.7.0 candidate measured 944,220 bytes after the code map was gzipped: 1.0 MB rounded up plus a 0.5 MB cycle allowance (#442).
		maxBytes: 1_500_000,
	},
	{
		class: "dist bundles",
		match: (path) =>
			path.startsWith("dist/") &&
			!path.startsWith("dist/assets/grammars/") &&
			path !== CODEMAP &&
			path !== SOURCE_PACK &&
			!path.startsWith("dist/gui/client/"),
		// The 0.8.0 candidate measured 16,048,038 bytes: 16.5 MB rounded up plus a 0.5 MB cycle allowance (#442).
		maxBytes: 17_000_000,
	},
	{
		class: "gui client",
		match: (path) => path.startsWith("dist/gui/client/"),
		// The 0.7.0 candidate measured 6,302,826 bytes: 6.5 MB rounded up plus a 0.5 MB cycle allowance (#442).
		maxBytes: 7_000_000,
	},
	{
		class: "src",
		// The packed TypeScript source is still src/, stored in one file (scripts/build-source-pack.ts).
		match: (path) => path.startsWith("src/") || path === SOURCE_PACK,
		// The 0.8.0 candidate measured 6,818,380 bytes in the source pack: 7.0 MB rounded up plus a 0.5 MB cycle allowance (#442).
		maxBytes: 7_500_000,
	},
	{
		class: "docs",
		match: (path) => path.startsWith("docs/"),
		// The 0.7.0 candidate measured 2,557,799 bytes; the 0.8.4 candidate measured 3,042,862 after its docs accuracy
		// pass, so it takes the 3.5 MB the rule gives (maintainer decision, 2026-11-19).
		maxBytes: 3_500_000,
	},
	{
		class: "library+examples+models+root files",
		match: (path) =>
			!path.includes("/") ||
			["library/", "examples/", "models/"].some((prefix) => path.startsWith(prefix)) ||
			[".claude-plugin/marketplace.json", "bin/clio-coder.cjs", "assets/clio-mark-gui.webp"].includes(path) ||
			path.startsWith("assets/windows-launcher/") ||
			path.startsWith("assets/core-host/") ||
			SHIPPED_SCRIPTS.has(path),
		// The 0.8.0 candidate measured 2,015,520 bytes with the core host script: 2.5 MB rounded up, with no cycle
		// allowance, as this class was held tight at 0.7.0 (#442).
		maxBytes: 2_500_000,
	},
];
// Maintainer decision: 18.5 MB (2026-11-19); the 0.8.0 candidate measured 17,115,838 packed bytes (18.0 MB then, #442) and
// the 0.8.4 candidate 18,014,690.
export const MAX_TARBALL_BYTES = 18_500_000;
export const MAX_UNPACKED_BYTES = SIZE_BUDGETS.reduce((total, budget) => total + budget.maxBytes, 0);
export const MAX_ENTRY_COUNT = 3_000;

/** A class this close to its ceiling is named before it fails: the 0.8.4 docs class crossed 3.0 MB unannounced. */
export const BUDGET_WARN_RATIO = 0.97;

/**
 * Sums `files` (`{ path, size }` from an npm pack report) per payload class. `only` limits the
 * verdict to some classes, for a caller that cannot see built files yet.
 */
export function classifySizes(files, { only } = {}) {
	const totals = SIZE_BUDGETS.map((budget) => ({ ...budget, bytes: 0 }));
	const errors = [];
	const warnings = [];
	for (const file of files) {
		const matching = totals.filter((budget) => budget.match(file.path));
		if (matching.length === 0) errors.push(`unclassified file in package: ${file.path}`);
		else if (matching.length > 1) errors.push(`file matches multiple payload classes: ${file.path}`);
		else matching[0].bytes += file.size;
	}
	for (const budget of totals) {
		if (only && !only.includes(budget.class)) continue;
		if (budget.bytes > budget.maxBytes)
			errors.push(`payload class ${budget.class} ${budget.bytes} bytes exceeds budget ${budget.maxBytes}`);
		else if (budget.bytes > budget.maxBytes * BUDGET_WARN_RATIO)
			warnings.push(
				`payload class ${budget.class} is at ${budget.bytes} of ${budget.maxBytes} bytes (${budget.maxBytes - budget.bytes} left)`,
			);
	}
	return { totals, errors, warnings };
}
