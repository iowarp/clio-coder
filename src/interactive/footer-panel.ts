import type { ClioSettings } from "../core/config.js";
import type { ModesContract } from "../domains/modes/index.js";
import {
	type CapabilityFlags,
	type ProvidersContract,
	availableThinkingLevels,
} from "../domains/providers/index.js";
import { Text } from "../engine/tui.js";

const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";
const SEP = " \u00b7 ";
const GLYPH = "\u25c6";

export interface FooterDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
}

export interface FooterPanel {
	view: Text;
	refresh(): void;
}

interface OrchestratorTarget {
	endpointId: string;
	wireModelId: string;
	healthStatus: "healthy" | "degraded" | "unknown" | "down";
	capabilities: CapabilityFlags | null;
}

function resolveOrchestratorTarget(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): OrchestratorTarget | null {
	const endpointId = settings.orchestrator?.endpoint?.trim();
	const wireModelId = settings.orchestrator?.model?.trim();
	if (!endpointId || !wireModelId) return null;
	const status = providers.list().find((entry) => entry.endpoint.id === endpointId);
	return {
		endpointId,
		wireModelId,
		healthStatus: status?.health.status ?? "unknown",
		capabilities: status?.capabilities ?? null,
	};
}

/**
 * Build the `scoped:N/M` segment for the branded footer. M is the length of
 * `settings.scope`; N is the 1-based index of the active
 * `{endpoint, model}` ref within that set (matching either `endpointId` or
 * `endpointId/wireModelId` entries), or `-` when the active target is not
 * in scope. Returns `null` when scope is empty so the segment is omitted
 * entirely per the footer contract.
 */
export function scopedSegment(settings: Readonly<ClioSettings>): string | null {
	const scope = settings.scope ?? [];
	if (scope.length === 0) return null;
	const endpointId = settings.orchestrator?.endpoint ?? "";
	const wireModelId = settings.orchestrator?.model ?? "";
	const combinedRef = endpointId.length > 0 && wireModelId.length > 0 ? `${endpointId}/${wireModelId}` : "";
	const idx = scope.findIndex((entry) => entry === endpointId || entry === combinedRef);
	const n = idx === -1 ? "-" : String(idx + 1);
	return `scoped:${n}/${scope.length}`;
}

export function buildFooter(deps: FooterDeps): FooterPanel {
	const view = new Text("");
	const refresh = (): void => {
		const mode = deps.modes.current().toLowerCase();
		const settings = deps.getSettings?.();
		const target = settings ? resolveOrchestratorTarget(deps.providers, settings) : null;
		let targetLabel: string;
		if (target) {
			const dim = target.healthStatus === "down" ? ANSI_DIM : "";
			const reset = dim.length > 0 ? ANSI_RESET : "";
			targetLabel = `${dim}${target.endpointId}${SEP}${target.wireModelId}${reset}`;
		} else {
			targetLabel = "no-endpoint";
		}

		const scoped = settings ? scopedSegment(settings) : null;
		const scopedPart = scoped ? `${SEP}${scoped}` : "";

		let suffix = "";
		if (target?.capabilities) {
			const available = availableThinkingLevels(target.capabilities);
			if (available.length > 1) {
				const level = settings?.orchestrator?.thinkingLevel ?? "off";
				const piece = `${SEP}${GLYPH} ${level}`;
				suffix = level === "off" ? `${ANSI_DIM}${piece}${ANSI_RESET}` : piece;
			}
		}

		view.setText(`clio${SEP}${mode}${SEP}${targetLabel}${scopedPart}${suffix}`);
		view.invalidate();
	};
	refresh();
	return { view, refresh };
}
