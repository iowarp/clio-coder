/**
 * The semantic status ramp. The truthfulness contract needs measured,
 * estimated, reported, replayed, unavailable, failed, stopped, skipped and
 * running to stay distinguishable *without colour*, so every mark renders a
 * glyph and a word; the tone is supplementary and never carries the meaning
 * alone. `unverified` is additionally dashed, which is what makes "missing
 * evidence is not success" survive a greyscale screenshot.
 */
export type StatusTone = "neutral" | "running" | "success" | "warn" | "fail" | "unverified";

/** One glyph per tone. Exported for compact marks that carry their words in an accessible name. */
export const TONE_GLYPHS: Readonly<Record<StatusTone, string>> = {
	neutral: "·",
	running: "▸",
	success: "●",
	warn: "◐",
	fail: "✕",
	unverified: "◌",
};

export function StatusMark({
	tone = "neutral",
	label,
	detail,
	title,
}: {
	tone?: StatusTone;
	label: string;
	detail?: string;
	title?: string;
}) {
	return (
		<span className="status-mark" data-tone={tone} title={title}>
			<span className="status-mark__glyph" aria-hidden="true">
				{TONE_GLYPHS[tone]}
			</span>
			{label}
			{detail ? <span className="status-mark__detail">{detail}</span> : null}
		</span>
	);
}

/** Maps the protocol's outcome vocabulary onto the six tones so callers do not each invent one. */
export function toneForOutcome(outcome: string | null | undefined): StatusTone {
	switch (outcome) {
		case "running":
		case "streaming":
		case "in_progress":
			return "running";
		case "completed":
		case "success":
		case "healthy":
		case "verified":
			return "success";
		case "waiting":
		case "pending":
		case "estimated":
		case "degraded":
		case "truncated":
			return "warn";
		case "failed":
		case "error":
			return "fail";
		// Stopping is not failing: nothing broke, so a stop reads as a neutral report.
		case "cancelled":
		case "stopped":
			return "neutral";
		case "unavailable":
		case "unverified":
		case null:
		case undefined:
			return "unverified";
		default:
			return "neutral";
	}
}
