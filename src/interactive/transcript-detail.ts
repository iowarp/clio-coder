/** Presentation budgets for the same captured session. Detailed is still bounded. */
import type { OutputStyle } from "../core/defaults.js";

export interface TranscriptDetailPolicy {
	style: OutputStyle;
	reasoningRows: number;
	resultRows: number;
	bashRows: number;
	operatorBashRows: number;
	diffRows: number;
	workerRows: number;
	workerActivity: boolean;
	errorRows: number;
	receipt: "none" | "compact" | "full";
}

const POLICIES: Record<OutputStyle, TranscriptDetailPolicy> = {
	compact: {
		style: "compact",
		reasoningRows: 0,
		resultRows: 0,
		bashRows: 0,
		operatorBashRows: 3,
		diffRows: 0,
		workerRows: 0,
		workerActivity: false,
		errorRows: 4,
		receipt: "none",
	},
	standard: {
		style: "standard",
		reasoningRows: 3,
		resultRows: 0,
		bashRows: 0,
		operatorBashRows: 6,
		diffRows: 8,
		workerRows: 3,
		workerActivity: false,
		errorRows: 4,
		receipt: "compact",
	},
	detailed: {
		style: "detailed",
		reasoningRows: 12,
		resultRows: 8,
		bashRows: 12,
		operatorBashRows: 12,
		diffRows: 20,
		workerRows: 8,
		workerActivity: true,
		errorRows: 12,
		receipt: "full",
	},
};

export function transcriptDetail(style: OutputStyle = "standard"): TranscriptDetailPolicy {
	return POLICIES[style];
}
