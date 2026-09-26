import type { SessionConfig, SetConfigOption } from "../../contracts/session-config.js";
import type { SafeSettings, SafeSettingsPatch } from "../../contracts/settings-safe.js";

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
	if (draft.model !== reported.model) changes.push({ configId: "model", value: draft.model });
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
