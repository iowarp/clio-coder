/**
 * `docs/environment-variables.md` opens by claiming it lists every environment
 * variable the shipped `src/` tree reads. That claim is the kind that rots the
 * moment someone adds a knob, and it had: three variables were missing when it
 * was last checked by hand, one of which writes conversation text to disk.
 *
 * The doc is the operator's only inventory, so the claim is held here rather
 * than by review. A new variable either appears in the table or fails this.
 */
import { ok } from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const DOC_PATH = join(REPO_ROOT, "docs", "environment-variables.md");

/**
 * Families the doc names once with a suffix list rather than one row each.
 * Every member still has to be reachable from the row that covers it.
 */
const DOCUMENTED_FAMILIES: ReadonlyArray<RegExp> = [
	/^CLIO_WORKER_FAUX(_[A-Z_]+)?$/, // documented as `CLIO_WORKER_FAUX` (+ suffixes)
	/^CLIO_HOOK_BUDGET_[A-Z_]+_MS$/, // documented as `CLIO_HOOK_BUDGET_<PHASE>_MS`
];

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...sourceFiles(full));
			continue;
		}
		if (full.endsWith(".ts") || full.endsWith(".mts")) found.push(full);
	}
	return found;
}

function readEnvNames(): Map<string, string[]> {
	const byName = new Map<string, string[]>();
	const pattern = /env(?:\.(CLIO_[A-Z0-9_]+|NO_COLOR)|\[["'](CLIO_[A-Z0-9_]+|NO_COLOR)["']\])/g;
	for (const file of sourceFiles(join(REPO_ROOT, "src"))) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(pattern)) {
			const name = match[1] ?? match[2];
			if (name === undefined) continue;
			const relative = file.slice(REPO_ROOT.length);
			const sites = byName.get(name) ?? [];
			if (!sites.includes(relative)) sites.push(relative);
			byName.set(name, sites);
		}
	}
	return byName;
}

describe("contracts/environment variable inventory", () => {
	it("documents every environment variable the shipped src tree reads", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		const missing: string[] = [];
		for (const [name, sites] of readEnvNames()) {
			if (doc.includes(`\`${name}\``)) continue;
			if (DOCUMENTED_FAMILIES.some((family) => family.test(name))) continue;
			missing.push(`${name} (read at ${sites.join(", ")})`);
		}
		ok(
			missing.length === 0,
			`docs/environment-variables.md claims to list every variable src reads, and omits:\n  ${missing.join("\n  ")}`,
		);
	});

	it("says that the two file-writing traces take a path", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		// Both were read as on/off toggles because they sit beside seven that are.
		// Setting either to `1` writes a file called `1` in the working directory.
		ok(doc.includes("These two take a path, not `1`"), "the exception to the toggle convention is stated");
		ok(doc.includes("CLIO_RENDER_TRACE") && doc.includes("CLIO_MEMORY_TRACE"));
	});

	it("warns that the memory trace carries conversation text", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		const row = doc.split("\n").find((line) => line.includes("`CLIO_MEMORY_TRACE`"));
		ok(row !== undefined, "the memory trace has a row");
		ok(row?.includes("content-bearing"), `the row states what the file contains: ${row}`);
	});
});
