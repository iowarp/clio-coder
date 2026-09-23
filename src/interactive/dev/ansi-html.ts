/**
 * Terminal frame to HTML, for reviewing transcript frames as images.
 *
 * Interprets the SGR subset Clio's theme emits (reset, bold, dim, italic,
 * underline, inverse, 256-color and truecolor foreground and background) and
 * drops every other escape sequence, OSC 133 prompt marks and OSC 8 links
 * included. Every non-ASCII grapheme sits in a fixed-width cell of its
 * terminal width, so a glyph the browser draws from a fallback font cannot
 * shift the columns after it: the image keeps the terminal's grid.
 */

import { visibleWidth } from "../../engine/tui.js";

interface Style {
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
}

const BASIC = [
	"#1d1f21",
	"#cc6666",
	"#b5bd68",
	"#f0c674",
	"#81a2be",
	"#b294bb",
	"#8abeb7",
	"#c5c8c6",
	"#666666",
	"#d54e53",
	"#b9ca4a",
	"#e7c547",
	"#7aa6da",
	"#c397d8",
	"#70c0b1",
	"#eaeaea",
];

function xterm256(index: number): string {
	if (index < 16) return BASIC[index] ?? "#c5c8c6";
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return rgb(level, level, level);
	}
	const cube = index - 16;
	const scale = [0, 95, 135, 175, 215, 255];
	return rgb(scale[Math.floor(cube / 36)] ?? 0, scale[Math.floor(cube / 6) % 6] ?? 0, scale[cube % 6] ?? 0);
}

function rgb(r: number, g: number, b: number): string {
	return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function applySgr(style: Style, params: number[]): Style {
	const next = { ...style };
	const codes = params.length === 0 ? [0] : params;
	for (let i = 0; i < codes.length; i += 1) {
		const code = codes[i] ?? 0;
		if (code === 0) {
			for (const key of Object.keys(next)) delete next[key as keyof Style];
		} else if (code === 1) next.bold = true;
		else if (code === 2) next.dim = true;
		else if (code === 3) next.italic = true;
		else if (code === 4) next.underline = true;
		else if (code === 7) next.inverse = true;
		else if (code === 22) {
			delete next.bold;
			delete next.dim;
		} else if (code === 23) delete next.italic;
		else if (code === 24) delete next.underline;
		else if (code === 27) delete next.inverse;
		else if (code === 39) delete next.fg;
		else if (code === 49) delete next.bg;
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
			next.fg = xterm256(code >= 90 ? code - 82 : code - 30);
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
			next.bg = xterm256(code >= 100 ? code - 92 : code - 40);
		else if (code === 38 || code === 48) {
			const mode = codes[i + 1];
			let color: string | undefined;
			if (mode === 2) {
				color = rgb(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
				i += 4;
			} else if (mode === 5) {
				color = xterm256(codes[i + 2] ?? 0);
				i += 2;
			}
			if (color !== undefined) {
				if (code === 38) next.fg = color;
				else next.bg = color;
			}
		}
	}
	return next;
}

function escapeHtml(text: string): string {
	return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function styleCss(style: Style, palette: { fg: string; bg: string }): string {
	let fg = style.fg ?? palette.fg;
	let bg = style.bg;
	if (style.inverse) {
		const swapped = bg ?? palette.bg;
		bg = fg;
		fg = swapped;
	}
	const rules = [`color:${fg}`];
	if (bg !== undefined) rules.push(`background:${bg}`);
	if (style.bold) rules.push("font-weight:700");
	if (style.dim) rules.push("opacity:.6");
	if (style.italic) rules.push("font-style:italic");
	if (style.underline) rules.push("text-decoration:underline");
	return rules.join(";");
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function cells(text: string): string {
	let out = "";
	for (const { segment } of SEGMENTER.segment(text)) {
		const code = segment.codePointAt(0) ?? 0;
		if (segment.length === 1 && code < 0x7f) {
			out += escapeHtml(segment);
			continue;
		}
		const width = Math.max(1, visibleWidth(segment));
		out += `<span class="c" style="width:${width}ch">${escapeHtml(segment)}</span>`;
	}
	return out;
}

/** One terminal row as HTML spans. */
function lineToHtml(line: string, palette: { fg: string; bg: string }): string {
	let style: Style = {};
	let html = "";
	let run = "";
	const flush = () => {
		if (run.length === 0) return;
		html += `<span style="${styleCss(style, palette)}">${cells(run)}</span>`;
		run = "";
	};
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === ESC) {
			const next = line[i + 1];
			if (next === "[") {
				let j = i + 2;
				while (j < line.length && !/[@-~]/u.test(line[j] ?? "")) j += 1;
				const final = line[j];
				if (final === "m") {
					flush();
					const params = line
						.slice(i + 2, j)
						.split(/[;:]/u)
						.filter((part) => part.length > 0)
						.map((part) => Number.parseInt(part, 10));
					style = applySgr(style, params);
				}
				i = j + 1;
				continue;
			}
			if (next === "]") {
				let j = i + 2;
				while (j < line.length && line[j] !== BEL && !(line[j] === ESC && line[j + 1] === "\\")) j += 1;
				i = line[j] === BEL ? j + 1 : j + 2;
				continue;
			}
			i += 2;
			continue;
		}
		run += ch;
		i += 1;
	}
	flush();
	return html;
}

export interface FrameHtmlOptions {
	title: string;
	columns: number;
	/** Background and default foreground of the rendered terminal. */
	background?: string;
	foreground?: string;
}

/** A standalone page holding several labeled frames, each a fixed-width terminal grid. */
export function framesToHtml(
	frames: ReadonlyArray<{ label: string; columns: number; lines: readonly string[] }>,
	options: { title: string; background?: string; foreground?: string },
): string {
	const palette = { fg: options.foreground ?? "#c9d1d3", bg: options.background ?? "#12181b" };
	const sections = frames
		.map((frame) => {
			const rows = frame.lines.map((line) => `<div class="r">${lineToHtml(line, palette) || "&nbsp;"}</div>`).join("");
			return `<section><h2>${escapeHtml(frame.label)}</h2><div class="t" style="width:${frame.columns}ch">${rows}</div></section>`;
		})
		.join("\n");
	return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(options.title)}</title>
<style>
body{margin:0;padding:16px;background:#0b0f11;color:#9aa;font:12px/1.4 system-ui,sans-serif}
section{margin:0 0 20px}
h2{font:600 12px/1.4 system-ui,sans-serif;margin:0 0 6px;color:#7c8a90}
.t{font:14px/18px "DejaVu Sans Mono","Liberation Mono",monospace;background:${palette.bg};color:${palette.fg};padding:8px 10px;box-sizing:content-box;white-space:pre;overflow:hidden;border:1px solid #20292d}
.r{height:18px;white-space:pre}
.c{display:inline-block;text-align:center;overflow:visible}
</style>
${sections}
`;
}
