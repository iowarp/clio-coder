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
	/** Optional shell commands that materialize the workspace fixture before the runs. */
	fixtureCommands?: string;
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
// letters (clio-coder-dev's D1), so any single capital letter is accepted.
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
		const fixtureCommands = extractFixtureCommands(block);
		const expected = extractExpected(block);
		if (setup === null) diagnostics.push(`${id} (${title}): no "Setup:" or "Prompt:" paragraph found; scenario skipped`);
		else if (expected.length === 0) diagnostics.push(`${id} (${title}): no "Expected:" bullets found; scenario skipped`);
		else scenarios.push({ id, number, title, setup, ...(fixtureCommands ? { fixtureCommands } : {}), expected });
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

function isScenarioLabel(line: string): boolean {
	const trimmed = line.trim();
	// extractExpected accepts `Expected` with or without a colon, so a bare
	// `Expected` line must terminate the setup paragraph too.
	return /^(Expected|Fixture|Setup commands):/i.test(trimmed) || /^Expected$/i.test(trimmed);
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
			if (isScenarioLabel(next)) break;
			parts.push(next);
		}
		const setup = parts.join(" ").trim();
		return setup.length > 0 ? setup : null;
	}
	return null;
}

function extractFixtureCommands(block: ReadonlyArray<string>): string | null {
	for (let i = 0; i < block.length; i += 1) {
		const line = (block[i] ?? "").trim();
		const match = /^(?:Fixture|Setup commands):\s*(.*)$/i.exec(line);
		if (match === null) continue;
		const inline = (match[1] ?? "").trim();
		let cursor = i + 1;
		while (cursor < block.length && (block[cursor] ?? "").trim().length === 0) cursor += 1;
		const first = block[cursor] ?? "";
		const fence = /^```\w*\s*$/.test(first.trim());
		if (fence) {
			const commands: string[] = [];
			for (let j = cursor + 1; j < block.length; j += 1) {
				const current = block[j] ?? "";
				if (/^```\s*$/.test(current.trim())) {
					const script = commands.join("\n").trim();
					return script.length > 0 ? script : null;
				}
				commands.push(current);
			}
			return null;
		}
		const commands: string[] = [];
		if (inline.length > 0) commands.push(inline);
		for (let j = cursor; j < block.length; j += 1) {
			const current = block[j] ?? "";
			const trimmed = current.trim();
			if (trimmed.length === 0) break;
			if (isScenarioLabel(trimmed)) break;
			commands.push(current);
		}
		const script = commands.join("\n").trim();
		return script.length > 0 ? script : null;
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
