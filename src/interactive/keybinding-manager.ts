/**
 * Runtime keybinding manager. Wraps pi-tui's `KeybindingsManager` with
 * Clio's definition table (CLIO_KEYBINDINGS) and any user overrides loaded
 * from `settings.yaml.keybindings`. Exposes a narrow surface so the
 * interactive layer and overlays never reach into pi-tui directly:
 *
 *   - `matches(data, id)`  : replaces raw byte comparisons in the router
 *   - `getKeys(id)`        : resolved KeyId[] for a binding, for help display
 *   - `getDescription(id)` : short description used by `/hotkeys`
 *   - `getConflicts()`     : duplicate-binding diagnostics for /settings
 *   - `hotkeyEntries()`    : ordered list for the global /hotkeys section
 *   - `overrideCount()`    : count of entries the user has customized
 *   - `invalidCount()`     : count of user entries that failed validation
 *   - `invalidBindings()`  : details for the /settings diagnostic row
 *
 * The manager also installs itself as pi-tui's global via `setKeybindings`
 * so editor/select components honor overrides out of the box.
 *
 * User overrides go through `validateKeybindings` first. Unmappable strings
 * (e.g. `clio.exit: "banana"`) are dropped so they cannot silently replace
 * the default binding; they still surface through `invalidBindings()` so
 * `/settings` and the boot stderr notice can point at the offending entry.
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

export interface InvalidKeybinding {
	/** Action id the user tried to rebind. */
	id: string;
	/** The exact strings that failed validation. */
	keys: ReadonlyArray<string>;
}

export interface ClioKeybindingManager {
	matches(data: string, id: ClioKeybinding): boolean;
	getKeys(id: ClioKeybinding): ReadonlyArray<KeyId>;
	getDescription(id: ClioKeybinding): string;
	getConflicts(): ReadonlyArray<KeybindingConflict>;
	overrideCount(): number;
	invalidCount(): number;
	invalidBindings(): ReadonlyArray<InvalidKeybinding>;
	hotkeyEntries(): ReadonlyArray<{ id: ClioKeybinding; keys: string; description: string }>;
}

const BASE_SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
]);

const BASE_SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/**
 * Return true when `keyId` parses to a base key that pi-tui's `matchesKey`
 * can resolve. Mirrors pi-tui's own parser: lowercase, split on `+`, accept
 * up to four distinct modifiers followed by a single base key. Does not
 * attempt to exercise pi-tui's matcher; we just reject identifiers that
 * would silently fail at match time.
 */
export function isValidKeyId(keyId: unknown): boolean {
	if (typeof keyId !== "string" || keyId.length === 0) return false;
	const parts = keyId.toLowerCase().split("+");
	if (parts.length === 0) return false;
	const base = parts[parts.length - 1];
	if (!base) return false;
	const mods = parts.slice(0, -1);
	const seen = new Set<string>();
	for (const mod of mods) {
		if (!MODIFIERS.has(mod)) return false;
		if (seen.has(mod)) return false;
		seen.add(mod);
	}
	if (base.length === 1) {
		const ch = base.charCodeAt(0);
		const isLetter = ch >= 97 && ch <= 122;
		const isDigit = ch >= 48 && ch <= 57;
		return isLetter || isDigit || BASE_SYMBOL_KEYS.has(base);
	}
	return BASE_SPECIAL_KEYS.has(base);
}

interface ValidationResult {
	valid: KeybindingsConfig;
	invalid: ReadonlyArray<InvalidKeybinding>;
}

/**
 * Normalize and validate the raw `settings.keybindings` block. Invalid
 * entries are dropped from the returned `valid` config so pi-tui keeps
 * the default binding in effect; callers render `invalid` as a diagnostic.
 */
export function validateKeybindings(raw: Readonly<Record<string, string | string[]>>): ValidationResult {
	const valid: KeybindingsConfig = {};
	const invalid: InvalidKeybinding[] = [];
	for (const [id, value] of Object.entries(raw)) {
		if (typeof value === "string") {
			if (value.length === 0) continue;
			if (isValidKeyId(value)) {
				valid[id] = value as KeyId;
			} else {
				invalid.push({ id, keys: [value] });
			}
			continue;
		}
		if (Array.isArray(value)) {
			const accepted: KeyId[] = [];
			const rejected: string[] = [];
			for (const entry of value) {
				if (typeof entry !== "string" || entry.length === 0) continue;
				if (isValidKeyId(entry)) {
					accepted.push(entry as KeyId);
				} else {
					rejected.push(entry);
				}
			}
			if (accepted.length > 0) valid[id] = accepted;
			if (rejected.length > 0) invalid.push({ id, keys: rejected });
		}
	}
	return { valid, invalid };
}

/**
 * One-line stderr notice for unmappable user keybindings. We keep the
 * default binding in effect (the invalid entry is dropped before pi-tui
 * sees it); the notice points the operator at the offending ids and the
 * two places to fix them.
 */
export function formatInvalidKeybindingNotice(invalid: ReadonlyArray<InvalidKeybinding>): string {
	const count = invalid.reduce((sum, entry) => sum + entry.keys.length, 0);
	const detail = invalid.flatMap((entry) => entry.keys.map((key) => `${entry.id}="${key}"`)).join(", ");
	return `clio: ${count} invalid keybinding${count === 1 ? "" : "s"} in settings.yaml (defaults kept): ${detail}. Fix settings.yaml or run \`clio doctor\`.\n`;
}

function joinKeys(keys: ReadonlyArray<KeyId>): string {
	if (keys.length === 0) return "(unbound)";
	if (keys.length === 1) return String(keys[0]);
	return keys.join(" / ");
}

function buildManager(inner: KeybindingsManager, invalid: ReadonlyArray<InvalidKeybinding>): ClioKeybindingManager {
	const frozen = invalid.map((entry) => ({ id: entry.id, keys: [...entry.keys] as ReadonlyArray<string> }));
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
		invalidCount() {
			return frozen.reduce((sum, entry) => sum + entry.keys.length, 0);
		},
		invalidBindings() {
			return frozen;
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

/**
 * Build a `ClioKeybindingManager` from the provided settings snapshot. The
 * resulting manager is also installed as pi-tui's global so editor and
 * select components pick up the same overrides. Callers are expected to
 * recreate the manager if `settings.keybindings` is replaced wholesale;
 * partial live updates should instead go through `manager` state.
 */
export function createKeybindingManager(settings: Readonly<ClioSettings>): ClioKeybindingManager {
	const { valid, invalid } = validateKeybindings(settings.keybindings ?? {});
	const inner = new KeybindingsManager(CLIO_KEYBINDINGS, valid);
	setKeybindings(inner);
	return buildManager(inner, invalid);
}

/** Pure test hook: build a manager from a raw settings snapshot without touching the pi-tui global. */
export function createKeybindingManagerForTesting(
	overrides: Readonly<Record<string, string | string[]>> = {},
): ClioKeybindingManager {
	const { valid, invalid } = validateKeybindings(overrides);
	const inner = new KeybindingsManager(CLIO_KEYBINDINGS, valid);
	return buildManager(inner, invalid);
}
