import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { readSettings, updateSettings } from "../core/config.js";
import { getAtPath } from "../core/session-routing.js";
import { applyControlValue, formatControlValue, settingControl } from "../core/settings-controls.js";
import { ToolNames } from "../core/tool-names.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
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
	/^(?:chat\.(?:target|model|thinkingLevel|modelPicker\.[a-zA-Z.]+)|fleet\.(?:default\.[a-zA-Z]+|profiles|agentProfiles|concurrency|limits\.[a-zA-Z]+)|context\.memory\.(?:target|model)|safety\.autonomy)$/u;

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
			"Preview a Clio routing or fleet setting, then apply the exact proposal. Default asks the operator to approve; yolo applies directly. Default cannot raise autonomy. Use action=preview with a settings path and text value; action=apply with proposalId.",
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
			const autonomy = deps.getAutonomy?.();
			if (autonomy !== "default" && autonomy !== "yolo") {
				return {
					kind: "error",
					message: "configure_clio is available only in default or yolo mode",
				};
			}
			if (args.action === "preview") {
				if (typeof args.path !== "string" || typeof args.value !== "string") {
					return { kind: "error", message: "preview requires path and value strings" };
				}
				if (!ELIGIBLE_PATH.test(args.path) || !settingControl(args.path)) {
					return {
						kind: "error",
						message: "this setting cannot be changed through configure_clio; use /settings or configure",
					};
				}
				if (Buffer.byteLength(args.value, "utf8") > 8192) {
					return { kind: "error", message: "settings value exceeds 8192 bytes" };
				}
				try {
					const value = args.value;
					// Below yolo the model may lower its own autonomy but never propose
					// raising it: one hurried Apply would hand it the authority it asked for.
					if (autonomy === "default" && args.path === "safety.autonomy" && value === "yolo") {
						return {
							kind: "error",
							message: `configure_clio cannot raise autonomy above ${autonomy}; the operator changes that in /settings`,
						};
					}
					const saved = readSettings();
					const candidate = structuredClone(saved);
					applyControlValue(candidate, args.path, value);
					const before = JSON.stringify(getAtPath(saved, args.path));
					const after = JSON.stringify(getAtPath(candidate, args.path));
					if (before === after)
						return { kind: "ok", output: `${args.path} already has the requested value; nothing to apply.` };
					const affected = [
						`${args.path}: ${formatControlValue(getAtPath(saved, args.path))} → ${formatControlValue(getAtPath(candidate, args.path))}`,
					];
					if (args.path === "chat.target" && saved.chat.model !== candidate.chat.model) {
						affected.push(
							`chat.model: ${formatControlValue(saved.chat.model)} → ${formatControlValue(candidate.chat.model)}`,
						);
					}
					pending = {
						id: randomUUID(),
						path: args.path,
						value,
						before,
						preview: affected.join("\n"),
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
					output: `Saved ${proposal.path}. This session keeps its current routing; reload Clio to use saved routing here. Other settings can hot reload where supported.`,
				};
			} catch (error) {
				return { kind: "error", message: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
