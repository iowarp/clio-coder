/**
 * Terminal ANSI to HTML conversion adapted from pi-coding-agent 0.84.0's
 * `dist/core/export-html/ansi-to-html.js`.
 *
 * Clio's transcript also contains OSC 133 shell-integration markers and may
 * contain other non-SGR terminal controls. Those controls are discarded here;
 * only SGR presentation survives as inline HTML styles.
 */

const ANSI_COLORS = [
	"rgb(0,0,0)",
	"rgb(128,0,0)",
	"rgb(0,128,0)",
	"rgb(128,128,0)",
	"rgb(0,0,128)",
	"rgb(128,0,128)",
	"rgb(0,128,128)",
	"rgb(192,192,192)",
	"rgb(128,128,128)",
	"rgb(255,0,0)",
	"rgb(0,255,0)",
	"rgb(255,255,0)",
	"rgb(0,0,255)",
	"rgb(255,0,255)",
	"rgb(0,255,255)",
	"rgb(255,255,255)",
] as const;

interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

function color256ToHex(index: number): string {
	const bounded = Math.max(0, Math.min(255, index));
	if (bounded < 16) return ANSI_COLORS[bounded] ?? ANSI_COLORS[0];
	if (bounded < 232) {
		const cubeIndex = bounded - 16;
		const component = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
		return `rgb(${component(Math.floor(cubeIndex / 36))},${component(Math.floor((cubeIndex % 36) / 6))},${component(cubeIndex % 6)})`;
	}
	const gray = 8 + (bounded - 232) * 10;
	return `rgb(${gray},${gray},${gray})`;
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&#039;");
}

function createEmptyStyle(): TextStyle {
	return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

function styleToInlineCss(style: TextStyle): string {
	const parts: string[] = [];
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

function applySgrCode(params: number[], style: TextStyle): void {
	let index = 0;
	while (index < params.length) {
		const code = params[index] ?? 0;
		if (code === 0) Object.assign(style, createEmptyStyle());
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 22) {
			style.bold = false;
			style.dim = false;
		} else if (code === 23) style.italic = false;
		else if (code === 24) style.underline = false;
		else if (code >= 30 && code <= 37) style.fg = ANSI_COLORS[code - 30] ?? null;
		else if (code === 38) {
			if (params[index + 1] === 5 && params[index + 2] !== undefined) {
				style.fg = color256ToHex(params[index + 2] ?? 0);
				index += 2;
			} else if (params[index + 1] === 2 && params[index + 4] !== undefined) {
				style.fg = `rgb(${params[index + 2]},${params[index + 3]},${params[index + 4]})`;
				index += 4;
			}
		} else if (code === 39) style.fg = null;
		else if (code >= 40 && code <= 47) style.bg = ANSI_COLORS[code - 40] ?? null;
		else if (code === 48) {
			if (params[index + 1] === 5 && params[index + 2] !== undefined) {
				style.bg = color256ToHex(params[index + 2] ?? 0);
				index += 2;
			} else if (params[index + 1] === 2 && params[index + 4] !== undefined) {
				style.bg = `rgb(${params[index + 2]},${params[index + 3]},${params[index + 4]})`;
				index += 4;
			}
		} else if (code === 49) style.bg = null;
		else if (code >= 90 && code <= 97) style.fg = ANSI_COLORS[code - 90 + 8] ?? null;
		else if (code >= 100 && code <= 107) style.bg = ANSI_COLORS[code - 100 + 8] ?? null;
		index += 1;
	}
}

// CSI, OSC, DCS/SOS/PM/APC, and single-character ESC sequences. SGR CSI
// sequences are interpreted; every other terminal control is removed.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const TERMINAL_SEQUENCE = new RegExp(
	`${ESC}(?:\\[([0-?]*[ -/]*)([@-~])|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[PX^_][\\s\\S]*?${ESC}\\\\|[@-_])`,
	"gu",
);

export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let spanOpen = false;
	TERMINAL_SEQUENCE.lastIndex = 0;
	let match = TERMINAL_SEQUENCE.exec(text);
	while (match !== null) {
		result += escapeHtml(text.slice(lastIndex, match.index));
		if (match[2] === "m") {
			if (spanOpen) result += "</span>";
			const raw = match[1] ?? "";
			const params = raw.length > 0 ? raw.split(";").map((part) => Number.parseInt(part, 10) || 0) : [0];
			applySgrCode(params, style);
			spanOpen = hasStyle(style);
			if (spanOpen) result += `<span style="${styleToInlineCss(style)}">`;
		}
		lastIndex = match.index + match[0].length;
		match = TERMINAL_SEQUENCE.exec(text);
	}
	result += escapeHtml(text.slice(lastIndex));
	if (spanOpen) result += "</span>";
	// A raw C0 control is never meaningful inside the exported document. Tabs
	// remain useful in preformatted tool output and are safe in HTML text.
	return Array.from(result)
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code === 9 || (code >= 32 && code !== 127);
		})
		.join("");
}

export function ansiLinesToHtml(lines: ReadonlyArray<string>): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("\n");
}
