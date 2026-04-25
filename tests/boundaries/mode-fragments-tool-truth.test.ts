/**
 * Mode prompt fragments must agree with MODE_MATRIX about which tool names
 * are available. The runtime registry filters the API tool schema by mode,
 * but the LLM also reads the system prompt; if the prompt advertises a tool
 * the matrix denies, the model recites the wrong list back to the user and
 * may attempt blocked calls. The advise smoke test on 2026-04-25 caught
 * exactly that: advise.md said "Reserve bash for read-only inspection
 * commands" while the matrix excluded bash, so the model claimed bash was
 * available. This test pins each fragment against the matrix so a future
 * tool-name addition or mode change cannot reintroduce that drift.
 *
 * Convention enforced:
 *   - Fragment text must contain an "Available tools:" line listing every
 *     tool name from MODE_MATRIX[mode].tools, comma-separated.
 *   - Fragment text must not advertise any tool name absent from the
 *     mode's matrix. The check runs against word-boundary matches so
 *     incidental mentions inside negative phrases ("not available: bash")
 *     do not trip the guard; only "available tools" enumeration counts.
 */

import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { ALL_MODES, MODE_MATRIX, type ModeName } from "../../src/domains/modes/matrix.js";

const FRAGMENTS_DIR = join(import.meta.dirname, "..", "..", "src", "domains", "prompts", "fragments", "modes");

function loadFragmentBody(mode: ModeName): string {
	const text = readFileSync(join(FRAGMENTS_DIR, `${mode}.md`), "utf8");
	// Drop frontmatter so version/budget metadata never trips the tool scan.
	const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
	return (match?.[1] ?? text).trim();
}

function extractAvailableToolsLine(body: string): string | null {
	for (const line of body.split("\n")) {
		const m = line.match(/^Available tools:\s*(.+)$/i);
		if (m) return m[1] ?? null;
	}
	return null;
}

function parseToolsList(line: string): string[] {
	return line
		.replace(/\.$/, "")
		.split(/[,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

describe("prompt fragments: mode tool list agrees with MODE_MATRIX", () => {
	for (const mode of ALL_MODES) {
		it(`${mode}.md enumerates exactly the matrix tools on its 'Available tools:' line`, () => {
			const body = loadFragmentBody(mode);
			const line = extractAvailableToolsLine(body);
			ok(line, `${mode}.md must contain an 'Available tools: ...' line so the LLM has ground truth`);
			const declared = new Set(parseToolsList(line));
			const matrixTools = new Set<string>(MODE_MATRIX[mode].tools);
			for (const expected of matrixTools) {
				ok(
					declared.has(expected),
					`${mode}.md 'Available tools' must include "${expected}" (matrix says yes); got: ${[...declared].join(", ")}`,
				);
			}
			for (const declaredTool of declared) {
				ok(
					matrixTools.has(declaredTool),
					`${mode}.md 'Available tools' lists "${declaredTool}" but the matrix denies it; remove from the fragment or update the matrix`,
				);
			}
		});

		it(`${mode}.md does not advertise denied tools via "Reserve <tool>" / "Use <tool>" / "via <tool>" phrasing`, () => {
			// Targeted regex check for the phrasings that actually mislead the
			// model. The earlier draft caught false positives on the verb
			// "write" inside prose like "write it through write_plan", so we
			// scope the scan to imperative tool-use phrasings only. Names that
			// collide with English verbs (write, edit, read) still benefit
			// because the regexes anchor on directives.
			const body = loadFragmentBody(mode);
			const denied = Object.values(ToolNames).filter((tool) => !MODE_MATRIX[mode].tools.has(tool));
			for (const tool of denied) {
				const phrasings = [
					new RegExp(`\\bReserve\\s+${tool}\\b`, "i"),
					new RegExp(`\\bUse\\s+${tool}\\s+(to|for)\\b`, "i"),
					new RegExp(`\\bvia\\s+${tool}\\b`, "i"),
					new RegExp(`\\bthe\\s+${tool}\\s+tool\\b`, "i"),
				];
				for (const rx of phrasings) {
					ok(
						!rx.test(body),
						`${mode}.md uses denied tool "${tool}" via the directive pattern ${rx}; rewrite the line so the LLM does not believe ${tool} is available`,
					);
				}
			}
		});
	}
});
