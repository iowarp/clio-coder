import type { ClioSettings } from "../core/config.js";
import type { ConfigChangeSource } from "../core/telemetry/live-events.js";
import type { AskUserHandler, AskUserQuestion } from "../tools/ask-user.js";

/**
 * Turning yolo on from the terminal (#407). Yolo is the operator's
 * skip-permissions mode, so its first interactive activation shows a short
 * card saying what it does, and only an explicit accept records
 * `safety.yoloAccepted` in the operator's user settings and switches. As root
 * outside a container it is refused outright. The leader key, /settings and a
 * yolo the session was started with all pass through here.
 */

export type SettingScope = "session" | "project" | "global";

export const YOLO_ACCEPT_LABEL = "Turn on yolo";
export const YOLO_DECLINE_LABEL = "Stay at default";

/** The acceptance card, asked through the existing ask_user card. */
function yoloAcceptanceQuestion(): AskUserQuestion {
	return {
		header: "Yolo",
		question: [
			"Turn on yolo? It is built for long unattended jobs:",
			"- No approval stops. Edits, commands, scripts, git history changes and outward actions run as called, and questions take their recommended option.",
			"- No sandbox by default. Commands and scripts run as you unless safety.sandbox is required.",
			"- The floor still blocks deleting or overwriting /, your home directory or a system tree, mkfs, wipefs, writes to a block device, fork bombs, and writes into Clio's own config, state and trust records. Rules in an approved .clio-coder/safety.yaml hold.",
			"- Workspace snapshots and the telemetry journals stay on, so /rewind can restore files. Yolo is refused as root outside a container.",
			"You accept once; safety.yoloAccepted in your user settings records it.",
		].join("\n"),
		options: [
			{ label: YOLO_ACCEPT_LABEL, description: "Record the acceptance and switch to yolo." },
			{ label: YOLO_DECLINE_LABEL, description: "Keep approval stops; nothing is saved." },
		],
	};
}

export interface YoloActivationDeps {
	getSettings(): ClioSettings | undefined;
	/** The root refusal read once at boot, or null when yolo may run here. */
	refusal: string | null;
	/** The ungated settings commit; `source` names the surface the edit came from (#434). */
	commitSetting(id: string, next: ClioSettings, scope: SettingScope, source?: ConfigChangeSource): void;
	/** Shows the acceptance card; the existing transient ask_user card. */
	ask: AskUserHandler;
	/** Frees the screen for the card, closing an overlay such as /settings. */
	prepareScreen(): void;
	notify(level: "info" | "warning" | "error", text: string, key: string): void;
	/** Runs after a commit the card made, so the surface can announce and redraw. */
	afterCommit?(): void;
}

export interface YoloActivation {
	/** The settings commit every interactive surface uses, with yolo gated. */
	commit(id: string, next: ClioSettings, scope: SettingScope, source?: ConfigChangeSource): void;
	/** Ask for acceptance of a yolo the session was started with and is holding at default. */
	requestHeldAtBoot(): Promise<void>;
}

export function createYoloActivation(deps: YoloActivationDeps): YoloActivation {
	let asking = false;

	const accept = async (scope: SettingScope, takeScreen: boolean, source?: ConfigChangeSource): Promise<void> => {
		if (asking) return;
		asking = true;
		try {
			// The operator just asked for yolo, so the card may replace /settings;
			// at boot it waits for a free screen instead of closing anything.
			if (takeScreen) deps.prepareScreen();
			const result = await deps.ask([yoloAcceptanceQuestion()]);
			if (result.unavailable === true) {
				deps.notify(
					"info",
					"Yolo needs a one-time acceptance; turn it on again once the screen is free.",
					"safety:yolo-accept",
				);
				return;
			}
			if (result.cancelled === true || result.answers[0]?.options?.includes(YOLO_ACCEPT_LABEL) !== true) {
				deps.notify("info", "Yolo stays off; autonomy is default.", "safety:yolo-accept");
				return;
			}
			const current = deps.getSettings();
			if (current === undefined) return;
			const accepted = structuredClone(current);
			accepted.safety.yoloAccepted = true;
			// The acceptance is the operator's own, so it is saved to user settings.
			deps.commitSetting("safety.yoloAccepted", accepted, "global", source);
			const switched = structuredClone(deps.getSettings() ?? accepted);
			switched.safety.autonomy = "yolo";
			deps.commitSetting("safety.autonomy", switched, scope, source);
			deps.afterCommit?.();
		} catch (error) {
			deps.notify(
				"error",
				`Yolo was not turned on: ${error instanceof Error ? error.message : String(error)}`,
				"safety:yolo-accept",
			);
		} finally {
			asking = false;
		}
	};

	return {
		commit(id, next, scope, source) {
			const current = deps.getSettings();
			const turningOn = id === "safety.autonomy" && next.safety.autonomy === "yolo" && current?.safety.autonomy !== "yolo";
			if (!turningOn) {
				deps.commitSetting(id, next, scope, source);
				return;
			}
			if (deps.refusal !== null) {
				deps.notify("warning", deps.refusal, "safety:yolo-refused");
				return;
			}
			if (current?.safety.yoloAccepted === true) {
				deps.commitSetting(id, next, scope, source);
				return;
			}
			// The caller (a keypress, the /settings overlay) finishes its own frame
			// first; the card then takes the screen.
			void Promise.resolve().then(() => accept(scope, true, source));
		},
		requestHeldAtBoot() {
			if (deps.getSettings() === undefined || deps.refusal !== null) return Promise.resolve();
			return accept("session", false);
		},
	};
}
