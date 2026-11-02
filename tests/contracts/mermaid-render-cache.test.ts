import { match, notStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createMermaidMarkdownTransform } from "../../src/interactive/renderers/mermaid.js";
import { createClioTheme } from "../../src/interactive/theme/tokens.js";

const diagram = "```mermaid\nflowchart LR\nA[Prompt] --> B[Model] --> C[Tool]\n```\n\n";

test("reusing a diagram layout preserves output as prose grows and the terminal resizes", () => {
	const theme = createClioTheme({ color: false });
	const transform = createMermaidMarkdownTransform(theme);
	for (const width of [120, 40, 12, 120]) {
		for (const suffix of ["", "More words", "More words\n\nAnother paragraph."]) {
			strictEqual(transform(diagram + suffix, width), createMermaidMarkdownTransform(theme)(diagram + suffix, width));
		}
	}
	const edited = diagram.replace("Tool", "Result");
	notStrictEqual(transform(edited, 120), transform(diagram, 120));
	strictEqual(transform(edited, 120), createMermaidMarkdownTransform(theme)(edited, 120));
});

test("cached geometry still paints with the current theme", () => {
	const base = createClioTheme({ color: false });
	let palette = "first";
	const theme = { ...base, fg: (token: string, text: string) => `${palette}:${token}:${text}` };
	const transform = createMermaidMarkdownTransform(theme);
	const initial = transform(diagram, 120);
	palette = "second";
	const changed = transform(diagram, 120);
	notStrictEqual(changed, initial);
	strictEqual(changed, createMermaidMarkdownTransform(theme)(diagram, 120));
});

test("cached failed layouts only explain fallback when the fence closes", () => {
	const transform = createMermaidMarkdownTransform(createClioTheme({ color: false }));
	const open = "```mermaid\nnot a supported diagram\n";
	strictEqual(transform(open, 80), open);
	match(transform(`${open}\`\`\`\n`, 80), /Mermaid diagram shown as source: it could not be drawn/u);
	strictEqual(transform(open, 80), open);
});

test("evicting older layouts preserves the result when they are revisited", () => {
	const theme = createClioTheme({ color: false });
	const transform = createMermaidMarkdownTransform(theme);
	const first = transform(diagram, 120);
	for (let index = 0; index < 24; index++) transform(diagram.replace("Prompt", `Prompt ${index}`), 120);
	strictEqual(transform(diagram, 120), first);
});
