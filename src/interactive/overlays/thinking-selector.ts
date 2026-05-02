import type { ClioSettings } from "../../core/config.js";
import {
	availableThinkingLevels,
	type ProvidersContract,
	resolveModelCapabilities,
	type ThinkingLevel,
} from "../../domains/providers/index.js";
import { extractLocalModelQuirks, type ThinkingMechanism } from "../../domains/providers/types/local-model-quirks.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";

export const THINKING_OVERLAY_WIDTH = 44;

const IDENTITY = (s: string): string => s;

const THINKING_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

const DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "no reasoning tokens",
	minimal: "short structured plan",
	low: "brief chain-of-thought",
	medium: "standard reasoning",
	high: "deep reasoning",
	xhigh: "extended thinking (models that support it)",
};

export interface OpenThinkingOverlayDeps {
	current: ThinkingLevel;
	available: readonly ThinkingLevel[];
	onSelect: (next: ThinkingLevel) => void;
	onClose: () => void;
}

class ThinkingOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function buildThinkingItems(current: ThinkingLevel, available: readonly ThinkingLevel[]): SelectItem[] {
	return available.map((lvl) => ({
		value: lvl,
		label: `${lvl === current ? "●" : " "} ${lvl}`,
		description: DESCRIPTIONS[lvl] ?? "",
	}));
}

export function openThinkingOverlay(tui: TUI, deps: OpenThinkingOverlayDeps): OverlayHandle {
	const items = buildThinkingItems(deps.current, deps.available);
	const list = new SelectList(items, deps.available.length, THINKING_THEME);
	const initialIndex = Math.max(0, deps.available.indexOf(deps.current));
	list.setSelectedIndex(initialIndex);
	list.onSelect = (item: SelectItem): void => {
		deps.onSelect(item.value as ThinkingLevel);
		deps.onClose();
	};
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new ThinkingOverlayBox(list);
	box.addChild(list);
	return tui.showOverlay(box, { anchor: "center", width: THINKING_OVERLAY_WIDTH });
}

/** Current thinking level persisted under settings.orchestrator.thinkingLevel. */
export function readThinkingLevel(settings: Readonly<ClioSettings>): ThinkingLevel {
	return settings.orchestrator.thinkingLevel ?? "off";
}

/**
 * Thinking levels permitted for the active orchestrator target. Looks up the
 * target's merged `CapabilityFlags` via `providers.list()` and gates the list
 * through `availableThinkingLevels`. Unknown or unconfigured targets return
 * `["off"]` so the overlay degrades to a no-op single-option picker.
 *
 * The level list is further constrained by the family's thinking mechanism:
 * `on-off` collapses to {off, low}; `always-on` collapses to a single placeholder
 * (`high`); `none` collapses to {off}. The overlay reads the same mechanism so
 * the descriptions stay aligned with the row set.
 */
export function resolveAvailableThinkingLevels(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): ReadonlyArray<ThinkingLevel> {
	const endpointId = settings.orchestrator.endpoint?.trim();
	const wireModelId = settings.orchestrator.model?.trim();
	if (!endpointId) return ["off"];
	const status = providers.list().find((entry) => entry.endpoint.id === endpointId);
	if (!status) return ["off"];
	const detectedReasoning = wireModelId ? providers.getDetectedReasoning(endpointId, wireModelId) : null;
	const baseAvailable = availableThinkingLevels(
		resolveModelCapabilities(status, wireModelId, providers.knowledgeBase, { detectedReasoning }),
		{
			runtimeId: status.runtime?.id ?? status.endpoint.runtime,
			...(wireModelId ? { modelId: wireModelId } : {}),
		},
	);
	const mechanism = wireModelId ? mechanismForModel(providers, wireModelId) : null;
	return restrictLevelsByMechanism(baseAvailable, mechanism);
}

/**
 * Read the family thinking mechanism for a given wire model id. Returns null
 * when the catalog does not annotate the family. Cheap: lookup is the only
 * fs-touching call and the KB is loaded once per process.
 */
export function mechanismForModel(providers: ProvidersContract, wireModelId: string): ThinkingMechanism | null {
	const kbHit = providers.knowledgeBase?.lookup(wireModelId) ?? null;
	const quirks = extractLocalModelQuirks(kbHit?.entry.quirks);
	return quirks?.thinking?.mechanism ?? null;
}

/**
 * Collapse the available level list to the rows the overlay should show for
 * a given mechanism. The overlay caller still passes through the resolved
 * level on `onSelect`; the engine's `applyThinkingMechanism` re-coerces if
 * the user picks an unsupported intermediate level via /thinking <level>.
 */
export function restrictLevelsByMechanism(
	levels: ReadonlyArray<ThinkingLevel>,
	mechanism: ThinkingMechanism | null,
): ReadonlyArray<ThinkingLevel> {
	if (mechanism === "none") return ["off"];
	if (mechanism === "always-on") return ["high"];
	if (mechanism === "on-off") {
		const out: ThinkingLevel[] = [];
		if (levels.includes("off")) out.push("off");
		out.push("low");
		return out;
	}
	return levels;
}
