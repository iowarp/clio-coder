// The rendering workload `scripts/perf-workload.ts` measures: one long Markdown answer covering every
// construct the renderer handles, hostile input included, split at blank lines outside fences so
// tool calls land between blocks the way a real agent finishes a block before it calls a tool. The
// text is the retired workbench's `stream-workload` answer, kept so the numbers stay comparable with
// the reference budgets in DESIGN.md "Streaming cadence".

/** Characters per `agent_message_chunk`, and chunks sent between two pace ticks. */
export const WORKLOAD_CHUNK_CHARS = 5;
export const WORKLOAD_CHUNKS_PER_TICK = 4;
export const WORKLOAD_PACE_MS = 4;

/** Splits Markdown at blank lines outside fenced code, keeping each separator with its block. */
export function workloadBlocks(markdown) {
	const blocks = [];
	let current = "";
	let fence = null;
	for (const line of markdown.split("\n")) {
		const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
		if (opening !== null) {
			const run = opening[1] ?? "";
			if (fence === null) fence = run;
			else if (run.startsWith(fence[0] ?? "`") && run.length >= fence.length) fence = null;
		}
		current += `${line}\n`;
		if (fence === null && line.trim().length === 0 && current.trim().length > 0) {
			blocks.push(current);
			current = "";
		}
	}
	if (current.length > 0) blocks.push(current);
	return blocks;
}

/**
 * The reference answer is 6.7 KB in 1,358 chunks. A larger `bytes` target adds numbered paragraphs to
 * its long-paragraph section until the answer reaches that size, so every other construct stays put.
 */
export function workloadMarkdown(bytes = 0) {
	const reference = workloadText(6);
	if (bytes <= reference.length) return reference;
	const paragraph = workloadText(7).length - reference.length;
	return workloadText(6 + Math.ceil((bytes - reference.length) / paragraph));
}

function workloadText(count) {
	const paragraphs = Array.from(
		{ length: count },
		(_, index) =>
			`Paragraph ${index + 1}. The residual history shows the usual transient in the first forty iterations, ` +
			"then a clean monotone decrease. Cases L1 through L3 reach the tolerance with margin, and the observed " +
			"order of accuracy is consistent with the scheme. The coarse case stalls at a residual three orders of " +
			"magnitude above the tolerance, which the plan anticipates. Nothing in the notes suggests a bug; the " +
			"stall is the expected behavior of a mesh that cannot resolve the boundary layer.\n",
	);
	return [
		"# Convergence audit of the atlas field study",
		"",
		"I read the notes under `analysis/`, re-ran the mesh **convergence** checks, and compared the *reported* residuals against the tolerances in the study plan. The short version: three of four cases converge; the coarse case does not.",
		"",
		"## What I checked",
		"",
		"1. The mesh hierarchy declared in the notes",
		"   - four refinement levels, each halving the cell size",
		"   - the coarse level uses a different time step, see [the study plan](https://example.org/atlas/plan)",
		"2. The residual history for each level",
		"   1. steady-state residual below `1e-6`",
		"   2. monotone decrease after iteration 40",
		"3. The reported Richardson extrapolation",
		"",
		"- [x] notes read",
		"- [x] checks re-run",
		"- [ ] coarse case explained",
		"",
		"> The coarse case was never expected to converge at the declared tolerance; the plan flags it as a smoke run.",
		"> That flag is easy to miss because it lives in a footnote.",
		"",
		"## Results",
		"",
		"| Level | Cells | Final residual | Iterations | Converged |",
		"| --- | ---: | ---: | ---: | :---: |",
		"| L0 (coarse) | 12,800 | 3.2e-4 | 400 | no |",
		"| L1 | 51,200 | 8.9e-7 | 212 | yes |",
		"| L2 | 204,800 | 6.1e-7 | 231 | yes |",
		"| L3 (fine) | 819,200 | 4.4e-7 | 248 | yes |",
		"| Extrapolated | — | 2.0e-7 | — | — |",
		"",
		"The observed order of accuracy is 1.93, which matches the second-order scheme within the usual tolerance.",
		"",
		"---",
		"",
		"## The check script",
		"",
		"```ts",
		'import { readFile } from "node:fs/promises";',
		"",
		"interface Level {",
		"\treadonly name: string;",
		"\treadonly cells: number;",
		"\treadonly residuals: readonly number[];",
		"}",
		"",
		"export async function loadLevels(path: string): Promise<Level[]> {",
		'\tconst raw = await readFile(path, "utf8");',
		"\treturn JSON.parse(raw) as Level[];",
		"}",
		"",
		"export function converged(level: Level, tolerance = 1e-6): boolean {",
		"\tconst last = level.residuals.at(-1) ?? Number.POSITIVE_INFINITY;",
		"\tconst monotone = level.residuals.slice(40).every((value, index, all) => index === 0 || value <= all[index - 1]!);",
		"\treturn last < tolerance && monotone; // both conditions from the plan",
		"}",
		"",
		"export function observedOrder(levels: readonly Level[]): number {",
		"\tconst [a, b, c] = levels.slice(-3).map((level) => level.residuals.at(-1) ?? 0);",
		"\treturn Math.log((a! - b!) / (b! - c!)) / Math.log(2);",
		"}",
		"```",
		"",
		"And the same check in Python, which the notes actually used:",
		"",
		"```python",
		"import json",
		"import math",
		"from pathlib import Path",
		"",
		"",
		"def load_levels(path: Path) -> list[dict]:",
		"    return json.loads(path.read_text())",
		"",
		"",
		"def converged(level: dict, tolerance: float = 1e-6) -> bool:",
		'    residuals = level["residuals"]',
		"    tail = residuals[40:]",
		"    monotone = all(b <= a for a, b in zip(tail, tail[1:]))",
		"    return residuals[-1] < tolerance and monotone",
		"",
		"",
		"def observed_order(levels: list[dict]) -> float:",
		'    a, b, c = (lvl["residuals"][-1] for lvl in levels[-3:])',
		"    return math.log((a - b) / (b - c)) / math.log(2)",
		"```",
		"",
		"A snippet in a language the highlighter will not know:",
		"",
		"```atlasql",
		"SELECT level, last(residual) FROM history GROUP BY level HAVING last(residual) < 1e-6;",
		"```",
		"",
		"## How the levels relate",
		"",
		"```mermaid",
		"flowchart LR",
		'  L0["L0 coarse"] --> L1["L1"]',
		'  L1 --> L2["L2"]',
		'  L2 --> L3["L3 fine"]',
		'  L1 -.-> R{{"Richardson"}}',
		"  L2 -.-> R",
		"  L3 -.-> R",
		"```",
		"",
		"The diagram below is deliberately malformed to show the failure state:",
		"",
		"```mermaid",
		"flowchart LR",
		"  A --> ",
		"  --> B[",
		"```",
		"",
		"## Hostile input the renderer must neutralize",
		"",
		'Raw HTML: <script>alert(1)</script> and <img src=x onerror=alert(1)> and <a href="javascript:alert(1)">x</a>.',
		"",
		"Links: [safe](https://example.org/ok), [unsafe](javascript:alert(1)), [data](data:text/html;base64,PHNjcmlwdD4=), ![image](https://evil.example/tracker.png).",
		"",
		"Autolink <https://example.org/auto> and a bare URL https://example.org/bare and `<b>` in code.",
		"",
		"## Long paragraphs",
		"",
		...paragraphs,
		"## Conclusion",
		"",
		"The study converges as declared. I recommend marking the coarse run as a smoke test in the table itself rather than in a footnote.",
		"",
	].join("\n");
}

/**
 * Streams the workload through the fixture's own helpers: reasoning, then each block in 5-character
 * chunks with a pace tick every four chunks, a burst of one to four tool calls before every third
 * block (the seventh call fails), and a second reasoning chunk halfway.
 */
export async function streamWorkload({ update, text, delay, cancelled, bytes = 0 }) {
	const blocks = workloadBlocks(workloadMarkdown(bytes));
	let ordinal = 0;
	const tool = async () => {
		ordinal += 1;
		const kind = ordinal % 3 === 0 ? "execute" : "read";
		// The runtime titles a call with its tool's name.
		const title = kind === "execute" ? "bash" : "read";
		const toolCallId = `workload-${ordinal}`;
		const rawInput =
			kind === "execute"
				? { command: `rg --files analysis | head -${ordinal}` }
				: { path: "analysis/convergence-notes.md" };
		update({ sessionUpdate: "tool_call", toolCallId, title, kind, status: "in_progress", rawInput });
		await delay(WORKLOAD_PACE_MS);
		const failed = ordinal === 7;
		const body = failed ? "exit status 1" : kind === "execute" ? "analysis/convergence-notes.md" : "mesh convergence";
		update({
			sessionUpdate: "tool_call_update",
			toolCallId,
			title,
			kind,
			status: failed ? "failed" : "completed",
			content: [{ type: "content", content: { type: "text", text: body } }],
			rawOutput: { result: { content: [{ type: "text", text: body }] }, isError: failed },
		});
	};
	const thought = (value) => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: value } });
	thought("Planning the audit: read the notes, run the checks, then summarize. ");
	let chunks = 0;
	for (let index = 0; index < blocks.length; index += 1) {
		if (cancelled()) return;
		if (index > 0 && index % 3 === 0) for (let call = 0; call <= index % 4; call += 1) await tool();
		if (index === Math.floor(blocks.length / 2)) thought("Halfway. The remaining sections describe the results. ");
		const characters = Array.from(blocks[index] ?? "");
		for (let at = 0; at < characters.length; at += WORKLOAD_CHUNK_CHARS) {
			if (cancelled()) return;
			text(characters.slice(at, at + WORKLOAD_CHUNK_CHARS).join(""));
			chunks += 1;
			if (chunks % WORKLOAD_CHUNKS_PER_TICK === 0) await delay(WORKLOAD_PACE_MS);
		}
	}
}
