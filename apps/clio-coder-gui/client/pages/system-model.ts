import type { Static } from "typebox";
import type { SystemReport } from "../../contracts/system.js";
import type { ConnectionState } from "../api/events.js";
import type { StatusTone } from "../design/status.js";

type Finding = Static<typeof SystemReport>["findings"][number];
const LEVELS = ["error", "warn", "info", "ok"] as const;
const LABELS = { error: "Needs attention", warn: "Review", info: "Information", ok: "Ready" } as const;
const TONES: Record<Finding["level"], StatusTone> = { error: "fail", warn: "warn", info: "neutral", ok: "success" };

export function platformLabel(platform: string | undefined): string {
	const os = platform?.split("-")[0];
	return os === "linux" ? "Linux" : os === "darwin" ? "macOS" : os === "win32" ? "Windows" : platform || "Local";
}

/** A connected event stream alone cannot establish installation health. */
export function systemStatus(
	connection: ConnectionState,
	findings: readonly Finding[] | undefined,
	failed: boolean,
): { tone: StatusTone; label: string; detail: string } {
	if (connection !== "Connected") {
		return connection === "Connecting…"
			? { tone: "unverified", label: "Connecting", detail: "Connecting to the Clio runtime." }
			: connection === "Reconnecting…"
				? { tone: "warn", label: "Reconnecting", detail: "The Clio event connection is interrupted." }
				: { tone: "fail", label: "Offline", detail: "The Clio runtime is not connected." };
	}
	if (failed) return { tone: "unverified", label: "Unverified", detail: "Installation diagnostics are unavailable." };
	if (!findings) return { tone: "unverified", label: "Checking", detail: "Reading Clio installation diagnostics." };
	if (!findings.length) return { tone: "unverified", label: "Unverified", detail: "No installation findings reported." };
	const errors = findings.filter((finding) => finding.level === "error").length;
	const warnings = findings.filter((finding) => finding.level === "warn").length;
	if (errors)
		return {
			tone: "fail",
			label: `${errors} issue${errors === 1 ? "" : "s"}`,
			detail: `${errors} installation error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"} reported.`,
		};
	if (warnings)
		return {
			tone: "warn",
			label: `${warnings} warning${warnings === 1 ? "" : "s"}`,
			detail: `${warnings} installation check${warnings === 1 ? " needs" : "s need"} review.`,
		};
	return { tone: "success", label: "Ready", detail: "No installation checks need attention." };
}

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
