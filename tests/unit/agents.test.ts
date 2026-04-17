import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFleet } from "../../src/domains/agents/fleet-parser.js";
import { parseFrontmatter } from "../../src/domains/agents/frontmatter.js";

describe("agents/frontmatter", () => {
	it("parses minimal frontmatter + body", () => {
		const raw = "---\nid: coder\nversion: 1\n---\nbody text\n";
		const parsed = parseFrontmatter(raw, "test.md");
		strictEqual(parsed.frontmatter.id, "coder");
		strictEqual(parsed.frontmatter.version, 1);
		strictEqual(parsed.body.trim(), "body text");
	});

	it("throws when opening delimiter missing", () => {
		throws(() => parseFrontmatter("no frontmatter here", "test.md"));
	});

	it("throws when closing delimiter missing", () => {
		throws(() => parseFrontmatter("---\nid: coder\nbody without close", "test.md"));
	});

	it("throws when frontmatter is not an object", () => {
		throws(() => parseFrontmatter("---\n- a\n- b\n---\nbody", "test.md"));
	});

	it("throws on invalid yaml", () => {
		throws(() => parseFrontmatter('---\nkey: "unterminated\n---\nbody', "test.md"));
	});
});

describe("agents/fleet-parser", () => {
	it("parses single recipe", () => {
		const f = parseFleet("coder");
		strictEqual(f.steps.length, 1);
		strictEqual(f.steps[0]?.recipeId, "coder");
		deepStrictEqual(f.steps[0]?.options, {});
	});

	it("parses recipe with options", () => {
		const f = parseFleet('coder[model="claude-sonnet", thinking=low]');
		strictEqual(f.steps[0]?.recipeId, "coder");
		deepStrictEqual(f.steps[0]?.options, { model: "claude-sonnet", thinking: "low" });
	});

	it("parses fleet chain", () => {
		const f = parseFleet("spotter -> planner -> coder");
		strictEqual(f.steps.length, 3);
		strictEqual(f.steps.map((s) => s.recipeId).join(","), "spotter,planner,coder");
	});

	it("throws on empty input", () => {
		throws(() => parseFleet("   "));
	});

	it("throws on dangling arrow", () => {
		throws(() => parseFleet("coder ->"));
	});

	it("throws on duplicate option key", () => {
		throws(() => parseFleet("coder[model=a, model=b]"));
	});

	it("throws on unclosed bracket", () => {
		throws(() => parseFleet("coder[model=a"));
	});
});
