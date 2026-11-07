import type { OutputStyle } from "../../core/defaults.js";
import type { DoctorFinding } from "../../domains/lifecycle/doctor.js";
import { GLYPH } from "../theme/index.js";
import { renderTranscriptReport } from "./report.js";

/** Operator-only diagnostics: keep attention items complete and fold routine checks by tier. */
export function renderDoctorReport(
	findings: ReadonlyArray<DoctorFinding>,
	width: number,
	style: OutputStyle = "standard",
	unbounded = false,
): string[] {
	const full = style === "detailed" || unbounded;
	const errors = findings.filter((finding) => !finding.ok);
	const warnings = findings.filter((finding) => finding.ok && finding.level === "warn");
	const information = findings.filter((finding) => finding.ok && finding.level === "info");
	const passed = findings.filter((finding) => finding.ok && finding.level !== "warn" && finding.level !== "info");
	const routineCount = passed.length + information.length;
	return renderTranscriptReport(
		{
			title: "Doctor",
			summary: [
				`${findings.length} checks`,
				`${errors.length} errors`,
				`${warnings.length} warnings`,
				`${passed.length} passed`,
				`${information.length} info`,
			].join(` ${GLYPH.dot} `),
			level: errors.length > 0 ? "error" : warnings.length > 0 ? "warn" : "success",
			rows: [
				...errors.map((finding) => ({
					label: finding.name,
					value: "FAIL",
					detail: finding.detail,
					token: "error" as const,
				})),
				...warnings.map((finding) => ({
					label: finding.name,
					value: "WARN",
					detail: finding.detail,
					token: "warning" as const,
				})),
				...(full
					? [
							...information.map((finding) => ({ label: finding.name, value: "INFO", detail: finding.detail })),
							...passed.map((finding) => ({ label: finding.name, value: "OK", detail: finding.detail })),
						]
					: [
							...(style === "standard" && passed.length > 0
								? [{ label: "OK", value: passed.map((finding) => finding.name).join(` ${GLYPH.dot} `) }]
								: []),
							...(routineCount > 0
								? [
										{
											label: "",
											value: `${routineCount} routine check${routineCount === 1 ? "" : "s"} folded ${GLYPH.dot} Detailed output shows all findings`,
											token: "annotation" as const,
										},
									]
								: []),
						]),
			],
		},
		width,
		style,
		// Routine rows are already folded; attention details must never be budgeted away.
		true,
	);
}
