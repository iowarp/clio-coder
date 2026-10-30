import { renderCount } from "../../core/telemetry/render.js";
import type { EvidenceTotals } from "./types.js";

/**
 * A bundle's sealed token total, shown as a lower bound when its receipts do not cover every call (#434, L3). The
 * TUI's /view, the ACP artifact and the GUI server all print this one wording; a surface may only pick the count
 * formatter, so the footer's compact figures and the GUI's full ones carry the same coverage marker.
 */
export function renderEvidenceTokens(
	totals: Pick<EvidenceTotals, "tokens" | "tokenCoverage">,
	options: { unit?: string; count?: (value: number) => string } = {},
): string {
	const count = options.count ?? renderCount;
	const tokens = `${count(totals.tokens)}${options.unit ?? ""}`;
	const gap = totals.tokenCoverage;
	if (gap === undefined || (gap.unknownCalls === 0 && gap.unknownRuns === 0)) return tokens;
	const parts = [
		...(gap.unknownCalls > 0 ? [`${gap.unknownCalls} ${gap.unknownCalls === 1 ? "call" : "calls"}`] : []),
		...(gap.unknownRuns > 0 ? [`${gap.unknownRuns} ${gap.unknownRuns === 1 ? "run" : "runs"}`] : []),
	];
	return `≥${tokens} (${parts.join(", ")} unmeasured)`;
}
