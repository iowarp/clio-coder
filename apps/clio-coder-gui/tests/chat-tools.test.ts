import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACP_TRUNCATION_MARKER,
	CLIO_TRUNCATION_MARKER,
	collapsePlan,
	diffCopyText,
	diffCounts,
	diffPanel,
	MAX_PROPOSED_ROWS,
	parseDiff,
	synthesizeProposedDiff,
} from "../client/chat/diff.js";
import {
	applyPartialFrame,
	basename,
	describeTool,
	FAILURE_EXCERPT_MAX,
	failureExcerpt,
	formatBytes,
	formatLocation,
	outputPane,
	parseMatches,
	presentable,
	presentTool,
	readWire,
	stripResultEnvelope,
	toolOpensAtMount,
} from "../client/chat/tool-presentation.js";
import type { TimelineItem } from "../contracts/sessions.js";

/**
 * The engine's real diff format (src/tools/edit-diff.ts:429-527): a marker
 * column, a right-aligned line number padded to the file's widest number, one
 * space, then the text. There are no `@@` headers.
 */
const CLIO_DIFF = [
	"  10 const untouched = 1;",
	"- 11 const before = 2;",
	"+ 11 const after = 2;",
	"  12 const tail = 3;",
	"     ...",
	"  99 const end = 4;",
].join("\n");

const UNIFIED_DIFF = [
	"--- a/file.ts",
	"+++ b/file.ts",
	"@@ -10,3 +10,3 @@",
	" const untouched = 1;",
	"-const before = 2;",
	"+const after = 2;",
	"\\ No newline at end of file",
].join("\n");

function toolItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
	return {
		id: "t1:tool:c1",
		turnId: "t1",
		sequence: 1,
		kind: "tool",
		text: "bash",
		status: "in_progress",
		origin: "live",
		title: "bash",
		toolKind: "execute",
		toolCallId: "c1",
		...overrides,
	};
}

/* ------------------------------------------------------------------ diff */

test("the engine's line-numbered diff format is parsed as changes, not as context", () => {
	const parsed = parseDiff(CLIO_DIFF);
	assert.equal(parsed.format, "clio");
	assert.equal(parsed.adds, 1);
	assert.equal(parsed.dels, 1);
	assert.equal(parsed.elisions, 1);
	assert.equal(diffCounts(parsed), "+1 −1");
	const added = parsed.rows.find((row) => row.kind === "add");
	assert.equal(added?.text, "const after = 2;");
	assert.equal(added?.newLine, 11);
	const removed = parsed.rows.find((row) => row.kind === "del");
	assert.equal(removed?.oldLine, 11);
	// The elided run is a row of its own, not a context line called "...".
	assert.equal(parsed.rows.filter((row) => row.kind === "elision")[0]?.text, "...");
});

test("a git-style unified diff still parses, and its no-newline marker survives", () => {
	const parsed = parseDiff(UNIFIED_DIFF);
	assert.equal(parsed.format, "unified");
	assert.equal(parsed.adds, 1);
	assert.equal(parsed.dels, 1);
	assert.equal(parsed.noNewlineAtEof, true);
	// The file headers are not rows.
	assert.ok(!parsed.rows.some((row) => row.text.startsWith("+++")));
	assert.equal(parsed.rows.find((row) => row.kind === "hunk")?.newLine, 10);
});

test("an empty diff parses to no rows and claims nothing", () => {
	const parsed = parseDiff("");
	assert.deepEqual(parsed.rows, []);
	assert.equal(parsed.truncated, false);
	assert.equal(parsed.truncationNote, null);
});

test("each producer's truncation marker is named, and the diff is never called complete", () => {
	const wire = parseDiff(`${CLIO_DIFF}${ACP_TRUNCATION_MARKER}`);
	assert.equal(wire.truncated, true);
	assert.match(wire.truncationNote ?? "", /wire capped this diff at 28 KiB/);
	assert.ok(!(wire.truncationNote ?? "").includes(ACP_TRUNCATION_MARKER));

	const engine = parseDiff(`${CLIO_DIFF}\n${CLIO_TRUNCATION_MARKER}`);
	assert.equal(engine.truncated, true);
	assert.match(engine.truncationNote ?? "", /capped this diff at 32 KiB/);
	// The marker itself is stripped so it cannot be read as a line of the file.
	assert.ok(!engine.rows.some((row) => row.text.includes("diff truncated")));
});

test("a binary or unparseable payload is shown verbatim and labelled unparsed", () => {
	const binary = parseDiff("MZ\u0000\u0001\u0002 not a diff");
	assert.equal(binary.format, "unparsed");
	assert.equal(binary.adds, 0);
	assert.equal(binary.rows.length, 1);

	const prose = parseDiff("the tool wrote a sentence instead of a diff");
	assert.equal(prose.format, "unparsed");
});

test("a line the engine capped at 500 characters is flagged rather than shown as whole", () => {
	const parsed = parseDiff("+  1 const wide = …… (+4096 chars)");
	assert.equal(parsed.rows[0]?.lineCapped, true);
});

test("copying a diff yields code with markers and no line numbers", () => {
	const copied = diffCopyText(parseDiff(CLIO_DIFF));
	assert.ok(copied.includes("+const after = 2;"));
	assert.ok(copied.includes("-const before = 2;"));
	assert.ok(!copied.includes("11"));
	// Elision rows are not code and must not land in the clipboard.
	assert.ok(!copied.includes("..."));
});

test("a long diff opens collapsed around the first change and a short one opens whole", () => {
	const short = parseDiff(CLIO_DIFF);
	assert.equal(collapsePlan(short, null).collapsed, false);

	const rows: string[] = [];
	for (let line = 1; line <= 120; line += 1) rows.push(`  ${line} const line${line} = ${line};`);
	rows[99] = "+100 const changed = 100;";
	const long = parseDiff(rows.join("\n"));
	const plan = collapsePlan(long, 100);
	assert.equal(plan.collapsed, true);
	assert.ok(plan.start <= 99 && plan.end >= 99, "the first changed line is inside the opened window");
	assert.ok(plan.hiddenRows > 0);
});

test("before approval the panel is synthesized from the arguments and says nothing was written", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/src/a.ts", edits: [{ oldText: "a\nb", newText: "a\nc" }] },
		result: undefined,
		resultText: null,
		status: "pending",
		isError: false,
	});
	assert.equal(panel.provenance, "proposed");
	assert.equal(panel.label, "Proposed · not yet applied");
	assert.match(panel.note ?? "", /Nothing has been written yet/);
	assert.equal(panel.diff?.adds, 2);
	assert.equal(panel.diff?.dels, 2);
});

// A bare "cancelled" proves neither a rejection nor zero writes, so the card
// keeps the proposal and stays neutral about what reached the file.
test("a cancelled call keeps the proposal without claiming a rejection", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/a.ts", content: "new file\n" },
		result: undefined,
		resultText: null,
		status: "cancelled",
		isError: false,
	});
	assert.equal(panel.provenance, "unverified");
	assert.doesNotMatch(panel.label, /rejected/);
	assert.doesNotMatch(panel.note ?? "", /Nothing was written/);
	assert.equal(panel.diff?.adds, 1);
});

// A denial does not arrive as "cancelled". The registry settles a refused call
// as a FAILED tool result worded `<tool> blocked: <actionClass> was not
// approved`, so gating the proposal on "cancelled" alone erased the evidence of
// what the operator had just turned down.
test("a refused write arrives as failed and still shows what was refused", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/a.ts", content: "new file\n" },
		result: { kind: "error", message: "write blocked: write was not approved" },
		resultText: "write blocked: write was not approved",
		status: "failed",
		isError: true,
	});
	assert.equal(panel.provenance, "rejected");
	assert.equal(panel.label, "Not applied · not approved");
	assert.match(panel.note ?? "", /Nothing was written/);
	assert.equal(panel.diff?.adds, 1);
});

// A tool that genuinely broke is not a refusal, and must not be labelled as one.
test("a failed write that was never refused is not reported as a rejection", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/a.ts", content: "new file\n" },
		result: { kind: "error", message: "EACCES: permission denied, open '/repo/a.ts'" },
		resultText: "EACCES: permission denied, open '/repo/a.ts'",
		status: "failed",
		isError: true,
	});
	assert.equal(panel.provenance, "unverified");
	assert.equal(panel.label, "Application unverified · the call did not complete");
	assert.match(panel.note ?? "", /cannot confirm/);
	assert.doesNotMatch(panel.note ?? "", /Nothing was written/);
	assert.equal(panel.diff?.adds, 1);
});

// A call that COMPLETED and produced no diff has genuinely nothing to show, and
// must not have a locally synthesized proposal invented under it.
test("a completed call with no diff still reports no diff", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/a.ts", content: "new file\n" },
		result: { kind: "ok", output: "done" },
		resultText: "done",
		status: "completed",
		isError: false,
	});
	assert.equal(panel.provenance, "absent");
	assert.equal(panel.diff, null);
});

test("after approval the panel is the engine's own diff", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/src/a.ts" },
		result: { kind: "ok", output: "edited", details: { diff: CLIO_DIFF, firstChangedLine: 11 } },
		resultText: "edited",
		status: "completed",
		isError: false,
	});
	assert.equal(panel.provenance, "applied");
	assert.equal(panel.firstChangedLine, 11);
	assert.equal(panel.diff?.adds, 1);
});

test("a file over 1 MiB reports the skipped diff instead of drawing an empty one", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/big.json" },
		result: {
			kind: "ok",
			output: "wrote 4MB to big.json\nnote: diff skipped because the previous or new file exceeds 1 MiB",
		},
		resultText: "wrote 4MB to big.json\nnote: diff skipped because the previous or new file exceeds 1 MiB",
		status: "completed",
		isError: false,
	});
	assert.equal(panel.provenance, "skipped");
	assert.equal(panel.diff, null);
	assert.match(panel.note ?? "", /larger than 1 MiB/);
	assert.match(panel.note ?? "", /change itself still happened/);
});

test("write's no-trailing-newline note reaches the panel even though it is not in details", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/a.ts" },
		result: { kind: "ok", details: { diff: CLIO_DIFF } },
		resultText: "wrote 12B to a.ts\nnote: a.ts no longer ends with a newline; the previous content did",
		status: "completed",
		isError: false,
	});
	assert.equal(panel.diff?.noNewlineAtEof, true);
});

test("a settled call with an empty diff says the text is unchanged", () => {
	const panel = diffPanel({
		rawInput: { path: "/repo/a.ts" },
		result: { kind: "ok", output: "ok", details: { diff: "" } },
		resultText: "ok",
		status: "completed",
		isError: false,
	});
	// An empty string is absent as far as `details.diff` is concerned, so the
	// panel falls through to absent rather than claiming an unchanged file.
	assert.equal(panel.provenance, "absent");
	assert.equal(panel.diff, null);
});

test("a synthesized proposal is bounded and says so", () => {
	const content = Array.from({ length: MAX_PROPOSED_ROWS + 50 }, (_, index) => `line ${index}`).join("\n");
	const diff = synthesizeProposedDiff({ content });
	assert.equal(diff?.rows.length, MAX_PROPOSED_ROWS);
	assert.equal(diff?.truncated, true);
	assert.match(diff?.truncationNote ?? "", /stops at 400 lines/);
});

/* ----------------------------------------------------------- live output */

test("partialOutput never means the call finished", () => {
	const running = toolItem({ status: "in_progress", partialOutput: "compiling…\n" });
	const card = presentTool(running);
	assert.equal(card.settled, false);
	assert.equal(card.output.running, true);
	assert.equal(card.output.source, "partial");
	assert.equal(card.output.text, "compiling…\n");
	assert.equal(card.statusLabel, "Running");
});

test("a running tool with no frame yet still reserves the output pane", () => {
	const card = presentTool(toolItem({ status: "in_progress" }));
	assert.equal(card.body, "terminal");
	assert.equal(card.output.source, "none");
	assert.equal(card.output.running, true);
	assert.equal(card.output.placeholder, "Running. No output yet.");
});

test("the partial-to-final handover keeps the same body renderer, so the card cannot reflow", () => {
	const running = presentTool(toolItem({ status: "in_progress", partialOutput: "line 1\nline 2\n" }));
	const settled = presentTool(
		toolItem({
			status: "completed",
			rawOutput: { result: { kind: "ok", output: "line 1\nline 2\nline 3\n", details: { exitCode: 0 } }, isError: false },
		}),
	);
	assert.equal(running.body, settled.body);
	assert.equal(running.chip, settled.chip);
	// The same pane, a different source: one node, two states.
	assert.equal(running.output.source, "partial");
	assert.equal(settled.output.source, "final");
	assert.ok(settled.output.text.length > 0);
	assert.equal(settled.output.running, false);
});

test("a progress frame replaces the snapshot, so two close frames cannot duplicate text", () => {
	const first = applyPartialFrame(undefined, "step 1\n");
	const second = applyPartialFrame(first, "step 1\nstep 2\n");
	assert.equal(second, "step 1\nstep 2\n");
	// Appending would have produced "step 1\nstep 1\nstep 2\n".
	assert.equal(second?.split("step 1").length - 1, 1);
});

test("a settled frame drops any stale snapshot rather than showing two versions", () => {
	const card = presentTool(
		toolItem({
			status: "completed",
			partialOutput: "stale\n",
			rawOutput: { result: { kind: "ok", output: "final\n" }, isError: false },
		}),
	);
	assert.equal(card.output.source, "final");
	assert.equal(card.output.text, "final\n");
});

test("a cancelled call is settled and does not keep a live pane", () => {
	const pane = outputPane({ status: "cancelled", partialOutput: "half\n" }, readWire({}));
	assert.equal(pane.running, false);
	assert.equal(pane.source, "none");
});

/* ------------------------------------------------------------ taxonomy */

test("the canonical tool name keys the card, not the lossy ACP kind hint", () => {
	// git, dispatch and steer all arrive as kind "other"; read, ls and monitor
	// all arrive as kind "read". The name has to win.
	const git = presentTool(toolItem({ title: "git", toolKind: "other", rawInput: { op: "status" } }));
	assert.equal(git.chip, "git");
	assert.equal(git.body, "terminal");
	assert.equal(git.headline, "git status");

	const ls = presentTool(toolItem({ title: "ls", toolKind: "read", rawInput: { path: "src" } }));
	assert.equal(ls.chip, "list");
	assert.equal(ls.body, "file");
});

test("an unknown tool falls back to the kind hint and keeps the JSON body", () => {
	const card = presentTool(toolItem({ title: "mcp__acme__lookup", toolKind: "other", text: "mcp__acme__lookup" }));
	assert.equal(card.body, "json");
	assert.equal(card.headline, "mcp__acme__lookup");
});

test("a tool with no title at all falls back to a generic safe label", () => {
	const untitled: TimelineItem = {
		id: "t1:tool:c2",
		turnId: "t1",
		sequence: 2,
		kind: "tool",
		text: "",
		status: "pending",
		origin: "live",
		toolKind: "other",
		toolCallId: "c2",
	};
	assert.equal(presentTool(untitled).headline, "Use a Clio Coder tool");
});

test("headlines are one bounded line and never JSON", () => {
	const card = presentTool(
		toolItem({
			title: "bash",
			rawInput: { command: `${"pnpm run ".repeat(20)}build\nsecond line` },
		}),
	);
	assert.ok(card.headline.length <= 72, card.headline);
	assert.ok(!card.headline.includes("\n"));
	assert.ok(card.headline.endsWith("…"));
	assert.ok(!card.headline.startsWith("{"));
});

test("a read headline names the file and the requested range", () => {
	const card = presentTool(
		toolItem({ title: "read", toolKind: "read", rawInput: { path: "/repo/src/tools/edit.ts", offset: 20, limit: 40 } }),
	);
	assert.equal(card.headline, "edit.ts · lines 20–59");
});

test("a web_fetch headline is the host and path, and an unparseable URL is shown raw", () => {
	const good = presentTool(toolItem({ title: "web_fetch", rawInput: { url: "https://example.org/a/b?token=secret" } }));
	assert.equal(good.headline, "example.org/a/b");
	assert.ok(!good.headline.includes("secret"), "a query string never reaches the headline");
	const bad = presentTool(toolItem({ title: "web_fetch", rawInput: { url: "not a url" } }));
	assert.equal(bad.headline, "not a url");
});

test("the workspace root is folded to [project] and control characters are stripped", () => {
	assert.equal(presentable("/home/me/repo/src/a.ts", "/home/me/repo"), "[project]/src/a.ts");
	assert.equal(presentable("a\u0000b\u001fc"), "abc");
	assert.equal(presentable(`${"x".repeat(600)}`).length < 600, true);
});

test("locations render one-based, because ACP counts lines from zero", () => {
	const card = presentTool(toolItem({ locations: [{ path: "/repo/a.ts", line: 0 }, { path: "/repo/b.ts" }] }));
	assert.equal(formatLocation(card.locations[0] as { path: string; line: number | null }), "/repo/a.ts:1");
	assert.equal(formatLocation(card.locations[1] as { path: string; line: number | null }), "/repo/b.ts");
});

test("a failed tool's text comes from message, because an error result has no output field", () => {
	const card = presentTool(
		toolItem({
			status: "failed",
			rawOutput: { result: { kind: "error", message: "bash: command not found" }, isError: true },
		}),
	);
	assert.equal(card.failed, true);
	assert.equal(card.tone, "fail");
	assert.equal(card.output.text, "bash: command not found");
});

test("bash facts come from the real details keys and name the stopping reason", () => {
	const card = presentTool(
		toolItem({
			status: "completed",
			rawOutput: {
				result: {
					kind: "ok",
					output: "boom",
					details: { outcome: "timeout", exitCode: null, timedOut: true, stdoutBytes: 2048, stderrBytes: 16 },
				},
				isError: false,
			},
		}),
	);
	assert.equal(card.note, "The command timed out and was stopped.");
	assert.ok(card.facts.some((fact) => fact.label === "stdout" && fact.value === "2.0 KB"));
	assert.ok(card.facts.some((fact) => fact.label === "outcome" && fact.value === "timeout"));
});

test("search coverage is read from details.search, which reports completeness and not a match count", () => {
	const card = presentTool(
		toolItem({
			title: "grep",
			status: "completed",
			rawInput: { pattern: "todo", path: "src" },
			rawOutput: {
				result: {
					kind: "ok",
					output: "src/a.ts:12:// todo one\nsrc/a.ts:40:// todo two\nsrc/b.ts:3:// todo three",
					details: {
						search: { complete: false, reason: "limit", skipped: { count: 2, samples: ["src/x"] } },
						observation: { unit: "matches", shownCount: 3, totalCount: null, truncated: true },
					},
				},
				isError: false,
			},
		}),
	);
	assert.equal(card.body, "matches");
	assert.equal(card.matches.length, 2);
	assert.equal(card.matches[0]?.rows.length, 2);
	assert.ok(card.facts.some((fact) => fact.label === "coverage" && fact.value === "incomplete (limit)"));
	assert.ok(card.facts.some((fact) => fact.label === "skipped" && fact.value === "2 paths"));
});

test("match rows group by file and the envelope's bracketed notice is not a match", () => {
	const parsed = parseMatches("a.ts:1:one\na.ts:2:two\nb.ts:9:three\n[read: bounded]");
	assert.equal(parsed.groups.length, 2);
	assert.equal(parsed.groups[0]?.total, 2);
	assert.equal(parsed.groups[1]?.rows[0]?.line, 9);
	assert.equal(parsed.dropped, 0);
});

test("read reports the past-end-of-file case instead of an empty body", () => {
	const card = presentTool(
		toolItem({
			title: "read",
			status: "completed",
			rawInput: { path: "/repo/a.ts", offset: 9000 },
			rawOutput: {
				result: { kind: "ok", output: "", details: { file: { bytes: 120 }, code: "read_past_eof", totalLines: 40 } },
				isError: false,
			},
		}),
	);
	assert.equal(card.body, "file");
	assert.equal(card.note, "The requested range starts past the end of the file (40 lines).");
	assert.ok(card.facts.some((fact) => fact.label === "size" && fact.value === "120 B"));
});

test("web_fetch facts read bytesRead, which is the key the tool actually sets", () => {
	const card = presentTool(
		toolItem({
			title: "web_fetch",
			status: "completed",
			rawInput: { url: "https://example.org/doc" },
			rawOutput: {
				result: {
					kind: "ok",
					output: "body",
					details: {
						url: "https://example.org/doc",
						status: 200,
						contentType: "text/html",
						bytesRead: 4096,
						truncated: true,
					},
				},
				isError: false,
			},
		}),
	);
	assert.ok(card.facts.some((fact) => fact.label === "status" && fact.value === "200"));
	assert.ok(card.facts.some((fact) => fact.label === "read" && fact.value === "4.0 KB"));
	assert.equal(card.note, "The fetched body was cut at the byte cap.");
});

test("the supervisor's oversized-record substitute does not crash the card and is named", () => {
	const card = presentTool(
		toolItem({ status: "completed", rawOutput: { truncated: true, snippet: '{"result":{"kind":"ok"' } }),
	);
	assert.equal(card.rawTruncated, true);
	assert.match(card.note ?? "", /larger than the 32 KiB wire limit/);
	assert.equal(card.output.text, '{"result":{"kind":"ok"');
});

test("a terminal frame carrying only content still produces output text", () => {
	const wire = readWire({ rawOutput: { content: [{ type: "content", content: { type: "text", text: "done" } }] } });
	assert.equal(wire.resultText, "done");
	assert.equal(wire.isError, false);
});

test("a call past the long-running threshold says so without being expanded", () => {
	const card = presentTool(toolItem({ status: "in_progress" }), { nowMs: 100_000, startedAtMs: 55_000 });
	assert.ok(card.facts.some((fact) => fact.label === "still running" && fact.value === "45s"));
	const quick = presentTool(toolItem({ status: "in_progress" }), { nowMs: 100_000, startedAtMs: 95_000 });
	assert.ok(!quick.facts.some((fact) => fact.label === "still running"));
});

test("byte and path helpers behave at their edges", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatBytes(undefined), "unknown size");
	assert.equal(basename("/a/b/c.ts"), "c.ts");
	assert.equal(basename("/a/b/"), "b");
	assert.equal(basename("c.ts"), "c.ts");
});

test("a shell result shows Clio Coder's operator copy, never the model-facing envelope", () => {
	const envelope =
		'[tool-result bounded]\nkind=ok capturedBytes=25 displayedBytes=25 truncated=false\nretrieve="narrow it"\nfollowUp="narrow it"\nfacts={"exitCode":0}\n2026-06-02 center -22.89\n';
	const card = presentTool(
		toolItem({
			title: "bash",
			toolKind: "execute",
			status: "completed",
			rawInput: { command: "python3 analyze.py" },
			rawOutput: {
				result: {
					content: [{ type: "text", text: envelope }],
					details: {
						exitCode: 0,
						resultDisposition: { presentation: { content: "2026-06-02 center -22.89\n" }, presentationTruncated: false },
					},
				},
				isError: false,
			},
		}),
	);
	assert.equal(card.output.text, "2026-06-02 center -22.89\n");
	assert.equal(card.output.truncated, false);
	assert.equal(stripResultEnvelope(envelope), "2026-06-02 center -22.89\n");
	assert.equal(
		stripResultEnvelope('all 12 passed\n[tool-result metadata]\nfacts={"exitCode":0}\nfollowUp="none"'),
		"all 12 passed\n",
	);
	assert.equal(stripResultEnvelope("[tool-result bounded]\nordinary text"), "[tool-result bounded]\nordinary text");
	assert.equal(stripResultEnvelope("[1, 2, 3]"), "[1, 2, 3]");
});

test("a folded row names the call in plain words and carries its one telling fact", () => {
	const run = presentTool(
		toolItem({
			status: "completed",
			rawInput: { command: "python3 analyze.py" },
			rawOutput: { result: { content: [{ type: "text", text: "ok\n" }], details: { exitCode: 2 } }, isError: false },
		}),
	);
	assert.equal(run.verb, "Run");
	assert.equal(run.digest, "exit 2");
	assert.equal(run.digestTone, "fail");
	const read = presentTool(
		toolItem({
			title: "read",
			toolKind: "read",
			status: "completed",
			rawInput: { path: "/repo/a.py" },
			rawOutput: {
				result: {
					content: [{ type: "text", text: "x" }],
					details: { file: { bytes: 5 }, observation: { unit: "lines", shownCount: 1 } },
				},
				isError: false,
			},
		}),
	);
	assert.equal(read.verb, "Read");
	assert.equal(read.digest, "1 line");
	assert.equal(describeTool(toolItem({ rawInput: { command: "make test" } })), "Run make test");
});

test("rows fold like Clio Coder's terminal: diffs stay visible, failures carry their last line", () => {
	assert.equal(toolOpensAtMount({ body: "diff", settled: true }), true);
	assert.equal(toolOpensAtMount({ body: "file", settled: true }), false);
	assert.equal(toolOpensAtMount({ body: "terminal", settled: false }), true, "a live command shows its output");
	assert.equal(toolOpensAtMount({ body: "terminal", settled: true }), false);
	const failed = presentTool(
		toolItem({
			title: "read",
			toolKind: "read",
			status: "failed",
			rawInput: { path: "missing.txt" },
			rawOutput: { result: { kind: "error", message: "read failed\nENOENT: no such file\n\n" }, isError: true },
		}),
	);
	assert.equal(failed.digest, "ENOENT: no such file");
	assert.equal(failed.digestTone, "fail");
	assert.equal(failureExcerpt("   \n"), null);
	assert.equal(failureExcerpt("x".repeat(200))?.length, FAILURE_EXCERPT_MAX);
});

// The registry's refusal ends with a line addressed to the model. The folded row must not echo it as
// the call's one fact, and a refusal is not a tool fault.
test("a call that was not approved says so on its row instead of echoing the refusal", () => {
	const refused = presentTool(
		toolItem({
			title: "write",
			toolKind: "edit",
			status: "failed",
			rawInput: { path: "/repo/fixture.txt", content: "approved\n" },
			rawOutput: {
				result: {
					kind: "error",
					message:
						"write blocked: write was not approved\nThis call was denied; no approval is pending.\nDo not retry the same call.",
				},
				isError: true,
			},
		}),
	);
	assert.equal(refused.statusLabel, "Not approved");
	assert.equal(refused.digest, null);
	assert.equal(refused.diff?.provenance, "rejected");
	assert.equal(refused.diff?.diff?.adds, 1, "the refused change stays readable");
	assert.equal(refused.failed, true);
});

test("a delegation whose run was stopped reads Stopped with a dash, not Failed", () => {
	const stopped = presentTool(
		toolItem({
			title: "dispatch",
			toolKind: "other",
			status: "failed",
			rawInput: { agent: "scout", task: "Survey the fixture" },
			rawOutput: {
				result: {
					content: [{ type: "text", text: "dispatch failed: run r1 was cancelled (operator_cancel)" }],
					details: { runId: "r1", outcome: "canceled", outcomeDetail: "operator_cancel" },
				},
				isError: true,
			},
		}),
	);
	assert.deepEqual(
		[stopped.statusLabel, stopped.tone, stopped.ended, stopped.digest],
		["Stopped", "neutral", true, null],
	);
	// A run that failed on its own is still a failure with its last line on the row.
	const failed = presentTool(
		toolItem({
			title: "dispatch",
			toolKind: "other",
			status: "failed",
			rawOutput: {
				result: { content: [{ type: "text", text: "worker exited 1" }], details: { outcome: "failed" } },
				isError: true,
			},
		}),
	);
	assert.deepEqual([failed.statusLabel, failed.tone, failed.ended], ["Failed", "fail", false]);
});
