import type { Static } from "typebox";
import type { SystemReport } from "../../contracts/system.js";
import type { StatusTone } from "../design/status.js";

type Finding = Static<typeof SystemReport>["findings"][number];
const LEVELS = ["error", "warn", "info", "ok"] as const;
const LABELS = { error: "Needs attention", warn: "Review", info: "Information", ok: "Ready" } as const;
const TONES: Record<Finding["level"], StatusTone> = { error: "fail", warn: "warn", info: "neutral", ok: "success" };

/** Preserve the doctor's severity; a warning may still carry ok=true. */
export function healthGroups(findings: readonly Finding[], query = "", attentionOnly = false) {
	const needle = query.trim().toLocaleLowerCase("en-US");
	return LEVELS.map((level) => ({
		level,
		label: LABELS[level],
		tone: TONES[level],
		findings: findings.filter(
			(finding) =>
				finding.level === level &&
				(!attentionOnly || level === "error" || level === "warn") &&
				(!needle || `${finding.name} ${finding.detail}`.toLocaleLowerCase("en-US").includes(needle)),
		),
	})).filter((group) => group.findings.length > 0);
}

/** Offer only inspection paths the application actually supports. Repairs remain local CLI decisions. */
export function findingAction(finding: Pick<Finding, "name" | "level">): { label: string; path: string } | null {
	if (finding.level === "ok" || finding.level === "info") return null;
	if (finding.name === "settings.yaml") return { label: "Inspect settings sources", path: "/settings/effective" };
	if (finding.name === "session store" || finding.name === "cache telemetry")
		return { label: "Inspect recorded sessions", path: "/sessions" };
	return null;
}
