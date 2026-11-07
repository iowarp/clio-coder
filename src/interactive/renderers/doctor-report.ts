import type { OutputStyle } from "../../core/defaults.js";
import type { DoctorFinding } from "../../domains/lifecycle/doctor.js";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import { type ClioToken, clioTheme } from "../theme/index.js";

/** Operator-only diagnostics: keep every detail, with attention items first. */
export function renderDoctorReport(
	findings: ReadonlyArray<DoctorFinding>,
	width: number,
	style: OutputStyle = "standard",
): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);
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
		...(style === "detailed"
			? [
					{ title: "Information", token: "info" as const, label: "INFO", rows: information },
					{ title: "Passed checks", token: "toolMetadata" as const, label: "OK", rows: passed },
				]
			: []),
	];
	for (const group of groups) {
		if (!group.rows.length) continue;
		lines.push("", ...wrapTextWithAnsi(theme.fg(group.token, `${group.title} · ${group.rows.length}`), safeWidth));
		for (const finding of group.rows) {
			lines.push(
				...wrapTextWithAnsi(`${theme.fg(group.token, group.label)}  ${theme.fg("boldEmphasis", finding.name)}`, safeWidth),
			);
			for (const detail of finding.detail.split(/\r?\n/)) {
				const indent = safeWidth > 2 ? "  " : "";
				lines.push(
					...wrapTextWithAnsi(theme.fg("body", detail.replace(/\t/g, "    ")), safeWidth - indent.length).map(
						(line) => `${indent}${line}`,
					),
				);
			}
			if (style === "standard" && passed.length > 0) {
				lines.push(
					"",
					...wrapTextWithAnsi(
						theme.fg("toolMetadata", `OK  ${passed.map((finding) => finding.name).join(" · ")}`),
						safeWidth,
					),
				);
			}
			if (style !== "detailed" && passed.length + information.length > 0) {
				lines.push(
					...wrapTextWithAnsi(
						theme.fg(
							"annotation",
							`${passed.length + information.length} routine checks folded · Detailed output shows all findings`,
						),
						safeWidth,
					),
				);
			}
		}
	}
	lines.push("");
	return lines;
}
