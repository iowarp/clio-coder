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
 *   - `platformWarnings()` : user bindings that cannot fire in this terminal
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
import {
	CLIO_APP_KEYBINDING_IDS,
	CLIO_APP_KEYBINDINGS,
	CLIO_KEYBINDINGS,
	type ClioKeybinding,
} from "../domains/config/keybindings.js";
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

export interface TerminalKeySupport {
	name: string;
	supportsCsiU: boolean;
	reason: string;
	altLetterMode?: "meta" | "text";
	ideReservedKeys?: ReadonlyArray<string>;
}

export interface PlatformKeybindingWarning {
	id: string;
	keys: ReadonlyArray<string>;
	terminal: string;
	reason: string;
	source: "default" | "user";
}

export interface ClioKeybindingManager {
	matches(data: string, id: ClioKeybinding): boolean;
	getKeys(id: ClioKeybinding): ReadonlyArray<KeyId>;
	getDescription(id: ClioKeybinding): string;
	getConflicts(): ReadonlyArray<KeybindingConflict>;
	overrideCount(): number;
	invalidCount(): number;
	invalidBindings(): ReadonlyArray<InvalidKeybinding>;
	platformWarnings(): ReadonlyArray<PlatformKeybindingWarning>;
	hotkeyEntries(): ReadonlyArray<{ id: ClioKeybinding; keys: string; description: string; source: "default" | "user" }>;
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
	return `Clio Coder: ${count} invalid keybinding${count === 1 ? "" : "s"} in settings.yaml (defaults kept): ${detail}. Fix settings.yaml or run \`clio doctor\`.\n`;
}

function envValue(env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>, key: string): string {
	return env[key]?.trim() ?? "";
}

export function detectTerminalKeySupport(
	env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): TerminalKeySupport {
	const term = envValue(env, "TERM");
	const termProgram = envValue(env, "TERM_PROGRAM");
	const kittyWindow = envValue(env, "KITTY_WINDOW_ID");
	const normalized = `${term} ${termProgram}`.toLowerCase();
	if (kittyWindow.length > 0 || normalized.includes("xterm-kitty") || normalized.includes("kitty")) {
		return { name: "kitty", supportsCsiU: true, reason: "Kitty keyboard protocol detected", altLetterMode: "meta" };
	}
	if (normalized.includes("wezterm") || normalized.includes("ghostty")) {
		return {
			name: termProgram || term || "modern terminal",
			supportsCsiU: true,
			reason: "CSI-u capable terminal",
			altLetterMode: "meta",
		};
	}
	if (termProgram === "Apple_Terminal" || termProgram === "iTerm.app") {
		return {
			name: termProgram,
			supportsCsiU: false,
			reason: "macOS terminal may treat Option-letter as text input",
			altLetterMode: "text",
		};
	}
	if (termProgram.toLowerCase() === "vscode") {
		return {
			name: "vscode",
			supportsCsiU: false,
			reason: "VS Code terminal does not reliably emit CSI-u",
			altLetterMode: "meta",
			ideReservedKeys: ["ctrl+p", "shift+ctrl+p", "ctrl+l"],
		};
	}
	if (term.startsWith("screen") || term.startsWith("tmux")) {
		return { name: term, supportsCsiU: false, reason: "terminal multiplexer may block CSI-u", altLetterMode: "meta" };
	}
	return {
		name: termProgram || term || "legacy terminal",
		supportsCsiU: false,
		reason: "CSI-u support not detected",
		altLetterMode: "meta",
	};
}

export function keyRequiresCsiU(keyId: string): boolean {
	const parts = keyId.toLowerCase().split("+");
	if (parts.length < 3) return false;
	const base = parts[parts.length - 1] ?? "";
	const modifiers = new Set(parts.slice(0, -1));
	if (!modifiers.has("shift") || !modifiers.has("ctrl")) return false;
	if (base.length !== 1) return false;
	const code = base.charCodeAt(0);
	const isLetter = code >= 97 && code <= 122;
	const isDigit = code >= 48 && code <= 57;
	return isLetter || isDigit || BASE_SYMBOL_KEYS.has(base);
}

function normalizeBindingValue(value: KeyId | KeyId[] | undefined): string[] {
	if (value === undefined) return [];
	return (Array.isArray(value) ? value : [value]).map(String);
}

function defaultBindingValue(id: ClioKeybinding): string[] {
	const value = CLIO_APP_KEYBINDINGS[id].defaultKeys;
	return normalizeBindingValue(value as KeyId | KeyId[]);
}

function normalizeKeyForRisk(keyId: string): string {
	return keyId.toLowerCase().replace(/^ctrl\+shift\+/, "shift+ctrl+");
}

function keyUsesAltLetter(keyId: string): boolean {
	const parts = keyId.toLowerCase().split("+");
	if (parts.length !== 2 || parts[0] !== "alt") return false;
	const base = parts[1] ?? "";
	return base.length === 1 && base >= "a" && base <= "z";
}

function terminalReservedReason(keyId: string): string | null {
	const key = normalizeKeyForRisk(keyId);
	if (key === "ctrl+s" || key === "ctrl+q") return "terminal flow control may intercept this chord";
	if (key === "ctrl+z") return "shell job control may suspend the process";
	return null;
}

function keyRiskReason(keyId: string, support: TerminalKeySupport): string | null {
	const key = normalizeKeyForRisk(keyId);
	if (!support.supportsCsiU && keyRequiresCsiU(key)) return `needs CSI-u; ${support.reason}`;
	if (support.altLetterMode === "text" && keyUsesAltLetter(key)) return support.reason;
	if (support.ideReservedKeys?.map(normalizeKeyForRisk).includes(key)) return `${support.name} may reserve this chord`;
	return terminalReservedReason(key);
}

export function detectPlatformKeybindingWarnings(
	userBindings: Readonly<KeybindingsConfig>,
	support: TerminalKeySupport = detectTerminalKeySupport(),
): ReadonlyArray<PlatformKeybindingWarning> {
	const warnings: PlatformKeybindingWarning[] = [];
	for (const id of CLIO_APP_KEYBINDING_IDS) {
		const userValue = userBindings[id];
		const source = userValue === undefined ? "default" : "user";
		const keys = userValue === undefined ? defaultBindingValue(id) : normalizeBindingValue(userValue);
		const risky = keys.filter((key) => keyRiskReason(key, support) !== null);
		if (risky.length === 0) continue;
		const firstReason = keyRiskReason(risky[0] ?? "", support) ?? support.reason;
		warnings.push({ id, keys: risky, terminal: support.name, reason: firstReason, source });
	}
	return warnings;
}

export function formatPlatformKeybindingNotice(warnings: ReadonlyArray<PlatformKeybindingWarning>): string {
	const count = warnings.reduce((sum, entry) => sum + entry.keys.length, 0);
	const detail = warnings
		.flatMap((entry) => entry.keys.map((key) => `${entry.id}="${key}" (${entry.source}, ${entry.reason})`))
		.join(", ");
	return `Clio keybinding notice: ${count} keybinding${count === 1 ? "" : "s"} may not fire reliably in this terminal: ${detail}. Rebind in settings.yaml or inspect /hotkeys.\n`;
}

function joinKeys(keys: ReadonlyArray<KeyId>): string {
	if (keys.length === 0) return "(unbound)";
	if (keys.length === 1) return String(keys[0]);
	return keys.join(" / ");
}

function buildManager(
	inner: KeybindingsManager,
	invalid: ReadonlyArray<InvalidKeybinding>,
	platformWarnings: ReadonlyArray<PlatformKeybindingWarning>,
): ClioKeybindingManager {
	const frozen = invalid.map((entry) => ({ id: entry.id, keys: [...entry.keys] as ReadonlyArray<string> }));
	const frozenPlatformWarnings = platformWarnings.map((entry) => ({
		id: entry.id,
		keys: [...entry.keys] as ReadonlyArray<string>,
		terminal: entry.terminal,
		reason: entry.reason,
		source: entry.source,
	}));
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
		platformWarnings() {
			return frozenPlatformWarnings;
		},
		hotkeyEntries() {
			const userBindings = inner.getUserBindings();
			return CLIO_APP_KEYBINDING_IDS.map((id) => ({
				id,
				keys: joinKeys(inner.getKeys(id as Keybinding)),
				description: inner.getDefinition(id as Keybinding).description ?? "",
				source: userBindings[id] === undefined ? ("default" as const) : ("user" as const),
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
export function createKeybindingManager(
	settings: Readonly<ClioSettings>,
	env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): ClioKeybindingManager {
	const { valid, invalid } = validateKeybindings(settings.keybindings ?? {});
	const inner = new KeybindingsManager(CLIO_KEYBINDINGS, valid);
	setKeybindings(inner);
	return buildManager(inner, invalid, detectPlatformKeybindingWarnings(valid, detectTerminalKeySupport(env)));
}

/** Pure test hook: build a manager from a raw settings snapshot without touching the pi-tui global. */
export function createKeybindingManagerForTesting(
	overrides: Readonly<Record<string, string | string[]>> = {},
	env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = {},
): ClioKeybindingManager {
	const { valid, invalid } = validateKeybindings(overrides);
	const inner = new KeybindingsManager(CLIO_KEYBINDINGS, valid);
	return buildManager(inner, invalid, detectPlatformKeybindingWarnings(valid, detectTerminalKeySupport(env)));
}
