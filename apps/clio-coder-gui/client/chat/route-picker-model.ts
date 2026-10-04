import type { SessionConfig, SetConfigOption } from "../../contracts/session-config.js";
import type {
	AcpSafeSettings as SafeSettings,
	AcpSafeSettingsPatch as SafeSettingsPatch,
} from "../../contracts/wire.js";
import type { ModelOption } from "../pages/model-picker-model.js";

export type RouteScope = "conversation" | "every-project";
export type RouteDraft = { target: string; model: string; thinking: string };

export function routeDraft(
	settings: SafeSettings | undefined,
	config: SessionConfig | undefined,
	scope: RouteScope,
): RouteDraft | null {
	if (scope === "every-project" && !settings) return null;
	if (scope === "conversation" && !config) return null;
	const chat = settings?.settings.chat;
	return {
		target: (scope === "conversation" && config?.target !== undefined ? config.target : chat?.target) ?? "",
		model:
			(scope === "conversation" ? config?.options.find((row) => row.id === "model")?.currentValue : chat?.model) ?? "",
		thinking:
			(scope === "conversation"
				? config?.options.find((row) => row.id === "thinkingLevel")?.currentValue
				: chat?.thinkingLevel) ?? "off",
	};
}

export function conversationChanges(draft: RouteDraft, reported: RouteDraft): SetConfigOption[] {
	const changes: SetConfigOption[] = [];
	if (draft.target !== reported.target) changes.push({ configId: "target", value: draft.target });
	if (draft.model !== "" && draft.model !== reported.model) changes.push({ configId: "model", value: draft.model });
	if (draft.thinking !== reported.thinking) changes.push({ configId: "thinkingLevel", value: draft.thinking });
	return changes;
}

export function savedRoutePatch(draft: RouteDraft, reported: RouteDraft): SafeSettingsPatch {
	const patch: SafeSettingsPatch = {};
	if (draft.target !== reported.target) patch["chat.target"] = draft.target || null;
	if (draft.model !== reported.model) patch["chat.model"] = draft.model || null;
	if (draft.thinking !== reported.thinking)
		patch["chat.thinkingLevel"] = draft.thinking as NonNullable<SafeSettingsPatch["chat.thinkingLevel"]>;
	return patch;
}

/** Capabilities come from the engine's resolution of this exact target and model. */
export function modelThinkingLevels(
	config: SessionConfig | undefined,
	model: string,
	catalog: Readonly<Record<string, readonly string[]>> | undefined,
	conversation: boolean,
): readonly string[] {
	const declared = conversation
		? config?.options.find((row) => row.id === "model")?.options.find((row) => row.value === model)?.thinkingLevels
		: catalog?.[model];
	if (declared) return declared;
	if (conversation && config?.options.find((row) => row.id === "model")?.currentValue === model)
		return config.options.find((row) => row.id === "thinkingLevel")?.options.map((row) => row.value) ?? [];
	return [];
}

export function draftWithSupportedThinking(draft: RouteDraft | null, levels: readonly string[]): RouteDraft | null {
	if (!draft || levels.length === 0 || levels.includes(draft.thinking)) return draft;
	return { ...draft, thinking: draft.thinking === "off" ? (levels[0] ?? "off") : (levels.at(-1) ?? "off") };
}

/** Session configuration is the authority for eligible connections and current model choices. */
export function routePickerChoices(
	config: SessionConfig | undefined,
	draft: RouteDraft,
	inventory: ReadonlyArray<{ id: string; models: readonly string[] }> | undefined,
): { targets: ModelOption[]; models: ModelOption[]; targetEditable: boolean; modelEditable: boolean } {
	const targetControl = config?.options.find((option) => option.id === "target");
	const modelControl = config?.options.find((option) => option.id === "model");
	const targets: ModelOption[] = (inventory ?? [])
		.filter((row) => targetControl?.options.some((option) => option.value === row.id) ?? row.id === config?.target)
		.map((row) => ({ value: row.id, label: row.id }));
	if (draft.target && !targets.some((row) => row.value === draft.target))
		targets.unshift({ value: draft.target, label: draft.target });
	if (!draft.target) targets.unshift({ value: "", label: "Connection not reported" });
	const current = draft.target === config?.target;
	const models: ModelOption[] = current
		? (modelControl?.options ?? []).map((row) => ({ value: row.value, label: row.name }))
		: (inventory?.find((row) => row.id === draft.target)?.models ?? []).map((model) => ({ value: model, label: model }));
	if (!draft.model) models.push({ value: "", label: "Use connection default" });
	return {
		targets,
		models,
		targetEditable: targetControl !== undefined,
		modelEditable: !current || modelControl !== undefined,
	};
}
