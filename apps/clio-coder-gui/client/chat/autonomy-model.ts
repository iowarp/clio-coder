// What the autonomy control says. The engine describes its own modes with every session; this app
// repeats those words and never writes its own account of what a mode allows.

import type { Static } from "typebox";
import type { Autonomy } from "../../contracts/autonomy.js";

type AutonomyRead = Static<typeof Autonomy>;
export type AutonomyLevel = AutonomyRead["level"];

const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["default", "yolo"];
const UNDESCRIBED_MODE = "CLIO Coder did not describe this mode.";
export const UNRECOGNIZED_MODE_NOTE =
	"CLIO Coder reported a mode this app does not know. Change it from a terminal session.";

interface AutonomyMenu {
	/** The engine's current mode when this app does not know it; every row is then disabled. */
	unrecognized?: string;
	rows: Array<{ level: AutonomyLevel; description: string; current: boolean; disabled: boolean }>;
	/** The paragraph shown before the second press that switches to `yolo`. */
	confirmation: string;
}

/** The engine's description of one mode, verbatim, or a plain statement that it sent none. */
function modeDescription(autonomy: Pick<AutonomyRead, "modes">, level: AutonomyLevel): string {
	return autonomy.modes?.find((mode) => mode.id === level)?.description ?? UNDESCRIBED_MODE;
}

export function autonomyMenu(autonomy: AutonomyRead): AutonomyMenu {
	const unrecognized = autonomy.unrecognized;
	return {
		...(unrecognized !== undefined ? { unrecognized } : {}),
		rows: AUTONOMY_LEVELS.map((level) => ({
			level,
			description: modeDescription(autonomy, level),
			current: unrecognized === undefined && level === autonomy.level,
			disabled: unrecognized !== undefined,
		})),
		confirmation: `Switch this task to Run without approvals? ${modeDescription(autonomy, "yolo")} It lasts until the task closes.`,
	};
}

/**
 * The autonomy read and the pushed session telemetry describe the same state when their level and
 * source agree. The push is then the newer of the two for the fields the read's projection does not
 * compare, so an unknown mode that clears without a level change still clears on screen.
 */
export function currentAutonomy(read: AutonomyRead, pushed: AutonomyRead | undefined): AutonomyRead {
	return pushed && pushed.level === read.level && pushed.source === read.source ? pushed : read;
}
