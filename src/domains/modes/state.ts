import { ALL_MODES, type ModeName } from "./matrix.js";

/**
 * Minimal in-memory mode state plus setter. Persistence is injected via the
 * onChange callback so extension.ts (slice 5) can emit mode.changed and
 * persist lastMode to settings without this file depending on the config
 * contract.
 */

export interface ModeState {
	current: ModeName;
}

export type ModeChangeListener = (next: ModeName, previous: ModeName, reason?: string) => void;

export interface ModeStateApi {
	get(): ModeName;
	/**
	 * Change the active mode. Fires the onChange callback AFTER the internal
	 * value is updated. Returns the new mode. A no-op set (next === current)
	 * still fires the callback so callers can re-persist if they need to.
	 */
	set(next: ModeName, reason?: string): ModeName;
	/**
	 * Cycle default <-> advise for Shift+Tab. `super` does NOT participate in
	 * the cycle; if currently super, cycleNormal returns default.
	 */
	cycleNormal(): ModeName;
}

export function createModeState(initial: ModeName, onChange?: ModeChangeListener): ModeStateApi {
	let current: ModeName = initial;

	const set = (next: ModeName, reason?: string): ModeName => {
		const previous = current;
		current = next;
		if (onChange) onChange(next, previous, reason);
		return current;
	};

	return {
		get: () => current,
		set,
		cycleNormal: () => {
			if (current === "default") return set("advise", "cycle");
			return set("default", "cycle");
		},
	};
}

/** Validate an arbitrary string and narrow to ModeName. Throws on invalid. */
export function parseModeName(raw: string): ModeName {
	if ((ALL_MODES as ReadonlyArray<string>).includes(raw)) {
		return raw as ModeName;
	}
	throw new Error(`unknown mode: ${raw}`);
}
