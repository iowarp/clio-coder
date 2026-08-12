/**
 * The settings inventory in `docs/configuration-and-targets.md`, held against
 * the schema it claims to describe.
 *
 * Strict validation means an undocumented key is not a soft failure: a user who
 * cannot find a key in the docs and guesses at its spelling gets a startup
 * error, and a user who finds a key documented with the wrong default tunes
 * against a number that was never in effect. Both are worse than no table, so
 * the table is checked rather than reviewed.
 */
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const DOC_PATH = join(REPO_ROOT, "docs", "configuration-and-targets.md");

/**
 * Paths whose children are user data rather than settings. A configured target
 * or agent is documented by its own section, not by one row per field.
 */
const OPAQUE_PATHS = new Set(["targets", "runtimePlugins", "delegation.agents", "fleet.nodes", "scope", "keybindings"]);

function leafPaths(value: unknown, prefix = ""): string[] {
	if (prefix.length > 0 && OPAQUE_PATHS.has(prefix)) return [prefix];
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return prefix.length > 0 ? [prefix] : [];
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return prefix.length > 0 ? [prefix] : [];
	return entries.flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

function inventorySection(): string {
	const doc = readFileSync(DOC_PATH, "utf8");
	const start = doc.indexOf("## Settings inventory");
	ok(start >= 0, "the inventory section exists");
	const end = doc.indexOf("\n## ", start + 1);
	return doc.slice(start, end === -1 ? undefined : end);
}

describe("contracts/settings inventory", () => {
	it("gives every settings key a row", () => {
		const section = inventorySection();
		const missing = leafPaths(DEFAULT_SETTINGS).filter((path) => !section.includes(`| \`${path}\` |`));
		ok(missing.length === 0, `docs/configuration-and-targets.md has no inventory row for:\n  ${missing.join("\n  ")}`);
	});

	it("states the shipped default in the row that names the key", () => {
		const rowFor = (path: string): string =>
			inventorySection()
				.split("\n")
				.find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
		// Spot-checked across the value shapes a row can carry, including the one
		// that had diverged from its policy fallback and the two that read as a
		// bare word rather than a literal.
		const expectations: ReadonlyArray<readonly [string, string]> = [
			["memory.intervention.timeoutMs", "`180000`"],
			["memory.intervention.everyNTools", "`10`"],
			["guardrails.turnToolCallBudget", "`60`"],
			["compaction.threshold", "`0.8`"],
			["compaction.auto", "`true`"],
			["budget.sessionCeilingUsd", "`5`"],
			["budget.concurrency", "`auto`"],
			["autonomy", "`auto-edit`"],
			["orchestrator.target", "`null`"],
			["terminal.outputVerbosity", "`default`"],
		];
		for (const [path, expected] of expectations) {
			const row = rowFor(path);
			ok(row.length > 0, `no row for ${path}`);
			ok(row.includes(expected), `${path} should document its default as ${expected}, row reads: ${row}`);
		}
	});

	it("says when a change to each key takes effect", () => {
		// Scoped to the inventory section; the page carries other tables whose
		// first column is also a backticked lowercase word.
		const rows = inventorySection()
			.split("\n")
			.filter((line) => /^\| `[a-z]/.test(line));
		ok(rows.length >= 40, `the inventory has rows to check, found ${rows.length}`);
		const vague = rows.filter((row) => !/(immediately|next turn|next session|next dispatch|restart)/.test(row));
		ok(vague.length === 0, `rows with no effect timing:\n  ${vague.join("\n  ")}`);
	});
});
