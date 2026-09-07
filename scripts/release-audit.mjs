/** Interpret pnpm's advisory report; registry errors must never look like a clean audit. */
export function shippedAdvisoryFindings(report) {
	if (
		!report ||
		typeof report !== "object" ||
		report.error ||
		!report.advisories ||
		typeof report.advisories !== "object" ||
		Array.isArray(report.advisories) ||
		!report.metadata?.vulnerabilities
	) {
		throw new Error("pnpm audit returned an invalid report; advisory state is unknown");
	}
	const counts = report.metadata.vulnerabilities;
	for (const severity of ["info", "low", "moderate", "high", "critical"]) {
		if (!Number.isSafeInteger(counts[severity]) || counts[severity] < 0) {
			throw new Error("pnpm audit returned invalid vulnerability counts");
		}
	}
	const notes = [];
	const errors = [];
	for (const advisory of Object.values(report.advisories)) {
		if (
			!advisory ||
			typeof advisory.module_name !== "string" ||
			typeof advisory.vulnerable_versions !== "string" ||
			!["info", "low", "moderate", "high", "critical"].includes(advisory.severity)
		) {
			throw new Error("pnpm audit returned an invalid advisory");
		}
		const message = `${advisory.severity} advisory in shipped dependency ${advisory.module_name} (${advisory.vulnerable_versions})`;
		if (advisory.severity === "high" || advisory.severity === "critical") {
			errors.push(`${message}; ${advisory.recommendation || "review the advisory and update the dependency"}`);
		} else {
			notes.push(message);
		}
	}
	if ((counts.high > 0 || counts.critical > 0) && errors.length === 0) {
		throw new Error("pnpm audit reports blocking vulnerabilities without advisory details");
	}
	return { notes, errors };
}
