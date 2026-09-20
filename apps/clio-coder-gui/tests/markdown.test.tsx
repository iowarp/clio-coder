import { deepEqual, doesNotMatch, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { openEnclosingDetails, type RevealTarget } from "../client/render/details.js";
import { Blocks, CodeBlock, decodeEntities, MarkdownContent, MermaidBlock } from "../client/render/Markdown.js";
import {
	codeLanguage,
	IncrementalMarkdown,
	lexMarkdown,
	MERMAID_MAX_LINES,
	MERMAID_MAX_SOURCE_BYTES,
	mermaidSourceProblem,
	safeHref,
	settledBoundary,
	tokenText,
} from "../client/render/markdown.js";

function renderMarkdown(source: string, complete = true): string {
	return renderToStaticMarkup(<MarkdownContent source={source} complete={complete} />);
}

// JSX string attributes collapse a literal newline to a space, so multi-line sources are expressions.
const TWO_LINES = "const a = 1;\nconst b = 2;";
const FLOWCHART = "flowchart LR\n  A --> B";

test("links are live only for http, https, and mailto", () => {
	equal(safeHref("https://example.org/a?b=1#c"), "https://example.org/a?b=1#c");
	equal(safeHref("http://example.org"), "http://example.org/");
	equal(safeHref("mailto:someone@example.org"), "mailto:someone@example.org");
	equal(safeHref("javascript:alert(1)"), null);
	equal(safeHref("JAVASCRIPT:alert(1)"), null);
	equal(safeHref("data:text/html;base64,PHNjcmlwdD4="), null);
	equal(safeHref("vbscript:x"), null);
	equal(safeHref("file:///etc/passwd"), null);
	equal(safeHref("/relative/path"), null);
	equal(safeHref("relative.md"), null);
	equal(safeHref(""), null);
	equal(safeHref(`https://example.org/${"a".repeat(3_000)}`), null);
});

test("fence info strings normalize to a label and a known grammar or none", () => {
	equal(codeLanguage("ts").grammar, "typescript");
	equal(codeLanguage("TypeScript {highlight}").grammar, "typescript");
	equal(codeLanguage("py").grammar, "python");
	equal(codeLanguage("sh").grammar, "bash");
	equal(codeLanguage("c++").grammar, "cpp");
	equal(codeLanguage("html").grammar, "markup");
	deepEqual(codeLanguage("atlasql"), { label: "atlasql", grammar: null, mermaid: false });
	deepEqual(codeLanguage(undefined), { label: null, grammar: null, mermaid: false });
	deepEqual(codeLanguage("   "), { label: null, grammar: null, mermaid: false });
	deepEqual(codeLanguage("mermaid"), { label: "mermaid", grammar: null, mermaid: true });
	deepEqual(codeLanguage("Mermaid title"), { label: "mermaid", grammar: null, mermaid: true });
	equal(codeLanguage("<script>alert(1)</script>").label, "scriptalert1script");
	equal(codeLanguage("x".repeat(100)).label?.length, 24);
});

test("a settled boundary follows a blank line outside fences and never splits a list continuation", () => {
	equal(settledBoundary("para one\n\npara two"), "para one\n\n".length, "one character of the next line decides");
	equal(settledBoundary("para one\n\n"), 0, "nothing follows the blank line yet");
	equal(settledBoundary("para one\n\n "), 0, "a leading space may be an indented continuation");
	equal(settledBoundary("para one\n\npara two\n\n"), "para one\n\n".length);
	const open = "intro\n\n```ts\nconst a = 1;\n\nconst b";
	equal(settledBoundary(open), "intro\n\n".length, "a blank line inside an open fence is not a boundary");
	const fenced = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter\n";
	equal(settledBoundary(fenced), fenced.length - "after\n".length, "the boundary after the closed fence is usable");
	const closed = `${fenced}\ntrailing\n`;
	equal(settledBoundary(closed), fenced.length + 1);
	const list = "1. one\n\n   continued\n\n2. two\n\nnext\n";
	equal(settledBoundary(list), "1. one\n\n   continued\n\n2. two\n\n".length);
	const table = "| a |\n|---|\n\n| b |\n\nx\n";
	equal(settledBoundary(table), "| a |\n|---|\n\n| b |\n\n".length);
	equal(settledBoundary("a\n\n\nb\n\nc\n"), "a\n\n\nb\n\n".length, "consecutive blank lines settle at the last one");
	equal(
		settledBoundary("a\n\nb\n\nc\n", "a\n\n".length),
		"a\n\nb\n\n".length,
		"scanning resumes from an earlier boundary",
	);
});

test("incremental lexing keeps settled token identity and re-lexes only the tail", () => {
	const incremental = new IncrementalMarkdown();
	const first = incremental.update("# Title\n\nParagraph one that is still bei");
	equal(first.settledLength, "# Title\n\n".length);
	equal(first.settled.length, 2, "the heading and the blank-line space token settled");
	equal(first.settled[0]?.type, "heading");
	equal(first.tail[0]?.type, "paragraph");

	const second = incremental.update("# Title\n\nParagraph one that is still being written");
	ok(second.settled === first.settled, "settled tokens keep their identity while only the tail grows");
	equal(second.settledLength, first.settledLength);

	const third = incremental.update("# Title\n\nParagraph one that is still being written.\n\n- item\n");
	ok(third.settled !== second.settled);
	equal(third.settled.length, 4, "heading, space, paragraph, and space settled");
	equal(third.tail[0]?.type, "list");

	const restarted = incremental.update("Completely different text");
	equal(restarted.settledLength, 0);
	equal(restarted.settled.length, 0);
	equal(restarted.tail[0]?.type, "paragraph");
});

test("partial streamed Markdown renders what has arrived without throwing", () => {
	const partial = renderMarkdown("## Results\n\n| Level | Cells |\n| --- | ---: |\n| L0 | 12,8", false);
	match(partial, /<h3 class="md-heading md-heading--2">Results<\/h3>/u);
	match(partial, /<table>/u);
	match(partial, /12,8/u);
	const unterminated = renderMarkdown("Some text\n\n```ts\nconst a = 1;\nconst b", false);
	match(unterminated, /class="code-block is-streaming"/u);
	match(unterminated, /code-block__cursor/u);
	match(unterminated, /const b<span class="code-block__cursor"/u);
	match(unterminated, /<span class="code-block__lang">ts<\/span>/u);
});

test("completed Markdown renders headings, lists, task lists, tables, quotes, rules, and inline marks", () => {
	const html = renderMarkdown(
		[
			"# Title",
			"",
			"Some **bold** and *em* and ~~gone~~ and `code` text.",
			"",
			"1. first",
			"   - nested",
			"   - [x] done task",
			"2. second",
			"",
			"> quoted",
			"",
			"---",
			"",
			"| a | b |",
			"| :-- | --: |",
			"| 1 | 2 |",
			"",
		].join("\n"),
	);
	match(html, /<h2 class="md-heading md-heading--1">Title<\/h2>/u);
	match(html, /<strong>bold<\/strong>/u);
	match(html, /<em>em<\/em>/u);
	match(html, /<del>gone<\/del>/u);
	match(html, /<code>code<\/code>/u);
	match(html, /<ol class="md-list">/u);
	match(html, /<ul class="md-list md-list--tasks">/u);
	match(
		html,
		/<li class="md-task-item"><input type="checkbox" class="md-task"[^>]*disabled=""[^>]*checked=""\/>done task<\/li>/u,
	);
	match(html, /<blockquote><p>quoted<\/p><\/blockquote>/u);
	match(html, /<hr\/>/u);
	match(html, /<th scope="col" style="text-align:left">a<\/th>/u);
	match(html, /<td style="text-align:right">2<\/td>/u);
	ok(!html.includes("undefined"));
});

test("hostile Markdown never becomes markup, a live unsafe link, or a fetched image", () => {
	const html = renderMarkdown(
		[
			"Raw <script>alert(1)</script> and <img src=x onerror=alert(1)> here.",
			"",
			'<div onclick="alert(1)">block html</div>',
			"",
			'[bad](javascript:alert(1)) [data](data:text/html,x) [ok](https://example.org/ok "Title")',
			"",
			"![tracker](https://evil.example/x.png)",
			"",
			"<https://example.org/auto> and https://example.org/bare",
		].join("\n"),
	);
	ok(!html.includes("<script"), "script tags must be text");
	ok(!html.includes("<img"), "images are never emitted");
	ok(!html.includes("<div onclick"), "block html is text");
	match(html, /&lt;div onclick=/u);
	ok(!html.includes(' onerror="'), "event attributes cannot survive as attributes");
	match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
	ok(!html.includes("javascript:"), "unsafe schemes never reach an href");
	ok(!html.includes("data:text"), "data URLs never reach an href");
	match(html, /<span class="md-html">&lt;script&gt;<\/span>alert\(1\)<span class="md-html">&lt;\/script&gt;<\/span>/u);
	match(html, /<span class="md-link md-link--blocked"[^>]*>bad<\/span>/u);
	match(
		html,
		/<a class="md-link" href="https:\/\/example\.org\/ok" target="_blank" rel="noopener noreferrer" title="Title">ok<\/a>/u,
	);
	match(html, /<span class="md-image"[^>]*>\[image: tracker\]<\/span>/u);
	match(html, /href="https:\/\/example\.org\/auto"/u);
	match(html, /href="https:\/\/example\.org\/bare"/u);
});

test("fenced code renders a label, a copy control, a line count, and plain text for unknown languages", () => {
	const known = renderToStaticMarkup(<CodeBlock code={TWO_LINES} info="ts" settled />);
	match(known, /class="code-block is-settled"/u);
	match(known, /data-language="typescript"/u);
	match(known, /<span class="code-block__lang">ts<\/span>/u);
	match(known, /2 lines/u);
	match(known, /<button type="button" class="code-block__copy is-idle"[^>]*>Copy<\/button>/u);
	match(known, /<pre tabindex="0"><code class="language-typescript">const a = 1;\nconst b = 2;<\/code><\/pre>/u);

	const unknown = renderToStaticMarkup(<CodeBlock code="SELECT 1;" info="atlasql" settled />);
	match(unknown, /<span class="code-block__lang">atlasql<\/span>/u);
	match(unknown, /<code>SELECT 1;<\/code>/u);
	ok(!unknown.includes("data-language"));

	const bare = renderToStaticMarkup(<CodeBlock code="" info={undefined} settled />);
	match(bare, /<span class="code-block__lang">text<\/span>/u);
	match(bare, /0 lines/u);
});

test("code with markup-like content stays escaped inside the block", () => {
	const html = renderToStaticMarkup(<CodeBlock code="<script>alert('x')</script>" info="html" settled />);
	ok(!html.includes("<script>"));
	match(html, /&lt;script&gt;alert\(&#x27;x&#x27;\)&lt;\/script&gt;/u);
});

test("Mermaid blocks wait for settled source, bound size, and show the source with the failure", () => {
	const pending = renderToStaticMarkup(<MermaidBlock source={FLOWCHART} settled={false} />);
	match(pending, /class="diagram is-pending"/u);
	match(pending, /renders once this response settles/u);
	match(pending, /<code class="language-mermaid">flowchart LR\n {2}A --&gt; B<\/code>/u);

	const rendering = renderToStaticMarkup(<MermaidBlock source={FLOWCHART} settled />);
	match(rendering, /class="diagram is-rendering"/u);
	match(rendering, /Copy source/u);
	ok(!rendering.includes("dangerouslySetInnerHTML"));

	const oversized = renderToStaticMarkup(
		<MermaidBlock source={`flowchart LR\n${"  A --> B\n".repeat(MERMAID_MAX_LINES + 1)}`} settled />,
	);
	match(oversized, /class="diagram is-bounded"/u);
	match(oversized, new RegExp(`renders at most ${MERMAID_MAX_LINES}`, "u"));

	equal(mermaidSourceProblem("   "), "The diagram is empty.");
	match(mermaidSourceProblem(`flowchart LR\n${"x".repeat(MERMAID_MAX_SOURCE_BYTES)}`) ?? "", /larger than 16 KiB/u);
	equal(mermaidSourceProblem("flowchart LR\n  A --> B"), null);
});

test("a Markdown document with a Mermaid fence routes that block to the diagram figure", () => {
	const html = renderMarkdown("Before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter\n");
	match(html, /<figure class="diagram is-rendering"/u);
	match(html, /aria-label="Mermaid diagram"/u);
	ok(!html.includes('class="code-block is-'), "the fence is a figure, not a code block");
});

test("Markdown entity references and long content render without markup or crashes", () => {
	equal(decodeEntities("a &amp; b &lt; c &#65; &#x42; &copy; &unknown;"), "a & b < c A B © &unknown;");
	const long = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} with **bold** text and \`code\`.`).join(
		"\n\n",
	);
	const html = renderMarkdown(long);
	equal((html.match(/<p>/gu) ?? []).length, 400);
	equal(tokenText(lexMarkdown("a **b** `c` [d](https://e)")).trim(), "a b c d");
});

test("block rendering tolerates unknown token shapes instead of crashing the transcript", () => {
	const html = renderToStaticMarkup(
		<Blocks tokens={[{ type: "mystery", raw: "??" } as never, { type: "space", raw: "\n" } as never]} settled />,
	);
	match(html, /<p>\?\?<\/p>/u);
});

function renderDocument(source: string): string {
	return renderToStaticMarkup(<MarkdownContent source={source} complete documentLinks={{}} />);
}

const SECTION = [
	"<details>",
	"<summary>More about **caching**</summary>",
	"",
	"## Inside heading",
	"",
	"| a | b |",
	"| --- | --- |",
	"| 1 | 2 |",
	"",
	"```ts",
	"const x = 1;",
	"```",
	"",
	"</details>",
	"",
	"After.",
].join("\n");

test("documents fold <details> into a native section with its Markdown intact", () => {
	const html = renderDocument(SECTION);
	match(html, /<details class="md-details"><summary>More about \*\*caching\*\*<\/summary>/);
	match(html, /<div class="md-details__body">/);
	match(html, /<h3[^>]*id="inside-heading"[^>]*>Inside heading<\/h3>/);
	match(html, /<table>/);
	match(html, /const/);
	// The section closes before the paragraph that follows it.
	ok(html.indexOf("</details>") < html.indexOf("After."), "the closing tag ends the section");
	ok(!html.includes("&lt;details"), "no tag is shown as text");
});

test("a section is open only when the source says so, and nests", () => {
	equal(
		renderDocument("<details>\n<summary>A</summary>\n\nx\n\n</details>").includes('<details class="md-details" open'),
		false,
	);
	match(
		renderDocument("<details open>\n<summary>A</summary>\n\nx\n\n</details>"),
		/<details class="md-details" open="">/,
	);
	const nested = renderDocument(
		"<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ndeep\n\n</details>\n\nouter tail\n\n</details>\n\nafter",
	);
	equal(nested.match(/<details /g)?.length, 2);
	ok(
		nested.indexOf("deep") < nested.indexOf("outer tail") &&
			nested.indexOf("outer tail") < nested.lastIndexOf("</details>"),
	);
	ok(nested.indexOf("</details>", nested.indexOf("outer tail")) < nested.indexOf("after"), "after sits outside both");
	// GitHub runs an unclosed section to the end of the file.
	match(
		renderDocument("<details>\n<summary>Open ended</summary>\n\nstill inside"),
		/<details class="md-details"><summary>Open ended<\/summary>[\s\S]*still inside/,
	);
});

test("only the section survives: attributes, script and other raw HTML never reach the page", () => {
	const html = renderDocument(
		'<details class="x" style="position:fixed" onclick="alert(1)" id="steal">\n<summary><img src=x onerror="alert(1)">Label &amp; <b>bold</b></summary>\n\nbody\n\n</details>',
	);
	match(html, /<details class="md-details"><summary>Label &amp; bold<\/summary>/);
	for (const forbidden of [/onclick/, /onerror/, /style=/, /id="steal"/, /<img/, /<b>/, /<script/i])
		doesNotMatch(html, forbidden);
	const script = renderDocument("<details>\n<summary>x</summary>\n\n<script>alert(1)</script>\n\n</details>");
	doesNotMatch(script, /<script/i);
	match(renderDocument("<details>\n\ntext\n\n</details>"), /<summary>Details<\/summary>/);
	// The whole section may sit in one HTML block, as on one line of source.
	match(
		renderDocument("<details><summary>One line</summary>tucked in</details>"),
		/<summary>One line<\/summary>[\s\S]*tucked in/,
	);
});

test("outside documents the same HTML stays text", () => {
	const html = renderToStaticMarkup(<MarkdownContent source={SECTION} complete />);
	doesNotMatch(html, /<details/);
	match(html, /&lt;details&gt;/);
});

test("a link to a heading inside collapsed sections opens every section around it", () => {
	interface Node extends RevealTarget {
		open?: boolean;
	}
	const node = (tagName: string, parentElement: Node | null, open?: boolean): Node =>
		open === undefined ? { tagName, parentElement } : { tagName, parentElement, open };
	const page = node("DIV", null);
	const outer = node("DETAILS", page, false);
	const inner = node("details", outer, false);
	const alreadyOpen = node("DETAILS", inner, true);
	const heading = node("H3", alreadyOpen);
	equal(openEnclosingDetails(heading), 2);
	equal(outer.open && inner.open, true);
	equal(openEnclosingDetails(heading), 0, "nothing left to open");
	equal(openEnclosingDetails(null), 0);
	// A section that is itself the target stays as the reader left it.
	const closed = node("DETAILS", page, false);
	equal(openEnclosingDetails(closed), 0);
	equal(closed.open, false);
});

test("a table sits in a scroll wrapper that is a plain, unfocused block until it measures as overflowing", () => {
	const html = renderDocument("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
	match(html, /<div class="md-table"><table>/);
	doesNotMatch(html, /tabindex|role="region"/i, "a table that fits adds no Tab stop or landmark");
});
