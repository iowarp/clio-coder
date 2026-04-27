import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type InstructionSource,
	type InstructionSourceKind,
	mergeInstructions,
	parseSections,
} from "../../src/domains/prompts/instruction-merge.js";

function source(path: string, kind: InstructionSourceKind, body: string): InstructionSource {
	return { path, kind, sections: parseSections(body) };
}

describe("prompts/instruction-merge parseSections", () => {
	it("splits on H2 headers and preserves preamble as the empty key", () => {
		const sections = parseSections("preamble line\n\n## Setup\n\nrun npm ci\n\n## Test\n\nrun npm test\n");
		strictEqual(sections.get("")?.trim(), "preamble line");
		strictEqual(sections.get("Setup")?.trim(), "run npm ci");
		strictEqual(sections.get("Test")?.trim(), "run npm test");
	});

	it("returns an empty map for an empty document", () => {
		strictEqual(parseSections("").size, 0);
	});

	it("normalizes header whitespace", () => {
		const sections = parseSections("##   Setup   \n\nbody\n");
		strictEqual(sections.has("Setup"), true);
	});
});

describe("prompts/instruction-merge mergeInstructions", () => {
	it("CLIO.md alone produces verbatim output with provenance", () => {
		const clio = source("/repo/CLIO.md", "clio", "## Setup\n\nrun npm ci\n");
		const merged = mergeInstructions([clio]);
		ok(merged.text.includes("## Setup"));
		ok(merged.text.includes("run npm ci"));
		ok(merged.text.includes("CLIO.md"));
		strictEqual(merged.contributors.length, 1);
		strictEqual(merged.contributors[0]?.path, "/repo/CLIO.md");
	});

	it("CLIO.md + CLAUDE.md merge: CLIO Setup wins, CLAUDE Setup dropped, CLAUDE-only sections appear", () => {
		const clio = source("/repo/CLIO.md", "clio", "## Setup\n\nclio setup body\n");
		const claude = source(
			"/repo/CLAUDE.md",
			"claude",
			"## Setup\n\nclaude setup body\n\n## Notes\n\nclaude notes body\n",
		);
		const merged = mergeInstructions([clio, claude]);
		ok(merged.text.includes("clio setup body"));
		ok(!merged.text.includes("claude setup body"));
		ok(merged.text.includes("claude notes body"));
		const setupContrib = merged.contributors.find((c) => c.path === "/repo/CLIO.md");
		ok(setupContrib?.sections.includes("Setup"));
		const notesContrib = merged.contributors.find((c) => c.path === "/repo/CLAUDE.md");
		ok(notesContrib?.sections.includes("Notes"));
	});

	it("three-way conflict: CLIO + CLAUDE + AGENTS define same section, CLIO wins, others dropped", () => {
		const clio = source("/repo/CLIO.md", "clio", "## Setup\n\nclio body\n");
		const claude = source("/repo/CLAUDE.md", "claude", "## Setup\n\nclaude body\n");
		const agents = source("/repo/AGENTS.md", "agents", "## Setup\n\nagents body\n");
		const merged = mergeInstructions([clio, claude, agents]);
		ok(merged.text.includes("clio body"));
		ok(!merged.text.includes("claude body"));
		ok(!merged.text.includes("agents body"));
	});

	it("identical bodies de-duplicated across non-CLIO sources", () => {
		const claude = source("/repo/CLAUDE.md", "claude", "## Lint\n\nbiome check\n");
		const agents = source("/repo/AGENTS.md", "agents", "## Lint\n\nbiome check\n");
		const merged = mergeInstructions([claude, agents]);
		const lintOccurrences = merged.text.split("biome check").length - 1;
		strictEqual(lintOccurrences, 1);
	});

	it("CLIO-dev.md present overrides CLIO.md sections and is tagged [dev]", () => {
		const clio = source("/repo/CLIO.md", "clio", "## Setup\n\nclio setup\n\n## Build\n\nclio build\n");
		const dev = source("/repo/CLIO-dev.md", "clio-dev", "## Setup\n\ndev setup override\n");
		const merged = mergeInstructions([clio, dev]);
		ok(merged.text.includes("dev setup override"));
		ok(!merged.text.includes("clio setup"));
		ok(merged.text.includes("clio build"));
		const devContrib = merged.contributors.find((c) => c.path === "/repo/CLIO-dev.md");
		ok(devContrib?.tag === "dev");
	});

	it("non-CLIO closer-to-cwd source wins over more distant non-CLIO source", () => {
		const parent = source("/repo/CLAUDE.md", "claude", "## Notes\n\nparent notes\n");
		const child = source("/repo/pkg/CLAUDE.md", "claude", "## Notes\n\nchild notes\n");
		const merged = mergeInstructions([parent, child]);
		ok(merged.text.includes("child notes"));
		ok(!merged.text.includes("parent notes"));
	});

	it("preserves CLIO.md section ordering in the output", () => {
		const clio = source("/repo/CLIO.md", "clio", "## Setup\n\nA\n\n## Build\n\nB\n\n## Test\n\nC\n");
		const claude = source("/repo/CLAUDE.md", "claude", "## Notes\n\nN\n");
		const merged = mergeInstructions([clio, claude]);
		const setupAt = merged.text.indexOf("## Setup");
		const buildAt = merged.text.indexOf("## Build");
		const testAt = merged.text.indexOf("## Test");
		ok(setupAt > -1 && setupAt < buildAt && buildAt < testAt);
	});

	it("returns an empty merged result when given no sources", () => {
		const merged = mergeInstructions([]);
		strictEqual(merged.text, "");
		strictEqual(merged.contributors.length, 0);
	});
});
