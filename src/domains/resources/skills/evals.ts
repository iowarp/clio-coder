/**
 * Parser for the RED-GREEN `evals.md` files that catalog skills ship beside
 * SKILL.md. The format is prose-tolerant markdown: scenario blocks open with
 * `## S<n> - <title>`, carry a `Setup:` paragraph (the realistic prompt both
 * eval runs receive), and an `Expected:` bullet list (the pass/fail rubric).
 * Non-scenario sections (RED failure modes, observed-gap notes) are ignored;
 * a scenario heading whose block is missing Setup or Expected is skipped with
 * a diagnostic instead of failing the whole file.
 */

export interface SkillEvalScenario {
	/** Normalized id, e.g. "S1". */
	id: string;
	number: number;
	title: string;
	/** Setup paragraph with the `Setup:` label stripped; used as the run prompt. */
	setup: string;
	/** Expected rubric bullets, wrapped lines joined. */
	expected: string[];
}

export interface SkillEvalParseResult {
	scenarios: SkillEvalScenario[];
	/** One entry per scenario-shaped block that could not be parsed. */
	diagnostics: string[];
}

// Tolerates ASCII dash/colon and the en/em dashes older evals.md files used.
// The canonical prefix is S ("## S1 - title"); discipline skills use other
// letters (clio-dev's D1), so any single capital letter is accepted.
const SCENARIO_HEADING = /^##\s+([A-Z])(\d+)\s*[-:–—]\s*(.+?)\s*$/;

export function parseSkillEvals(markdown: string): SkillEvalParseResult {
	const lines = markdown.split("\n");
	const scenarios: SkillEvalScenario[] = [];
	const diagnostics: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const heading = SCENARIO_HEADING.exec(lines[index] ?? "");
		if (heading === null) {
			index += 1;
			continue;
		}
		const blockStart = index + 1;
		let blockEnd = blockStart;
		while (blockEnd < lines.length && !/^##\s+/.test(lines[blockEnd] ?? "")) blockEnd += 1;
		const block = lines.slice(blockStart, blockEnd);
		const number = Number.parseInt(heading[2] ?? "", 10);
		const id = `${heading[1] ?? "S"}${number}`;
		const title = heading[3] ?? "";
		const setup = extractSetup(block);
		const expected = extractExpected(block);
		if (setup === null) diagnostics.push(`${id} (${title}): no "Setup:" or "Prompt:" paragraph found; scenario skipped`);
		else if (expected.length === 0) diagnostics.push(`${id} (${title}): no "Expected:" bullets found; scenario skipped`);
		else scenarios.push({ id, number, title, setup, expected });
		index = blockEnd;
	}
	return { scenarios, diagnostics };
}

/**
 * Join the paragraph starting at the first `Setup:` line, stripping the
 * label. Scenario blocks that open with a bare `Prompt:` paragraph (no
 * Setup line) fall back to that paragraph.
 */
function extractSetup(block: ReadonlyArray<string>): string | null {
	return extractLabeledParagraph(block, /^Setup:\s*(.*)$/i) ?? extractLabeledParagraph(block, /^(Prompt:.*)$/i);
}

function extractLabeledParagraph(block: ReadonlyArray<string>, label: RegExp): string | null {
	for (let i = 0; i < block.length; i += 1) {
		const line = block[i] ?? "";
		const match = label.exec(line.trim());
		if (match === null) continue;
		const parts: string[] = [];
		if ((match[1] ?? "").length > 0) parts.push(match[1] ?? "");
		for (let j = i + 1; j < block.length; j += 1) {
			const next = (block[j] ?? "").trim();
			if (next.length === 0) break;
			if (/^Expected:?\s*$/i.test(next)) break;
			parts.push(next);
		}
		const setup = parts.join(" ").trim();
		return setup.length > 0 ? setup : null;
	}
	return null;
}

/** Collect `- ` bullets after the `Expected:` line, joining wrapped lines. */
function extractExpected(block: ReadonlyArray<string>): string[] {
	let start = -1;
	for (let i = 0; i < block.length; i += 1) {
		if (/^Expected:?\s*$/i.test((block[i] ?? "").trim())) {
			start = i + 1;
			break;
		}
	}
	if (start < 0) return [];
	const bullets: string[] = [];
	let current: string[] | null = null;
	for (let i = start; i < block.length; i += 1) {
		const raw = block[i] ?? "";
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			if (current !== null) {
				bullets.push(current.join(" "));
				current = null;
			}
			continue;
		}
		// Top-level bullets only: an indented dash is continuation text of the
		// bullet above it, not a new rubric item.
		const bullet = /^[-*]\s+(.*)$/.exec(raw);
		if (bullet !== null) {
			if (current !== null) bullets.push(current.join(" "));
			current = [bullet[1] ?? ""];
			continue;
		}
		if (current !== null && /^\s+\S/.test(raw)) {
			current.push(trimmed);
			continue;
		}
		// A non-bullet, non-continuation paragraph ends the Expected list.
		break;
	}
	if (current !== null) bullets.push(current.join(" "));
	return bullets.map((bullet) => bullet.trim()).filter((bullet) => bullet.length > 0);
}
