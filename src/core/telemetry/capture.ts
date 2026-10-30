import type { SegmentHeader } from "./envelope.js";
import type { Kind } from "./schemas.js";
import { KIND_REGISTRY } from "./schemas.js";

export type TelemetryMode = SegmentHeader["mode"];
export type CaptureFlags = SegmentHeader["capture"];
export type CaptureFlag = keyof CaptureFlags;

/** The `telemetry` settings block. Research flags are requests; `effectiveTelemetryCapture` decides (#434). */
export interface TelemetrySettings {
	mode: TelemetryMode;
	research: CaptureFlags;
}

/** What a segment admits. Its header carries exactly this, so a reader never infers the mode (#434). */
export interface TelemetryCapture {
	mode: TelemetryMode;
	capture: CaptureFlags;
}

export const STANDARD_CAPTURE: TelemetryCapture = Object.freeze({
	mode: "standard",
	capture: Object.freeze({
		content: false,
		deltas: false,
		providerHeaders: false,
		systemOneDataset: false,
		busTrace: false,
	}),
});

/**
 * Standard mode captures no research flag whatever the settings request. Content
 * additionally needs the operator's consent for the workspace, which no settings
 * layer can grant (#434, O6).
 */
export function effectiveTelemetryCapture(settings: TelemetrySettings, contentConsent: boolean): TelemetryCapture {
	if (settings.mode !== "research") return STANDARD_CAPTURE;
	return {
		mode: "research",
		capture: { ...settings.research, content: settings.research.content && contentConsent },
	};
}

export function sameTelemetryCapture(a: TelemetryCapture, b: TelemetryCapture): boolean {
	if (a.mode !== b.mode) return false;
	for (const flag of Object.keys(a.capture) as CaptureFlag[]) if (a.capture[flag] !== b.capture[flag]) return false;
	return true;
}

/**
 * Standard admits only the accountability and operational tiers with content-free
 * or structural payloads. Research adds its tier per the kind's capture flag, and
 * content-bearing kinds only with content capture (#434).
 */
export function captureAdmits(capture: TelemetryCapture, kind: Kind): boolean {
	const definition: { tier: string; cc: string; capture?: CaptureFlag } = KIND_REGISTRY[kind];
	if (definition.cc === "content-bearing" && !capture.capture.content) return false;
	if (definition.tier !== "research") return true;
	if (capture.mode !== "research") return false;
	return definition.capture === undefined || capture.capture[definition.capture];
}

/**
 * The System One dataset keeps redacted decision state and rendered prompts, so under research mode it is
 * content: it needs its flag and content capture. `systemOne.record` stays a deprecated alias that records
 * without either (#434).
 */
export function systemOneDatasetRecording(
	settings: { systemOne: { record: boolean } },
	capture: TelemetryCapture,
): boolean {
	return (
		settings.systemOne.record ||
		(capture.mode === "research" && capture.capture.systemOneDataset && capture.capture.content)
	);
}
