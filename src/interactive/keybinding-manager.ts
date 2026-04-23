/**
 * Runtime keybinding manager. Wraps pi-tui's `KeybindingsManager` with
 * Clio's definition table (CLIO_KEYBINDINGS) and any user overrides loaded
 * from `settings.yaml.keybindings`. Exposes a narrow surface so the
 * interactive layer and overlays never reach into pi-tui directly:
 *
 *   - `matches(data, id)` — replaces raw byte comparisons in the router
 *   - `getKeys(id)`       — resolved KeyId[] for a binding, for help display
 *   - `getDescription(id)`— short description used by `/hotkeys`
 *   - `getConflicts()`    — duplicate-binding diagnostics for /settings
 *   - `hotkeyEntries()`   — ordered list for the global /hotkeys section
 *   - `overrideCount()`   — count of entries the user has customized
 *
 * The manager also installs itself as pi-tui's global via `setKeybindings`
 * so editor/select components honor overrides out of the box.
 */

import type { ClioSettings } from "../core/config.js";
import { CLIO_APP_KEYBINDING_IDS, CLIO_KEYBINDINGS, type ClioKeybinding } from "../domains/config/keybindings.js";
import {
	type Keybinding,
	type KeybindingConflict,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
	setKeybindings,
} from "../engine/tui.js";

export interface ClioKeybindingManager {
	matches(data: string, id: ClioKeybinding): boolean;
	getKeys(id: ClioKeybinding): ReadonlyArray<KeyId>;
	getDescription(id: ClioKeybinding): string;
	getConflicts(): ReadonlyArray<KeybindingConflict>;
	overrideCount(): number;
	hotkeyEntries(): ReadonlyArray<{ id: ClioKeybinding; keys: string; description: string }>;
}

function normalizeConfig(raw: Readonly<Record<string, string | string[]>>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" && value.length > 0) {
			config[key] = value as KeyId;
			continue;
		}
		if (Array.isArray(value)) {
			const filtered = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
			if (filtered.length > 0) config[key] = filtered as KeyId[];
		}
	}
	return config;
}

function joinKeys(keys: ReadonlyArray<KeyId>): string {
	if (keys.length === 0) return "(unbound)";
	if (keys.length === 1) return String(keys[0]);
	return keys.join(" / ");
}

/**
 * Build a `ClioKeybindingManager` from the provided settings snapshot. The
 * resulting manager is also installed as pi-tui's global so editor and
 * select components pick up the same overrides. Callers are expected to
 * recreate the manager if `settings.keybindings` is replaced wholesale;
 * partial live updates should instead go through `manager` state.
 */
export function createKeybindingManager(settings: Readonly<ClioSettings>): ClioKeybindingManager {
	const userConfig = normalizeConfig(settings.keybindings ?? {});
	const inner = new KeybindingsManager(CLIO_KEYBINDINGS, userConfig);
	setKeybindings(inner);

	return {
		matches(data, id) {
			return inner.matches(data, id as Keybinding);
		},
		getKeys(id) {
			return inner.getKeys(id as Keybinding);
		},
		getDescription(id) {
			return inner.getDefinition(id as Keybinding).description ?? "";
		},
		getConflicts() {
			return inner.getConflicts();
		},
		overrideCount() {
			return Object.keys(inner.getUserBindings()).length;
		},
		hotkeyEntries() {
			return CLIO_APP_KEYBINDING_IDS.map((id) => ({
				id,
				keys: joinKeys(inner.getKeys(id as Keybinding)),
				description: inner.getDefinition(id as Keybinding).description ?? "",
			}));
		},
	};
}

/** Pure test hook: build a manager from a raw settings snapshot without touching the pi-tui global. */
export function createKeybindingManagerForTesting(
	overrides: Readonly<Record<string, string | string[]>> = {},
): ClioKeybindingManager {
	const inner = new KeybindingsManager(CLIO_KEYBINDINGS, normalizeConfig(overrides));
	return {
		matches(data, id) {
			return inner.matches(data, id as Keybinding);
		},
		getKeys(id) {
			return inner.getKeys(id as Keybinding);
		},
		getDescription(id) {
			return inner.getDefinition(id as Keybinding).description ?? "";
		},
		getConflicts() {
			return inner.getConflicts();
		},
		overrideCount() {
			return Object.keys(inner.getUserBindings()).length;
		},
		hotkeyEntries() {
			return CLIO_APP_KEYBINDING_IDS.map((id) => ({
				id,
				keys: joinKeys(inner.getKeys(id as Keybinding)),
				description: inner.getDefinition(id as Keybinding).description ?? "",
			}));
		},
	};
}
