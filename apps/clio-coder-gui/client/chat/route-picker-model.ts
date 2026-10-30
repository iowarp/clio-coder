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
				: chat?.thinkingLevel) ?? (scope === "conversation" ? "" : "off"),
	};
}

export function conversationChanges(
	draft: RouteDraft,
	reported: RouteDraft,
	thinkingLevels?: readonly string[],
): SetConfigOption[] {
	const changes: SetConfigOption[] = [];
	if (draft.target !== reported.target) changes.push({ configId: "target", value: draft.target });
	if (draft.model !== "" && draft.model !== reported.model) changes.push({ configId: "model", value: draft.model });
	if (
		draft.thinking !== "" &&
		draft.thinking !== reported.thinking &&
		(thinkingLevels === undefined || thinkingLevels.includes(draft.thinking))
	)
		changes.push({ configId: "thinkingLevel", value: draft.thinking });
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
): {
	targets: ModelOption[];
	models: ModelOption[];
	targetEditable: boolean;
	modelEditable: boolean;
	needsConnectionSetup: boolean;
} {
	const targetControl = config?.options.find((option) => option.id === "target");
	const modelControl = config?.options.find((option) => option.id === "model");
	const targets: ModelOption[] = (targetControl?.options ?? []).map((row) => ({ value: row.value, label: row.name }));
	if (draft.target && !targets.some((row) => row.value === draft.target))
		targets.unshift({ value: draft.target, label: draft.target });
	if (!draft.target)
		targets.unshift({ value: "", label: config?.target === null ? "No connection selected" : "Connection not reported" });
	const current = draft.target === (config?.target ?? "");
	const models: ModelOption[] = current
		? (modelControl?.options ?? []).map((row) => ({ value: row.value, label: row.name }))
		: (inventory?.find((row) => row.id === draft.target)?.models ?? []).map((model) => ({ value: model, label: model }));
	if (draft.model && !models.some((row) => row.value === draft.model))
		models.unshift({ value: draft.model, label: `${draft.model} · not in the reported choices` });
	if (!draft.model) models.push({ value: "", label: "Use connection default" });
	return {
		targets,
		models,
		targetEditable: (targetControl?.options.length ?? 0) > 0,
		modelEditable: models.some((row) => row.value !== draft.model),
		needsConnectionSetup: config?.target === null && targetControl === undefined,
	};
}

/** An absent control reports no capability; an empty capability list does not mean thinking is off. */
export function thinkingControlNote(
	config: SessionConfig | undefined,
	draft: RouteDraft,
	levels: readonly string[],
): string | null {
	if (
		draft.target === (config?.target ?? "") &&
		draft.model === config?.options.find((row) => row.id === "model")?.currentValue
	) {
		const control = config?.options.find((row) => row.id === "thinkingLevel");
		if (control?.notice) return control.notice;
		if (!control) return "Clio Coder has not reported a thinking control for this conversation.";
	}
	if (levels.length === 0)
		return "No thinking choices are reported for this model. Clio Coder will resolve its thinking behavior when the model is applied.";
	if (levels.length === 1 && levels[0] === "off") return "This model reports thinking off as its only supported choice.";
	return null;
}

export function thinkingChoices(draft: RouteDraft, levels: readonly string[]): ModelOption[] {
	return [
		...(levels.includes(draft.thinking)
			? []
			: [
					{
						value: draft.thinking,
						label: draft.thinking ? `${draft.thinking} · reported for the current model` : "Not reported",
					},
				]),
		...levels.map((level) => ({ value: level, label: level })),
	];
}
