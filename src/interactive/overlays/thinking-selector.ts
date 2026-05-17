import type { ClioSettings } from "../../core/config.js";
import {
	type ProvidersContract,
	type ResolvedThinkingCapability,
	resolveModelRuntimeCapabilitiesForProviders,
	type ThinkingLevel,
	thinkingLevelChoiceLabel,
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
import { showClioOverlayFrame } from "../overlay-frame.js";

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
	labelFor?: (level: ThinkingLevel) => string;
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

export function buildThinkingItems(
	current: ThinkingLevel,
	available: readonly ThinkingLevel[],
	labelFor: (level: ThinkingLevel) => string = (level) => level,
): SelectItem[] {
	return available.map((lvl) => {
		const label = labelFor(lvl);
		return {
			value: lvl,
			label: `${lvl === current ? "●" : " "} ${label}`,
			description: label === "on" ? "thinking enabled" : (DESCRIPTIONS[lvl] ?? ""),
		};
	});
}

export function openThinkingOverlay(tui: TUI, deps: OpenThinkingOverlayDeps): OverlayHandle {
	const items = buildThinkingItems(deps.current, deps.available, deps.labelFor);
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
	return showClioOverlayFrame(tui, box, { anchor: "center", width: THINKING_OVERLAY_WIDTH, title: "Thinking" });
}

/** Current thinking level persisted under settings.orchestrator.thinkingLevel. */
export function readThinkingLevel(settings: Readonly<ClioSettings>): ThinkingLevel {
	return settings.orchestrator.thinkingLevel ?? "off";
}

export function resolveThinkingCapability(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): ResolvedThinkingCapability | null {
	const resolved = resolveModelRuntimeCapabilitiesForProviders(
		providers,
		settings.orchestrator.endpoint,
		settings.orchestrator.model,
		settings.orchestrator.thinkingLevel ?? "off",
	);
	return resolved?.thinking ?? null;
}

/**
 * Thinking levels permitted for the active orchestrator target. This is the
 * same resolved surface used by the runtime payload builders and dashboard.
 * Unknown or unconfigured targets return `["off"]` so the overlay degrades to
 * a no-op single-option picker.
 */
export function resolveAvailableThinkingLevels(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): ReadonlyArray<ThinkingLevel> {
	return resolveThinkingCapability(providers, settings)?.supportedLevels ?? ["off"];
}

export function resolveThinkingLabeler(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): (level: ThinkingLevel) => string {
	const thinking = resolveThinkingCapability(providers, settings);
	const mechanism = thinking?.mechanism ?? null;
	return (level) => thinkingLevelChoiceLabel(mechanism, level);
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
 * Back-compat export for tests and older callers. New UI and runtime paths
 * should ask `resolveThinkingCapability` for the full effective surface.
 */
export { restrictThinkingLevelsByMechanism as restrictLevelsByMechanism } from "../thinking-level-policy.js";
