import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { readSettings, updateSettings } from "../core/config.js";
import { getAtPath, isRoutingPath } from "../core/session-routing.js";
import { applyControlValue, formatControlValue, settingControl } from "../core/settings-controls.js";
import { ToolNames } from "../core/tool-names.js";
import { settingsChangeKind } from "../domains/config/classify.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { StringEnum } from "../engine/ai.js";
import type { AskUserHandler } from "./ask-user.js";
import type { ToolSpec } from "./registry.js";

interface ConfigureClioDeps {
	askUser: AskUserHandler;
	getAutonomy?: () => AutonomyLevel;
}

interface Proposal {
	id: string;
	path: string;
	value: string;
	before: string;
	preview: string;
	expiresAt: number;
}

const ELIGIBLE_PATH =
	/^(?:chat\.(?:target|model|thinkingLevel|modelPicker\.[a-zA-Z.]+)|fleet\.(?:default\.[a-zA-Z]+|profiles|agentProfiles|concurrency|limits\.[a-zA-Z]+)|context\.memory\.(?:target|model))$/u;

/**
 * An interactive settings transaction. The model can prepare the proposal,
 * Default mode asks the host to approve the exact preview. Yolo applies the
 * preview directly; both modes retain expiry and stale-value checks.
 * One pending proposal per session keeps both the UI and stale-value check
 * unambiguous. It deliberately never accepts credentials or arbitrary paths.
 */
export function createConfigureClioTool(deps: ConfigureClioDeps): ToolSpec {
	let pending: Proposal | null = null;
	return {
		name: ToolNames.ConfigureClio,
		description:
			"Preview a saved global Clio routing or fleet setting, then apply the exact proposal. Default asks the operator to approve; yolo applies directly. Use action=preview with a settings path and text value; action=apply with proposalId. For agent model bindings, preview/apply fleet.profiles first, then fleet.agentProfiles; each value is a complete JSON map preserving existing entries, not a nested path. The save result names when the setting takes effect; session-owned routing requires exiting and starting a new Clio session. Project saves use the operator's /settings UI. Autonomy is changed only by the operator through /settings, clio-coder configure, or --autonomy.",
		placement: "gateway",
		parameters: Type.Object({
			action: StringEnum(["preview", "apply"]),
			path: Type.Optional(Type.String()),
			value: Type.Optional(Type.String()),
			proposalId: Type.Optional(Type.String()),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		async run(args) {
			const path = typeof args.path === "string" ? args.path.trim() : undefined;
			const inputValue = typeof args.value === "string" ? args.value.trim() : undefined;
			if (path === "safety.autonomy" || pending?.path === "safety.autonomy") {
				return {
					kind: "error",
					message: "autonomy is changed only by the operator through /settings, clio-coder configure, or --autonomy",
				};
			}
			const autonomy = deps.getAutonomy?.();
			if (autonomy !== "default" && autonomy !== "yolo") {
				return {
					kind: "error",
					message: "configure_clio is available only in default or yolo mode",
				};
			}
			if (args.action === "preview") {
				if (path === undefined || inputValue === undefined) {
					return { kind: "error", message: "preview requires path and value strings" };
				}
				if (!ELIGIBLE_PATH.test(path) || !settingControl(path)) {
					return {
						kind: "error",
						message: "this setting cannot be changed through configure_clio; use /settings or configure",
					};
				}
				if (Buffer.byteLength(inputValue, "utf8") > 8192) {
					return { kind: "error", message: "settings value exceeds 8192 bytes" };
				}
				try {
					const value = inputValue;
					const saved = readSettings();
					const candidate = structuredClone(saved);
					applyControlValue(candidate, path, value);
					const before = JSON.stringify(getAtPath(saved, path));
					const after = JSON.stringify(getAtPath(candidate, path));
					if (before === after) return { kind: "ok", output: `${path} already has the requested value; nothing to apply.` };
					const affected = changedSettingLines(path, getAtPath(saved, path), getAtPath(candidate, path));
					if (path === "chat.target" && saved.chat.model !== candidate.chat.model) {
						affected.push(
							`chat.model: ${formatControlValue(saved.chat.model)} → ${formatControlValue(candidate.chat.model)}`,
						);
					}
					pending = {
						id: randomUUID(),
						path,
						value,
						before,
						preview: boundedSettingPreview(affected),
						expiresAt: Date.now() + 10 * 60_000,
					};
					return {
						kind: "ok",
						output: `Proposed saved settings change:\n${pending.preview}\n\nCall configure_clio(action="apply", proposalId="${pending.id}") to ${autonomy === "yolo" ? "save it" : "request operator approval"}. This proposal expires in 10 minutes.`,
					};
				} catch (error) {
					return { kind: "error", message: error instanceof Error ? error.message : String(error) };
				}
			}
			if (args.action !== "apply" || typeof args.proposalId !== "string" || !pending || args.proposalId !== pending.id) {
				return { kind: "error", message: "no matching settings proposal; preview the change again" };
			}
			const proposal = pending;
			pending = null;
			if (Date.now() > proposal.expiresAt)
				return { kind: "error", message: "settings proposal expired; preview it again" };
			try {
				if (JSON.stringify(getAtPath(readSettings(), proposal.path)) !== proposal.before) {
					return { kind: "error", message: "saved setting changed since preview; preview it again" };
				}
				if (autonomy !== "yolo") {
					const answer = await deps.askUser([
						{
							question: `Apply this saved Clio setting?\n${proposal.preview}`,
							header: "Clio settings",
							options: [
								{ label: "Apply", description: "Save the exact previewed change." },
								{ label: "Cancel", description: "Keep the current setting." },
							],
						},
					]);
					if (answer.cancelled || !answer.answers[0]?.options?.includes("Apply")) {
						return { kind: "ok", output: "Settings change cancelled; nothing was saved." };
					}
				}
				updateSettings((current) => {
					if (JSON.stringify(getAtPath(current, proposal.path)) !== proposal.before) {
						throw new Error("saved setting changed during approval; preview it again");
					}
					applyControlValue(current, proposal.path, proposal.value);
					return current;
				});
				return {
					kind: "ok",
					output: `Saved ${proposal.path}. ${savedSettingEffect(proposal.path)}`,
				};
			} catch (error) {
				return { kind: "error", message: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

function savedSettingEffect(path: string): string {
	if (isRoutingPath(path))
		return "This session keeps its current routing. Exit and start a new Clio session to use the saved routing.";
	switch (settingsChangeKind(path)) {
		case "hotReload":
			return "The running session picks this up automatically after the settings watcher reads the save.";
		case "nextTurn":
			return "After the settings watcher reads the save, this applies to the next request or dispatch; running workers keep their current settings.";
		case "restartRequired":
			return "Exit and start a new Clio session to apply this setting.";
	}
}

function changedSettingLines(path: string, before: unknown, after: unknown): string[] {
	if (JSON.stringify(before) === JSON.stringify(after)) return [];
	const objectMap = (value: unknown): Record<string, unknown> | null =>
		value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	const oldMap = objectMap(before);
	const newMap = objectMap(after);
	if (oldMap || newMap) {
		const keys = new Set([...Object.keys(oldMap ?? {}), ...Object.keys(newMap ?? {})]);
		return [...keys].flatMap((key) => changedSettingLines(`${path}.${key}`, oldMap?.[key], newMap?.[key]));
	}
	return [
		after === undefined
			? `${path}: (removed)`
			: before === undefined
				? `${path}: ${formatControlValue(after)}`
				: `${path}: ${formatControlValue(before)} → ${formatControlValue(after)}`,
	];
}

function boundedSettingPreview(lines: string[]): string {
	const visible = lines.slice(0, 20).map((line) => {
		const clean = sanitizeCallTargetText(line);
		return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
	});
	if (lines.length > visible.length) visible.push(`… ${lines.length - visible.length} more changed values`);
	return visible.join("\n");
}
