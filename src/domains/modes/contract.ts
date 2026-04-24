import type { ToolName } from "../../core/tool-names.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { ModeName } from "./matrix.js";

export interface SuperModeConfirmation {
	requestedBy: string;
	acceptedAt: number;
}

export interface ModesContract {
	current(): ModeName;
	/** Explicit set. For super, caller must have confirmed separately. */
	setMode(next: ModeName, reason?: string): ModeName;
	cycleNormal(): ModeName;

	/** Returns visible tool set for the current mode. */
	visibleTools(): ReadonlySet<ToolName>;
	/** True iff `tool` is visible in the current mode. */
	isToolVisible(tool: ToolName): boolean;
	/** True iff `action` is allowed at the policy gate for the current mode. */
	isActionAllowed(action: ActionClass): boolean;

	/**
	 * Super-mode entry requires explicit confirmation. Emits a `mode.changed`
	 * event with `{from, to:"super", requiresConfirmation:true}`. The caller
	 * (keybinding handler in Phase 9) decides when to flip by calling
	 * confirmSuper after UI acknowledgement.
	 */
	requestSuper(requestedBy: string): void;
	confirmSuper(conf: SuperModeConfirmation): ModeName;

	/**
	 * Return the mode the interactive layer should elevate to so that
	 * `action` becomes admissible, or null when no elevation path exists.
	 * The tool registry calls this to decide whether to park a blocked
	 * call pending user confirmation; worker-side stubs return null so
	 * the worker registry rejects cleanly instead of hanging on a
	 * confirmation UI that does not exist.
	 */
	elevatedModeFor(action: ActionClass): ModeName | null;
}
