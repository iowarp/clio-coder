import type { DoctorFinding } from "../../domains/lifecycle/doctor.js";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import { type ClioToken, clioTheme } from "../theme/index.js";

/** Operator-only diagnostics: keep every detail, with attention items first. */
export function renderDoctorReport(findings: ReadonlyArray<DoctorFinding>, width: number): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(8, width);
	const errors = findings.filter((finding) => !finding.ok);
	const warnings = findings.filter((finding) => finding.ok && finding.level === "warn");
	const information = findings.filter((finding) => finding.ok && finding.level === "info");
	const passed = findings.filter((finding) => finding.ok && finding.level !== "warn" && finding.level !== "info");
	const lines = wrapTextWithAnsi(theme.fg("heading", "Doctor · installation health"), safeWidth);
	lines.push(
		...wrapTextWithAnsi(
			`${findings.length} checks · ${errors.length} errors · ${warnings.length} warnings · ${passed.length} passed · ${information.length} informational`,
			safeWidth,
		),
	);
	const groups: Array<{ title: string; token: ClioToken; label: string; rows: ReadonlyArray<DoctorFinding> }> = [
		{ title: "Errors", token: "error", label: "FAIL", rows: errors },
		{ title: "Warnings", token: "warning", label: "WARN", rows: warnings },
		{ title: "Information", token: "info", label: "INFO", rows: information },
		{ title: "Passed checks", token: "toolMetadata", label: "OK", rows: passed },
	];
	for (const group of groups) {
		if (!group.rows.length) continue;
		lines.push("", ...wrapTextWithAnsi(theme.fg(group.token, `${group.title} · ${group.rows.length}`), safeWidth));
		for (const finding of group.rows) {
			lines.push(
				...wrapTextWithAnsi(`${theme.fg(group.token, group.label)}  ${theme.fg("boldEmphasis", finding.name)}`, safeWidth),
			);
			for (const detail of finding.detail.split(/\r?\n/)) {
				lines.push(
					...wrapTextWithAnsi(theme.fg("body", detail.replace(/\t/g, "    ")), safeWidth - 2).map((line) => `  ${line}`),
				);
			}
		}
	}
	lines.push("");
	return lines;
}
