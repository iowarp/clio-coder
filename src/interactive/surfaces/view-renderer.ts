import type { View, ViewBox, ViewTone, ViewTreeNode } from "../../domains/extensions/view.js";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { markdownTheme } from "../theme/components.js";
import { GLYPH } from "../theme/glyphs.js";
import { clioTheme } from "../theme/index.js";
import { frame, innerDivider, padAnsi, rule } from "../theme/rules.js";
import { dotSep } from "../theme/segments.js";
import type { ClioTheme, SemanticRole } from "../theme/tokens.js";

const TONE_ROLES = {
	neutral: "body",
	muted: "annotation",
	accent: "harnessAction",
	brand: "wordmark",
	positive: "success",
	warning: "warning",
	error: "error",
	info: "guidance",
} as const satisfies Record<ViewTone, SemanticRole>;

export interface ViewTarget {
	row: number;
	action: string;
	key?: string;
	hotkey?: string;
}

export interface RenderedView {
	lines: string[];
	targets: ViewTarget[];
}

const inline = (text: string): string => text.replaceAll("\n", " ").replaceAll("\t", "   ");
const cells = (value: number, fallback = 0): number =>
	Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
const empty = (): RenderedView => ({ lines: [], targets: [] });

function append(output: RenderedView, next: RenderedView): void {
	const offset = output.lines.length;
	output.targets.push(...next.targets.map((target) => ({ ...target, row: target.row + offset })));
	output.lines.push(...next.lines);
}

function sideBySide(parts: RenderedView[], widths: number[], gap: string): RenderedView {
	const output = empty();
	const height = Math.max(0, ...parts.map((part) => part.lines.length));
	for (let row = 0; row < height; row++) {
		output.lines.push(parts.map((part, index) => padAnsi(part.lines[row] ?? "", widths[index] ?? 0)).join(gap));
	}
	output.targets = parts.flatMap((part) => part.targets).sort((a, b) => a.row - b.row);
	return output;
}

function proportional(weights: number[], available: number): number[] {
	if (weights.length === 0) return [];
	const widths: number[] = weights.map(() => (available >= weights.length ? 1 : 0));
	let remaining = available - widths.reduce((sum, width) => sum + width, 0);
	const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
	for (let index = 0; index < weights.length; index++) {
		const share = Math.floor((remaining * (weights[index] ?? 1)) / total);
		widths[index] = (widths[index] ?? 0) + share;
	}
	remaining = available - widths.reduce((sum, width) => sum + width, 0);
	for (let index = 0; remaining > 0; index = (index + 1) % widths.length, remaining--) {
		widths[index] = (widths[index] ?? 0) + 1;
	}
	return widths;
}

/** Width preference before a parent decides whether columns are usable. */
function naturalWidth(view: View, width: number, theme: ClioTheme): number {
	if (view.t !== "box") return Math.max(1, ...draw(view, width, theme).lines.map(visibleWidth));
	if (view.width !== undefined) return Math.max(1, cells(view.width));
	const children = view.children.map((child) => naturalWidth(child, width, theme));
	const content =
		view.dir === "row"
			? children.reduce((sum, child) => sum + child, 0) + cells(view.gap ?? 0) * Math.max(0, children.length - 1)
			: Math.max(0, ...children);
	const border = view.border !== undefined && view.border !== "none" ? 4 : 0;
	return Math.min(width, Math.max(content, visibleWidth(inline(view.title ?? ""))) + border + cells(view.pad ?? 0) * 2);
}

function rowWidths(view: ViewBox, width: number, theme: ClioTheme): number[] | null {
	const available = width - cells(view.gap ?? 0) * Math.max(0, view.children.length - 1);
	const preferences = view.children.map((child) => Math.max(1, naturalWidth(child, width, theme)));
	const fixed = view.children.map((child) => child.t === "box" && child.width !== undefined);
	const grows = view.children.map((child) => (child.t === "box" ? Math.max(0, child.grow ?? 0) : 0));
	const minimum = preferences.map((preferred, index) => (fixed[index] ? preferred : Math.min(8, preferred)));
	if (minimum.reduce((sum, child) => sum + child, 0) > available) return null;
	const widths = [...minimum];
	let free = available - widths.reduce((sum, child) => sum + child, 0);
	for (let index = 0; index < widths.length; index++) {
		if (fixed[index] || (grows[index] ?? 0) > 0) continue;
		const add = Math.min(free, (preferences[index] ?? 0) - (widths[index] ?? 0));
		widths[index] = (widths[index] ?? 0) + add;
		free -= add;
	}
	const totalGrow = grows.reduce((sum, grow, index) => sum + (fixed[index] ? 0 : grow), 0);
	if (totalGrow > 0) {
		let assigned = 0;
		for (let index = 0; index < widths.length; index++) {
			const add = fixed[index] ? 0 : Math.floor((free * (grows[index] ?? 0)) / totalGrow);
			widths[index] = (widths[index] ?? 0) + add;
			assigned += add;
		}
		for (let index = 0; assigned < free; index = (index + 1) % widths.length) {
			if (!fixed[index] && (grows[index] ?? 0) > 0) {
				widths[index] = (widths[index] ?? 0) + 1;
				assigned++;
			}
		}
	}
	return widths;
}

function drawBox(view: ViewBox, width: number, theme: ClioTheme): RenderedView {
	const bordered = view.border !== undefined && view.border !== "none";
	const borderWidth = bordered ? 4 : 0;
	const pad = Math.min(cells(view.pad ?? 0), Math.max(0, Math.floor((width - borderWidth - 1) / 2)));
	const contentWidth = Math.max(1, width - borderWidth - pad * 2);
	const gap = cells(view.gap ?? 0);
	const widths = view.dir === "row" ? rowWidths(view, contentWidth, theme) : null;
	let output = empty();
	if (widths !== null) {
		output = sideBySide(
			view.children.map((child, index) => draw(child, widths[index] ?? 1, theme)),
			widths,
			" ".repeat(gap),
		);
	} else {
		for (const [index, child] of view.children.entries()) {
			if (index > 0) output.lines.push(...Array<string>(gap).fill(""));
			append(output, draw(child, contentWidth, theme));
		}
	}
	if (pad > 0) {
		output.lines = [
			...Array<string>(pad).fill(""),
			...output.lines.map((line) => `${" ".repeat(pad)}${line}${" ".repeat(pad)}`),
			...Array<string>(pad).fill(""),
		];
		output.targets = output.targets.map((target) => ({ ...target, row: target.row + pad }));
	}
	if (bordered) {
		output.lines = frame(theme, inline(view.title ?? ""), output.lines, width, {
			...(view.meta === undefined ? {} : { rightMeta: inline(view.meta) }),
		});
		if (view.border === "round") {
			output.lines[0] = output.lines[0]?.replace("┌", "╭").replaceAll("┐", "╮") ?? "";
			const last = output.lines.length - 1;
			output.lines[last] = output.lines[last]?.replace("└", "╰").replace("┘", "╯") ?? "";
		}
		output.targets = output.targets.map((target) => ({ ...target, row: target.row + 1 }));
	} else if (view.title !== undefined) {
		output.lines.unshift(
			rule(theme, width, {
				left: inline(view.title),
				...(view.meta === undefined ? {} : { right: inline(view.meta) }),
			}),
		);
		output.targets = output.targets.map((target) => ({ ...target, row: target.row + 1 }));
	}
	return output;
}

function draw(view: View, width: number, theme: ClioTheme): RenderedView {
	const output = empty();
	const paint = (text: string, tone: ViewTone = "neutral"): string => theme.fg(TONE_ROLES[tone], text);
	const wrapped = (text: string, tone: ViewTone = "neutral", columns = width): string[] =>
		text
			.replaceAll("\t", "   ")
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(paint(line, tone), Math.max(1, columns)));
	const target = (action: string | undefined, key: string, row = output.lines.length): void => {
		if (action !== undefined) output.targets.push({ row, action, key });
	};
	switch (view.t) {
		case "box":
			return drawBox(view, width, theme);
		case "text": {
			output.lines = view.text
				.replaceAll("\t", "   ")
				.split("\n")
				.flatMap((line) => {
					const styled = theme.style(TONE_ROLES[view.tone ?? "neutral"], line, {
						...(view.bold === undefined ? {} : { bold: view.bold }),
						...(view.dim === undefined ? {} : { dim: view.dim }),
					});
					return view.wrap === "truncate"
						? [truncateToWidth(styled, width, GLYPH.ellipsis)]
						: wrapTextWithAnsi(styled, Math.max(1, width));
				});
			output.lines = output.lines.map((line) => {
				const space = Math.max(0, width - visibleWidth(line));
				return `${" ".repeat(view.align === "right" ? space : view.align === "center" ? Math.floor(space / 2) : 0)}${line}`;
			});
			break;
		}
		case "markdown":
			output.lines = new Markdown(view.text, 0, 0, markdownTheme(theme))
				.render(Math.max(1, width))
				.map((line) => theme.base("body", line));
			break;
		case "kv": {
			const labelWidth = Math.min(
				Math.max(0, ...view.items.map((item) => visibleWidth(inline(item.label)))),
				Math.max(0, Math.floor(width / 2) - 1),
			);
			for (const item of view.items) {
				const prefix = `${padAnsi(theme.fg("fieldName", inline(item.label)), labelWidth)}  `;
				const values = item.value
					.replaceAll("\t", "   ")
					.split("\n")
					.flatMap((line) => wrapTextWithAnsi(paint(line, item.tone), Math.max(1, width - labelWidth - 2)));
				output.lines.push(...values.map((line, index) => `${index === 0 ? prefix : " ".repeat(labelWidth + 2)}${line}`));
			}
			break;
		}
		case "table": {
			const separator = width >= view.columns.length * 4 - 3 ? ` ${theme.fg("divider", GLYPH.rail)} ` : "";
			const weights = view.columns.map((column, index) =>
				Math.max(1, visibleWidth(inline(column)), ...view.rows.map((row) => visibleWidth(inline(row[index] ?? "")))),
			);
			const widths = proportional(weights, Math.max(0, width - visibleWidth(separator) * Math.max(0, weights.length - 1)));
			const row = (values: string[], header = false): string =>
				values
					.map((value, index) =>
						padAnsi(
							header ? theme.style("groupHeading", inline(value), { bold: true }) : paint(inline(value)),
							widths[index] ?? 0,
							GLYPH.ellipsis,
						),
					)
					.join(separator);
			output.lines.push(row(view.columns, true), innerDivider(theme, width));
			for (const [index, values] of view.rows.entries()) {
				target(view.action, view.keys?.[index] ?? String(index));
				output.lines.push(row(values));
			}
			break;
		}
		case "list":
			for (const item of view.items) {
				target(view.action, item.key);
				output.lines.push(...wrapped(`${inline(item.mark ?? GLYPH.toolHeader)} ${inline(item.label)}`, item.tone));
				if (item.detail !== undefined)
					output.lines.push(...wrapped(item.detail, "muted", width - 2).map((line) => `  ${line}`));
			}
			break;
		case "steps": {
			const states = {
				done: { mark: GLYPH.ok, tone: "positive" },
				active: { mark: GLYPH.cursor, tone: "accent" },
				todo: { mark: GLYPH.queued, tone: "muted" },
				blocked: { mark: GLYPH.phaseBlocked, tone: "warning" },
			} as const;
			const track = view.items
				.map((item) => paint(`${states[item.state].mark} ${inline(item.label)}`, states[item.state].tone))
				.join(theme.fg("divider", ` ${GLYPH.meterEmpty} `));
			output.lines = wrapTextWithAnsi(track, Math.max(1, width));
			break;
		}
		case "board": {
			const parallel = width >= 80;
			const widths = proportional(
				view.columns.map(() => 1),
				parallel ? Math.max(0, width - Math.max(0, view.columns.length - 1) * 3) : width,
			);
			const parts = view.columns.map((column, index) => {
				const part = empty();
				const columnWidth = parallel ? (widths[index] ?? width) : width;
				part.lines.push(
					rule(theme, columnWidth, {
						left: paint(inline(column.title), column.tone ?? "accent"),
						leftRaw: true,
					}),
				);
				for (const [at, card] of column.cards.entries()) {
					if (at > 0) part.lines.push("");
					if (view.action !== undefined) part.targets.push({ row: part.lines.length, action: view.action, key: card.key });
					part.lines.push(...wrapTextWithAnsi(paint(inline(card.title), card.tone), Math.max(1, columnWidth)));
					if (card.detail !== undefined)
						part.lines.push(
							...card.detail
								.replaceAll("\t", "   ")
								.split("\n")
								.flatMap((line) => wrapTextWithAnsi(paint(line, "muted"), Math.max(1, columnWidth))),
						);
					if (card.badges?.length)
						part.lines.push(
							...wrapTextWithAnsi(
								card.badges.map((badge) => paint(`[${inline(badge.text)}]`, badge.tone)).join(dotSep(theme)),
								Math.max(1, columnWidth),
							),
						);
				}
				return part;
			});
			if (parallel) return sideBySide(parts, widths, ` ${theme.fg("divider", GLYPH.rail)} `);
			for (const [index, part] of parts.entries()) {
				if (index > 0) output.lines.push("");
				append(output, part);
			}
			break;
		}
		case "tree": {
			const visit = (nodes: ViewTreeNode[], prefix: string): void => {
				for (const [index, node] of nodes.entries()) {
					const last = index === nodes.length - 1;
					const guide = `${prefix}${last ? "└─" : "├─"} `;
					target(view.action, node.key);
					const nodeWidth = Math.max(1, width - visibleWidth(guide));
					const labels = wrapTextWithAnsi(paint(inline(node.label), node.tone), nodeWidth);
					output.lines.push(
						...labels.map(
							(line, at) => `${theme.fg("divider", at === 0 ? guide : `${prefix}${last ? "   " : "│  "}`)}${line}`,
						),
					);
					const continuation = `${prefix}${last ? "   " : "│  "}`;
					if (node.detail !== undefined)
						output.lines.push(
							...node.detail
								.split("\n")
								.flatMap((line) => wrapTextWithAnsi(paint(inline(line), "muted"), nodeWidth))
								.map((line) => `${theme.fg("divider", continuation)}${line}`),
						);
					if (node.children) visit(node.children, continuation);
				}
			};
			visit(view.nodes, "");
			break;
		}
		case "progress": {
			const amount = `${view.value} / ${view.max}`;
			const label = view.label === undefined ? "" : `${inline(view.label)} `;
			const barWidth = Math.max(0, width - visibleWidth(label) - visibleWidth(amount) - 1);
			const filled = Math.min(barWidth, Math.max(0, Math.round((view.value / view.max) * barWidth)));
			output.lines.push(
				`${paint(label)}${paint(GLYPH.meterFull.repeat(filled), view.tone ?? "accent")}${theme.fg("divider", GLYPH.meterEmpty.repeat(barWidth - filled))} ${paint(amount)}`,
			);
			break;
		}
		case "spark": {
			const blocks = "▁▂▃▄▅▆▇█";
			const minimum = Math.min(...view.values);
			const maximum = Math.max(...view.values);
			const scale = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
			output.lines.push(
				paint(
					view.values
						.map((value) => {
							const fraction =
								maximum === minimum ? 0 : (value / scale - minimum / scale) / (maximum / scale - minimum / scale);
							return blocks[Math.min(7, Math.max(0, Math.round(fraction * 7)))];
						})
						.join(""),
					view.tone,
				),
			);
			break;
		}
		case "badge":
			output.lines.push(paint(`[${inline(view.text)}]`, view.tone));
			break;
		case "divider":
			output.lines.push(rule(theme, width));
			break;
		case "spacer":
			output.lines = Array<string>(Math.min(4, cells(view.size ?? 1))).fill("");
			break;
		case "actions":
			for (const item of view.items) {
				output.targets.push({
					row: output.lines.length,
					action: item.id,
					...(item.hotkey === undefined ? {} : { hotkey: item.hotkey }),
				});
				const hint = item.hotkey === undefined ? GLYPH.cursor : `[${item.hotkey}]`;
				output.lines.push(
					`${theme.fg("keyboardHint", hint)} ${paint(inline(item.label), item.primary ? "accent" : "neutral")}`,
				);
			}
			break;
		case "art":
			output.lines = view.lines.map((line) => paint(line.replaceAll("\t", "   "), view.tone));
			break;
	}
	return { ...output, lines: output.lines.map((line) => truncateToWidth(line, width, GLYPH.ellipsis)) };
}

export function renderView(view: View, width: number, options: { maxRows?: number } = {}): RenderedView {
	const safeWidth = cells(width);
	if (safeWidth === 0) return empty();
	const theme = clioTheme();
	const output = draw(view, safeWidth, theme);
	output.lines = output.lines.map((line) => truncateToWidth(line, safeWidth, GLYPH.ellipsis));
	if (options.maxRows !== undefined) {
		const maxRows = cells(options.maxRows);
		if (output.lines.length > maxRows) {
			const kept = Math.max(0, maxRows - 1);
			const cut = output.lines.length - kept;
			output.lines =
				maxRows === 0
					? []
					: [
							...output.lines.slice(0, kept),
							truncateToWidth(theme.fg(TONE_ROLES.muted, `${cut} row${cut === 1 ? "" : "s"} cut`), safeWidth, GLYPH.ellipsis),
						];
			output.targets = output.targets.filter((target) => target.row < kept);
		}
	}
	return output;
}
