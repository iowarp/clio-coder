/**
 * The yolo mode label and the autonomous window as text, shared by the terminal footer and the ACP readouts.
 * Each surface passes its own separator glyph and resume hint and applies its own colour to the tone.
 */

import { formatFooterTokens } from "../../core/display-units.js";
import type { YoloConfinement } from "./autonomy.js";
import type { AutonomyStatus } from "./autonomy-window.js";

export interface AutonomyModeReadout {
	text: string;
	tone: "warning" | "error";
}

export interface AutonomyWindowReadout {
	text: string;
	tone: "neutral" | "warning";
	halted: boolean;
}

/** Contained yolo is the warning tone; the unconfined opt-out is the error tone and shouts (ob-yolo D9). */
export function autonomyModeReadout(input: {
	confinement: YoloConfinement;
	osSandbox: boolean;
	narrow: boolean;
	dot: string;
}): AutonomyModeReadout {
	const { dot } = input;
	if (input.confinement === "unconfined") return { text: `YOLO ${dot} UNCONFINED`, tone: "error" };
	// Contained with no OS sandbox backend keeps only the judge and the floor, and says so (D9).
	if (!input.osSandbox) {
		return {
			text: input.narrow ? `YOLO ${dot} no sandbox` : `YOLO ${dot} contained (no OS sandbox)`,
			tone: "warning",
		};
	}
	return { text: `YOLO ${dot} contained`, tone: "warning" };
}

/**
 * The autonomous window: `412/600 calls · 38/120 min · 1.9M/5M tok`, the nearest cap alone when narrow, and the way
 * back once it has paused. Null when no cap applies.
 */
export function autonomyWindowReadout(
	status: AutonomyStatus,
	options: { narrow: boolean; dot: string; resumeHint: string },
): AutonomyWindowReadout | null {
	const { dot, narrow } = options;
	if (status.halted !== null) {
		return { text: narrow ? "yolo paused" : `yolo paused ${dot} ${options.resumeHint}`, tone: "warning", halted: true };
	}
	const { caps, usage } = status;
	const minutes = Math.floor(usage.activeMs / 60_000);
	const meters = [
		{ used: usage.toolCalls, cap: caps.toolCalls, text: `${usage.toolCalls}/${caps.toolCalls} calls` },
		{ used: minutes, cap: caps.minutes, text: `${minutes}/${caps.minutes} min` },
		{
			used: usage.tokens,
			cap: caps.tokens,
			text: `${formatFooterTokens(usage.tokens)}/${formatFooterTokens(caps.tokens)} tok`,
		},
	].filter((meter) => meter.cap > 0);
	if (meters.length === 0) return null;
	const nearest = meters.reduce((best, meter) => (meter.used / meter.cap > best.used / best.cap ? meter : best));
	const shown = narrow ? [nearest] : meters;
	return {
		text: shown.map((meter) => meter.text).join(` ${dot} `),
		tone: nearest.used / nearest.cap >= 0.8 ? "warning" : "neutral",
		halted: false,
	};
}
