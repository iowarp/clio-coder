/**
 * The `§` rows a skill writes into the transcript outside its own load call:
 * a change to the tool surface it armed, and the model suggesting a skill
 * for the operator to run. They share the knowledge class mark and the
 * action row's hanging wrap, so a skill's state reads like the act it is.
 *
 * Pure: the live panel renders a surface change from its notice, and replay
 * renders the persisted change through the same function.
 */

import type { SkillSurfaceChange } from "../../core/skill-activation.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { clioTheme, GLYPH } from "../theme/index.js";

const theme = clioTheme();
const dim = (text: string): string => theme.fg("dim", text);
const verb = (text: string): string => theme.style("tool", text, { bold: true });
const command = (text: string): string => theme.fg("accent", text);
const skillNames = (names: ReadonlyArray<string>): string =>
	names.map((name) => theme.fg("accent", sanitizeCallTargetText(name))).join(dim(", "));
const MARK = dim(`${GLYPH.classKnowledge} `);

/** A row too long for the terminal hangs its continuation in the content column. */
function hanging(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	return wrapTextWithAnsi(line, Math.max(1, width - 2)).map((row, index) => (index === 0 ? row : `  ${row}`));
}

/**
 * One row per change of the armed surface: `§ tdd armed · read, edit, bash ·
 * /skill off`, `§ tdd replaced by perf`, `§ skill surface cleared`. A skill
 * that loaded without narrowing anything changed no surface and has no row.
 */
export function renderSkillSurfaceRow(change: SkillSurfaceChange, width: number): string[] {
	if (change.state === "loaded") return [];
	if (change.state === "cleared") return hanging(`${MARK}${dim("skill surface")} ${verb("cleared")}`, width);
	if (change.state === "replaced") {
		return hanging(
			`${MARK}${skillNames(change.previous)} ${verb("replaced")} ${dim("by")} ${skillNames(change.names)}`,
			width,
		);
	}
	const tools =
		change.allowedTools.length > 0
			? change.allowedTools.join(", ")
			: change.disallowedTools.length > 0
				? `all but ${change.disallowedTools.join(", ")}`
				: null;
	const facts = tools === null ? "" : `${dim(" · ")}${dim(sanitizeCallTargetText(tools))}`;
	return hanging(
		`${MARK}${skillNames(change.names)} ${verb("armed")}${facts}${dim(" · ")}${command("/skill off")}`,
		width,
	);
}

const SUGGESTED_SKILL = /\/skill\s+(\S+)/u;

/**
 * The model's `Suggested skill: /skill <name>` line: a suggestion for the
 * operator to act on, so it reads `§ suggests /skill <name>` with the command
 * in the slash-command accent, never as the agent's prose.
 */
export function renderSkillSuggestionRow(line: string, width: number): string[] {
	const name = SUGGESTED_SKILL.exec(line)?.[1];
	if (name === undefined) return hanging(`${MARK}${theme.fg("muted", sanitizeCallTargetText(line))}`, width);
	return hanging(`${MARK}${verb("suggests")} ${command(`/skill ${sanitizeCallTargetText(name)}`)}`, width);
}
