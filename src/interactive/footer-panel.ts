import type { ClioSettings } from "../core/config.js";
import type { ModesContract } from "../domains/modes/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { resolveModelScope, supportsThinking } from "../domains/providers/resolver.js";
import { Text } from "../engine/tui.js";
import type { Model } from "../engine/types.js";

const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";
const SEP = " \u00b7 ";
const GLYPH = "\u25c6";

export interface FooterDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
	getOrchestratorModel?: () => Model<never> | undefined;
}

export interface FooterPanel {
	view: Text;
	refresh(): void;
}

function orchestratorTarget(settings: Readonly<ClioSettings>): string | null {
	const providerId = settings.orchestrator?.provider?.trim();
	const modelId = settings.orchestrator?.model?.trim();
	if (!providerId || !modelId) return null;
	const endpoint = settings.orchestrator?.endpoint?.trim();
	return endpoint ? `${providerId}/${endpoint}/${modelId}` : `${providerId}/${modelId}`;
}

/**
 * Builds the `scoped:N/M` segment for the branded footer. M is the resolved
 * size of `provider.scope`; N is the 1-based index of the active
 * `orchestrator.{provider,model}` within that set, or `-` when the active
 * target is not in scope. Returns `null` when scope is empty so the segment
 * is omitted entirely per the footer contract.
 */
export function scopedSegment(settings: Readonly<ClioSettings>): string | null {
	const patterns = settings.provider?.scope ?? [];
	if (patterns.length === 0) return null;
	const resolved = resolveModelScope(patterns).matches;
	if (resolved.length === 0) return null;
	const active = `${settings.orchestrator?.provider ?? ""}::${settings.orchestrator?.model ?? ""}`;
	const idx = resolved.findIndex((r) => `${r.providerId}::${r.modelId}` === active);
	const n = idx === -1 ? "-" : String(idx + 1);
	return `scoped:${n}/${resolved.length}`;
}

export function buildFooter(deps: FooterDeps): FooterPanel {
	const view = new Text("");
	const refresh = (): void => {
		const mode = deps.modes.current().toLowerCase();
		const settings = deps.getSettings?.();
		let target = settings ? orchestratorTarget(settings) : null;
		if (!target) {
			const providers = deps.providers.list();
			const active = providers.find((p) => p.available) ?? providers[0];
			target = active ? `${active.id}/${active.displayName}` : "no-provider";
		}

		const scoped = settings ? scopedSegment(settings) : null;
		const scopedPart = scoped ? `${SEP}${scoped}` : "";

		const model = deps.getOrchestratorModel?.();
		let suffix = "";
		if (supportsThinking(model)) {
			const level = settings?.orchestrator?.thinkingLevel ?? "off";
			const piece = `${SEP}${GLYPH} ${level}`;
			suffix = level === "off" ? `${ANSI_DIM}${piece}${ANSI_RESET}` : piece;
		}

		view.setText(`clio${SEP}${mode}${SEP}${target}${scopedPart}${suffix}`);
		view.invalidate();
	};
	refresh();
	return { view, refresh };
}
