import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { type ClioSettings, readSettings, updateSettings, validateSettings } from "../core/config.js";
import { getAtPath, isRoutingPath } from "../core/session-routing.js";
import { applyControlValue, formatControlValue, settingControl } from "../core/settings-controls.js";
import { ToolNames } from "../core/tool-names.js";
import { clioStateDir } from "../core/xdg.js";
import { settingsChangeKind } from "../domains/config/classify.js";
import { findBuiltinRuntimeBootMetadata } from "../domains/providers/runtimes/boot-manifest.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { CLIO_SETTINGS_RULE_ID, isFleetRoutingPath, ROUTING_PIN_HINT } from "../domains/safety/routing-settings.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolConfirmation, ToolSpec } from "./registry.js";

interface ConfigureClioDeps {
	/** An operator is attached who can answer the approval card. False for headless runs. */
	interactive: boolean;
	getAutonomy?: () => AutonomyLevel;
}

type Change =
	| { kind: "control"; path: string; value: string }
	| { kind: "target"; id: string; target: TargetDescriptor };

interface Proposal {
	id: string;
	path: string;
	change: Change;
	before: string;
	preview: string;
	expiresAt: number;
}

/**
 * Settings the model may propose. Safety, permissions, autonomy, trust,
 * integrations, telemetry, keybindings and auto-update stay with the operator.
 */
const ELIGIBLE_PATHS: ReadonlySet<string> = new Set([
	"chat.target",
	"chat.model",
	"chat.thinkingLevel",
	"chat.modelPicker.cycleSet",
	"chat.modelPicker.favorites",
	"chat.modelPicker.recentLimit",
	"chat.maxOutputTokens",
	"chat.prewarm",
	"chat.cacheKeepalive",
	"fleet.defaultNode",
	"fleet.profiles",
	"fleet.rosters",
	"fleet.agentProfiles",
	"fleet.concurrency",
	"context.memory.target",
	"context.memory.model",
	"interface.exitSummary",
	"interface.demo",
	"interface.terminalProgress",
	"interface.outputDetail",
	"interface.mode",
	"interface.fullscreenScrollbar",
	"interface.smoothStreaming",
	"interface.desktopNotifications",
	"interface.panes.notifications",
	"interface.panes.layout",
	"interface.panes.workers.ratio",
	"interface.panes.files.enabled",
	"interface.panes.files.mode",
	"interface.panes.files.profile",
	"interface.panes.files.followCwd",
	"interface.panes.files.ratio",
]);
const ELIGIBLE_PREFIXES = ["chat.retry.", "fleet.default.", "fleet.limits.", "fleet.retry."] as const;

function eligiblePath(path: string): boolean {
	return (
		(ELIGIBLE_PATHS.has(path) || ELIGIBLE_PREFIXES.some((prefix) => path.startsWith(prefix))) &&
		settingControl(path) !== undefined
	);
}

const TARGET_PATH = /^targets\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const TARGET_FIELDS = new Set(["runtime", "url", "defaultModel", "wireModels", "gateway", "capabilities", "auth"]);
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SECRET_QUERY = /key|token|secret|password|passwd|sig|auth/iu;

/**
 * Why this call may only propose, or null when the operator can approve an
 * apply here. The one place that decides it, so a later autonomy design can
 * change it without touching the tool. At yolo nobody answers the card (#407),
 * headless has no operator, and a read-only run writes nothing.
 */
export function configureClioApplyRefusal(context: {
	autonomy: AutonomyLevel | undefined;
	interactive: boolean;
	readOnly: boolean;
}): string | null {
	if (context.readOnly) return "this run is read-only";
	if (!context.interactive) return "no operator is attached to approve it (headless run)";
	if (context.autonomy === "yolo") return "at autonomy yolo nobody reviews the approval card";
	if (context.autonomy !== "default") return "the session autonomy is unknown";
	return null;
}

/**
 * Clio's guided self-configuration. The model previews one change to the
 * user's saved settings; the operator approves the exact diff on the
 * registry's confirmation card, which journals the approval, and the save
 * goes through the settings writer and is appended to the settings change log.
 * Where nobody can approve (headless, read-only, yolo) a preview is a
 * proposal: the diff plus the steps the operator runs. One pending proposal
 * per session keeps the card and the stale-value check unambiguous. It never
 * accepts credentials, safety or trust settings, or arbitrary paths.
 */
export function createConfigureClioTool(deps: ConfigureClioDeps): ToolSpec {
	let pending: Proposal | null = null;
	const refusal = (readOnly: boolean): string | null =>
		configureClioApplyRefusal({ autonomy: deps.getAutonomy?.(), interactive: deps.interactive, readOnly });
	return {
		name: ToolNames.ConfigureClio,
		description:
			"Propose a change to Clio's saved user settings, then apply the exact proposal after the operator approves its diff. action=preview with a path and a text value returns the diff; action=apply with that proposalId shows the operator an approval card. Paths: chat routing and model picker, fleet.default.*, fleet.profiles, fleet.agentProfiles, fleet.rosters, fleet.concurrency, fleet.limits.*, fleet.retry.*, context.memory.target/model, interface display settings, and targets.<id> whose value is a JSON object with runtime, url, defaultModel, wireModels, gateway, capabilities and auth.apiKeyEnvVar (the NAME of an environment variable) or auth.oauthProfile. For agent model bindings preview fleet.profiles first, then fleet.agentProfiles; each value is a complete JSON map. Never pass API keys or secrets; credentials are stored by the operator with clio-coder auth login. Headless, read-only and yolo runs can only preview: hand the operator the diff and steps it returns. Safety, permissions, autonomy, trust and credentials are changed only by the operator. For a one-off run, pin dispatch's target and model instead of saving routing.",
		placement: "gateway",
		parameters: Type.Object({
			action: StringEnum(["preview", "apply"]),
			path: Type.Optional(Type.String()),
			value: Type.Optional(Type.String()),
			proposalId: Type.Optional(Type.String()),
		}),
		baseActionClass: "write",
		executionMode: "sequential",
		confirmationFor(args): ToolConfirmation | undefined {
			if (args.action !== "apply" || !pending || args.proposalId !== pending.id) return undefined;
			if (refusal(false) !== null) return undefined;
			const routing = isFleetRoutingPath(pending.path);
			return {
				ruleId: routing ? "fleet-routing-settings" : CLIO_SETTINGS_RULE_ID,
				detail: `configure_clio saves this change to your user settings (settings.yaml):\n${pending.preview}`,
				hints: routing ? [ROUTING_PIN_HINT] : [],
			};
		},
		async run(args, options) {
			const path = typeof args.path === "string" ? args.path.trim() : undefined;
			const inputValue = typeof args.value === "string" ? args.value.trim() : undefined;
			if (path === "safety.autonomy" || pending?.path === "safety.autonomy") {
				return {
					kind: "error",
					message: "autonomy is changed only by the operator through /settings, clio-coder configure, or --autonomy",
				};
			}
			const blocked = refusal(options?.turnConstraints?.readOnly === true);
			if (args.action === "preview") {
				if (path === undefined || inputValue === undefined) {
					return { kind: "error", message: "preview requires path and value strings" };
				}
				if (Buffer.byteLength(inputValue, "utf8") > 8192) {
					return { kind: "error", message: "settings value exceeds 8192 bytes" };
				}
				try {
					const saved = readSettings();
					const built = buildChange(saved, path, inputValue);
					if ("error" in built) return { kind: "error", message: built.error };
					const { change, candidate } = built;
					const valuePath = changePath(change);
					const before = JSON.stringify(valueAt(saved, change));
					const after = JSON.stringify(valueAt(candidate, change));
					if (before === after) return { kind: "ok", output: `${path} already has the requested value; nothing to apply.` };
					const issues = validateSettings(JSON.parse(JSON.stringify(candidate))).issues;
					if (issues.length > 0) {
						return {
							kind: "error",
							message: `the change would make the settings invalid: ${issues
								.slice(0, 5)
								.map((issue) => `${issue.path}: ${issue.message}`)
								.join("; ")}`,
						};
					}
					const affected = changedSettingLines(valuePath, valueAt(saved, change), valueAt(candidate, change));
					if (path === "chat.target" && saved.chat.model !== candidate.chat.model) {
						affected.push(
							`chat.model: ${formatControlValue(saved.chat.model)} → ${formatControlValue(candidate.chat.model)}`,
						);
					}
					const preview = boundedSettingPreview(affected);
					const routing = isFleetRoutingPath(valuePath) ? ` ${ROUTING_PIN_HINT}` : "";
					if (blocked !== null) {
						pending = null;
						return {
							kind: "ok",
							output: `Proposed saved settings change (not applied: ${blocked}):\n${preview}\n\n${operatorSteps(change)}\nShow the operator this diff and these steps; do not try to apply it another way.${routing}`,
						};
					}
					pending = {
						id: randomUUID(),
						path: valuePath,
						change,
						before,
						preview,
						expiresAt: Date.now() + 10 * 60_000,
					};
					return {
						kind: "ok",
						output: `Proposed saved settings change:\n${preview}\n\nCall configure_clio(action="apply", proposalId="${pending.id}") to show the operator the approval card. This proposal expires in 10 minutes.${routing}`,
					};
				} catch (error) {
					return { kind: "error", message: error instanceof Error ? error.message : String(error) };
				}
			}
			if (blocked !== null) {
				pending = null;
				return {
					kind: "error",
					message: `configure_clio cannot apply here: ${blocked}. Preview the change and hand the operator the diff and steps it returns.`,
				};
			}
			if (args.action !== "apply" || typeof args.proposalId !== "string" || !pending || args.proposalId !== pending.id) {
				return { kind: "error", message: "no matching settings proposal; preview the change again" };
			}
			const proposal = pending;
			pending = null;
			if (Date.now() > proposal.expiresAt)
				return { kind: "error", message: "settings proposal expired; preview it again" };
			try {
				if (JSON.stringify(valueAt(readSettings(), proposal.change)) !== proposal.before) {
					return { kind: "error", message: "saved setting changed since preview; preview it again" };
				}
				updateSettings((current) => {
					if (JSON.stringify(valueAt(current, proposal.change)) !== proposal.before) {
						throw new Error("saved setting changed during approval; preview it again");
					}
					applyChange(current, proposal.change);
					return current;
				});
				recordSettingsChange(proposal, options?.sessionId);
				return {
					kind: "ok",
					output: `Saved ${proposal.path}. ${savedSettingEffect(proposal.path)}`,
					// The apply call carries only the proposal id; the transcript row names the setting from this.
					details: { path: proposal.path },
				};
			} catch (error) {
				return { kind: "error", message: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

function changePath(change: Change): string {
	return change.kind === "target" ? `targets.${change.id}` : change.path;
}

function valueAt(settings: Readonly<ClioSettings>, change: Change): unknown {
	return change.kind === "target"
		? settings.targets.find((target) => target.id === change.id)
		: getAtPath(settings, change.path);
}

function applyChange(settings: ClioSettings, change: Change): void {
	if (change.kind === "control") {
		applyControlValue(settings, change.path, change.value);
		return;
	}
	const index = settings.targets.findIndex((target) => target.id === change.id);
	if (index < 0) settings.targets.push(structuredClone(change.target));
	else settings.targets[index] = structuredClone(change.target);
}

/** The target a `targets.<id>` path names: a saved id as written, or a new id without dots. */
function targetIdOf(saved: ClioSettings, path: string): { id: string } | { error: string } | null {
	if (!path.startsWith("targets.")) return null;
	const id = path.slice("targets.".length);
	if (saved.targets.some((target) => target.id === id)) return { id };
	if (TARGET_PATH.test(path)) return { id };
	return {
		error: `path ${JSON.stringify(path)} names no target; use targets.<id> with a JSON object value, for example targets.gw with {"url":"http://host:4000/v1"}`,
	};
}

function buildChange(
	saved: ClioSettings,
	path: string,
	value: string,
): { change: Change; candidate: ClioSettings } | { error: string } {
	const targetId = targetIdOf(saved, path);
	if (targetId !== null && "error" in targetId) return targetId;
	if (targetId !== null) {
		const merged = mergeTarget(
			saved.targets.find((target) => target.id === targetId.id),
			targetId.id,
			value,
		);
		if ("error" in merged) return merged;
		const change: Change = { kind: "target", id: targetId.id, target: merged.target };
		const candidate = structuredClone(saved);
		applyChange(candidate, change);
		return { change, candidate };
	}
	if (!eligiblePath(path)) {
		return {
			error:
				"this setting cannot be changed through configure_clio; safety, permissions, autonomy, trust, credentials and integrations are changed only by the operator through /settings or clio-coder configure",
		};
	}
	const change: Change = { kind: "control", path, value };
	const candidate = structuredClone(saved);
	applyChange(candidate, change);
	return { change, candidate };
}

/**
 * The target a `targets.<id>` proposal saves: the model's fields over the
 * saved target, so fields it may not touch (pricing, cache, lifecycle,
 * concurrency, trust, runtime sub-config) survive unchanged.
 */
function mergeTarget(
	existing: TargetDescriptor | undefined,
	id: string,
	value: string,
): { target: TargetDescriptor } | { error: string } {
	let patch: unknown;
	try {
		patch = JSON.parse(value);
	} catch {
		return { error: 'a targets.<id> value is a JSON object, for example {"runtime":"litellm","url":"http://host:4000"}' };
	}
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
		return { error: "a targets.<id> value is a JSON object" };
	}
	const fields = patch as Record<string, unknown>;
	const refused = Object.keys(fields).filter((key) => !TARGET_FIELDS.has(key));
	if (refused.length > 0) {
		return {
			error: `configure_clio cannot set ${refused.map((key) => `targets.${id}.${key}`).join(", ")}; it may set runtime, url, defaultModel, wireModels, gateway, capabilities, auth.apiKeyEnvVar and auth.oauthProfile. Pricing, lifecycle, concurrency, trust and runtime sub-settings are the operator's.`,
		};
	}
	const target: TargetDescriptor = existing ? structuredClone(existing) : { id, runtime: "" };
	if ("runtime" in fields) {
		if (typeof fields.runtime !== "string" || findBuiltinRuntimeBootMetadata(fields.runtime) === null) {
			return {
				error: `unknown runtime ${JSON.stringify(fields.runtime)}; clio-coder configure --list names the runtimes`,
			};
		}
		target.runtime = fields.runtime;
	}
	if (target.runtime === "") return { error: `a new target needs a runtime, for example {"runtime":"litellm"}` };
	if ("url" in fields) {
		const url = fields.url;
		if (typeof url !== "string") return { error: "url is a string" };
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return { error: `url ${JSON.stringify(url)} is not a URL` };
		}
		if (parsed.username !== "" || parsed.password !== "") {
			return { error: "the url must not carry credentials; name the key's environment variable in auth.apiKeyEnvVar" };
		}
		if ([...parsed.searchParams.keys()].some((key) => SECRET_QUERY.test(key))) {
			return { error: "the url must not carry a key or token in its query" };
		}
		target.url = url;
	}
	for (const key of ["defaultModel"] as const) {
		if (key in fields) {
			if (typeof fields[key] !== "string" || fields[key] === "") return { error: `${key} is a non-empty string` };
			target[key] = fields[key] as string;
		}
	}
	if ("wireModels" in fields) {
		const models = fields.wireModels;
		if (!Array.isArray(models) || !models.every((model) => typeof model === "string")) {
			return { error: "wireModels is an array of model id strings" };
		}
		target.wireModels = [...(models as string[])];
	}
	if ("gateway" in fields) {
		if (typeof fields.gateway !== "boolean") return { error: "gateway is true or false" };
		target.gateway = fields.gateway;
	}
	if ("capabilities" in fields) {
		const capabilities = fields.capabilities;
		if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
			return { error: "capabilities is a JSON object" };
		}
		target.capabilities = { ...(target.capabilities ?? {}), ...(capabilities as TargetDescriptor["capabilities"]) };
	}
	if ("auth" in fields) {
		const auth = fields.auth;
		if (auth === null || typeof auth !== "object" || Array.isArray(auth)) return { error: "auth is a JSON object" };
		const entries = auth as Record<string, unknown>;
		const extra = Object.keys(entries).filter((key) => key !== "apiKeyEnvVar" && key !== "oauthProfile");
		if (extra.length > 0) {
			return {
				error: `configure_clio never stores credentials; auth may name only apiKeyEnvVar (an environment variable NAME) or oauthProfile. The operator stores a key with clio-coder auth login ${id}.`,
			};
		}
		const next = { ...(target.auth ?? {}) };
		if ("apiKeyEnvVar" in entries) {
			if (typeof entries.apiKeyEnvVar !== "string" || !ENV_NAME.test(entries.apiKeyEnvVar)) {
				return {
					error: "auth.apiKeyEnvVar is the NAME of an environment variable, such as LITELLM_API_KEY, never the key",
				};
			}
			next.apiKeyEnvVar = entries.apiKeyEnvVar;
		}
		if ("oauthProfile" in entries) {
			if (typeof entries.oauthProfile !== "string" || !/^[\w.@-]{1,128}$/u.test(entries.oauthProfile)) {
				return { error: "auth.oauthProfile is a profile name" };
			}
			next.oauthProfile = entries.oauthProfile;
		}
		target.auth = next;
	}
	return { target };
}

/** What the operator runs when Clio may only propose. */
function operatorSteps(change: Change): string {
	if (change.kind === "target") {
		const target = change.target;
		const flags = [
			`--id ${target.id}`,
			`--runtime ${target.runtime}`,
			...(target.url ? [`--url ${target.url}`] : []),
			...(target.defaultModel ? [`--model ${target.defaultModel}`] : []),
			...(target.auth?.apiKeyEnvVar ? [`--api-key-env ${target.auth.apiKeyEnvVar}`] : []),
			...(target.gateway ? ["--gateway"] : []),
		];
		return `Operator steps: run \`clio-coder configure ${flags.join(" ")}\`, or open /settings in an interactive Clio session at autonomy default and ask Clio to apply this proposal there. A key is stored by the operator with \`clio-coder auth login ${target.id}\`.`;
	}
	return `Operator steps: open /settings in an interactive Clio session and set ${change.path}, or ask Clio there at autonomy default to apply this proposal, or edit it with \`clio-coder configure --edit\`.`;
}

function recordSettingsChange(proposal: Proposal, sessionId: string | undefined): void {
	try {
		const line = {
			at: new Date().toISOString(),
			source: "configure_clio",
			...(sessionId !== undefined ? { sessionId } : {}),
			path: proposal.path,
			changes: proposal.preview.split("\n"),
		};
		appendFileSync(join(clioStateDir(), "settings-changes.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
	} catch {
		// The save already landed and the approval is journaled; the log is a convenience.
	}
}

function savedSettingEffect(path: string): string {
	if (path.startsWith("targets."))
		return "New sessions and dispatches see the target; switch a running chat with /model or /targets.";
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
