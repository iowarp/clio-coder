import { deepEqual, ok, strictEqual } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { DEFAULT_SETTINGS, THINKING_LEVELS } from "../../src/core/defaults.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";
import { VALID_THINKING_LEVELS } from "../../src/domains/providers/types/capability-flags.js";
import { buildSettingItems } from "../../src/interactive/overlays/settings.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/**
 * Files still allowed to spell the list out. The two roots hold the canonical
 * copy and pin each other in the first test below; the tools substrate carries
 * its own copies that a later change removes.
 */
const LITERAL_COPY_ALLOWLIST = new Set([
	path.join("src", "core", "defaults.ts"),
	path.join("src", "domains", "providers", "types", "capability-flags.ts"),
	path.join("src", "tools", "dispatch.ts"),
	path.join("src", "tools", "dispatch-arguments.ts"),
]);

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
	}
	return out;
}

/**
 * Match the level list written out in source order, on one line or many. The
 * pattern stops one short of the last level so it also catches the truncated
 * copy that omits "max", which is the shape every drift so far has taken.
 */
function containsLiteralLevelList(source: string): boolean {
	const gap = String.raw`\s*,\s*`;
	const prefix = THINKING_LEVELS.slice(0, -1);
	const pattern = new RegExp(prefix.map((level) => `"${level}"`).join(gap));
	return pattern.test(source);
}

describe("contracts/thinking-levels", () => {
	it("maintains an exhaustive, identical thinking level list across core and provider domains", () => {
		const expected = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		deepEqual([...THINKING_LEVELS], expected);
		deepEqual([...VALID_THINKING_LEVELS], expected);
	});

	it("keeps the level list out of the rest of src/", () => {
		const offenders = walk(SRC_ROOT)
			.map((file) => path.relative(REPO_ROOT, file))
			.filter((rel) => !LITERAL_COPY_ALLOWLIST.has(rel))
			.filter((rel) => containsLiteralLevelList(readFileSync(path.join(REPO_ROOT, rel), "utf8")));
		deepEqual(offenders, [], "import THINKING_LEVELS from src/core/defaults.ts instead of respelling it");
	});

	it("accepts every level on a dispatch job spec, max included", () => {
		for (const level of THINKING_LEVELS) {
			const result = validateJobSpec({ agentId: "scout", task: "hi", thinkingLevel: level });
			ok(result.ok, `validateJobSpec rejected thinkingLevel=${level}: ${result.ok ? "" : result.errors.join("; ")}`);
		}
		const rejected = validateJobSpec({ agentId: "scout", task: "hi", thinkingLevel: "ultra" });
		strictEqual(rejected.ok, false);
	});

	it("accepts every level on --thinking, max included", () => {
		for (const level of THINKING_LEVELS) {
			const parsed = parseRunCliArgs(["--thinking", level, "hello"]);
			strictEqual(parsed.thinking, level, `--thinking ${level}`);
		}
	});

	it("offers every level in the settings center when no runtime resolves", () => {
		const items = buildSettingItems(structuredClone(DEFAULT_SETTINGS));
		const thinking = items.find((item) => item.id === "orchestrator.thinkingLevel");
		ok(thinking, "settings center exposes orchestrator.thinkingLevel");
		deepEqual([...(thinking.values ?? [])], [...THINKING_LEVELS]);
	});
});
