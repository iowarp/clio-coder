/**
 * Runtime keybinding manager. Wraps pi-tui's `KeybindingsManager` with
 * Clio's definition table (CLIO_KEYBINDINGS) and any user overrides loaded
 * from `settings.yaml.keybindings`. Exposes a narrow surface so the
 * interactive layer and overlays never reach into pi-tui directly:
 *
 *   - `matches(data, id)`  : replaces raw byte comparisons in the router
 *   - `getKeys(id)`        : resolved KeyId[] for a binding, for help display
 *   - `getDescription(id)` : short description used by `/help`
 *   - `getConflicts()`     : duplicate-binding diagnostics for /settings
 *   - `hotkeyEntries()`    : ordered list for the global /help section
 *   - `overrideCount()`    : count of entries the user has customized
 *   - `invalidCount()`     : count of user entries that failed validation
 *   - `invalidBindings()`  : details for the /settings diagnostic row
 *   - `platformWarnings()` : user bindings that cannot fire in this terminal
 *
 * The manager also installs itself as pi-tui's global via `setKeybindings`
 * so editor/select components honor overrides out of the box.
 *
 * User overrides go through `validateKeybindings` first. Unmappable strings
 * (e.g. `clio-coder.exit: "banana"`) are dropped so they cannot silently replace
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

export interface LeaderTarget {
	key: string;
	id: Keybinding;
	label?: string;
	disabledReason?: string;
}

export interface ClioKeybindingManager {
	matches(data: string, id: Keybinding): boolean;
	getKeys(id: Keybinding): ReadonlyArray<KeyId>;
	getDescription(id: Keybinding): string;
	readonly generation: number;
	reload(overrides: Readonly<Record<string, string | string[]>>): void;
	onReload(listener: () => void): () => void;
	isDisabled(id: Keybinding): boolean;
	actionLabel(id: Keybinding): string;
	getConflicts(): ReadonlyArray<KeybindingConflict>;
	overrideCount(): number;
	invalidCount(): number;
	invalidBindings(): ReadonlyArray<InvalidKeybinding>;
	platformWarnings(): ReadonlyArray<PlatformKeybindingWarning>;
	leaderTargets(): ReadonlyArray<LeaderTarget>;
	hotkeyEntries(): ReadonlyArray<{ id: Keybinding; keys: string; description: string; source: "default" | "user" }>;
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
function canonicalKey(key: string): string {
	const parts = key.toLowerCase().split("+");
	let base = parts.pop() ?? "";
	if (base === "esc") base = "escape";
	if (base === "return") base = "enter";
	const modifiers = ["ctrl", "alt", "shift", "super"].filter((mod) => parts.includes(mod));
	return [...modifiers, base].join("+");
}

function isValidKeyId(keyId: unknown): boolean {
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
 * Normalize and validate the raw `settings.interface.keybindings` block. Invalid
 * entries are dropped from the returned `valid` config so pi-tui keeps
 * the default binding in effect; callers render `invalid` as a diagnostic.
 */
export function validateKeybindings(raw: Readonly<Record<string, string | string[]>>): ValidationResult {
	const valid: KeybindingsConfig = {};
	const invalid: InvalidKeybinding[] = [];
	for (const [id, value] of Object.entries(raw)) {
		if (!Object.hasOwn(CLIO_KEYBINDINGS, id)) {
			invalid.push({ id, keys: ["unknown action ID; use /help"] });
			continue;
		}
		if (typeof value === "string") {
			if (isValidKeyId(value)) {
				valid[id] = canonicalKey(value) as KeyId;
			} else {
				invalid.push({ id, keys: [value] });
			}
			continue;
		}
		if (Array.isArray(value)) {
			const accepted: KeyId[] = [];
			const rejected: string[] = [];
			for (const entry of value) {
				if (typeof entry !== "string") {
					rejected.push(String(entry));
					continue;
				}
				if (isValidKeyId(entry)) {
					accepted.push(canonicalKey(entry) as KeyId);
				} else {
					rejected.push(entry);
				}
			}
			if (accepted.length > 0 || value.length === 0) valid[id] = accepted;
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
	return `Clio Coder: ${count} invalid keybinding${count === 1 ? "" : "s"} in settings.yaml (defaults kept): ${detail}. Fix settings.yaml or run \`clio-coder doctor\`.\n`;
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
	if (termProgram === "Apple_Terminal") {
		return {
			name: termProgram,
			supportsCsiU: false,
			reason: "Terminal.app sends Option-letter as composed text unless Use Option as Meta key is enabled",
			altLetterMode: "text",
		};
	}
	if (termProgram === "iTerm.app") {
		return {
			name: termProgram,
			supportsCsiU: true,
			reason: "iTerm2 reports modified keys as Meta or CSI-u",
			altLetterMode: "meta",
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

function keyRequiresCsiU(keyId: string): boolean {
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

function altLetterBase(keyId: string): string | null {
	const parts = keyId.toLowerCase().split("+");
	if (parts.length !== 2 || parts[0] !== "alt") return null;
	const base = parts[1] ?? "";
	return base.length === 1 && base >= "a" && base <= "z" ? base : null;
}

function keyUsesAltLetter(keyId: string): boolean {
	return altLetterBase(keyId) !== null;
}

function terminalReservedReason(keyId: string): string | null {
	const key = normalizeKeyForRisk(keyId);
	if (key === "ctrl+s")
		return "an intermediary may intercept this chord; Node raw mode normally disables terminal flow control";
	if (key === "ctrl+z")
		return "an intermediary may intercept this chord; Node raw mode normally disables signal generation";
	return null;
}

function keyRiskReason(keyId: string, support: TerminalKeySupport): string | null {
	const key = normalizeKeyForRisk(keyId);
	if (!support.supportsCsiU && keyRequiresCsiU(key)) return `needs CSI-u; ${support.reason}`;
	if (support.altLetterMode === "text" && keyUsesAltLetter(key)) return support.reason;
	if (support.ideReservedKeys?.map(normalizeKeyForRisk).includes(key)) return `${support.name} may reserve this chord`;
	return terminalReservedReason(key);
}

const MACOS_OPTION_DEFAULT_WARNING_ID = "clio-coder.macos.option-letter.defaults";

export function detectPlatformKeybindingWarnings(
	userBindings: Readonly<KeybindingsConfig>,
	support: TerminalKeySupport = detectTerminalKeySupport(),
): ReadonlyArray<PlatformKeybindingWarning> {
	const warnings: PlatformKeybindingWarning[] = [];
	const macosDefaultAltKeys: string[] = [];
	for (const id of CLIO_APP_KEYBINDING_IDS) {
		const userValue = userBindings[id];
		const source = userValue === undefined ? "default" : "user";
		const keys = userValue === undefined ? defaultBindingValue(id) : normalizeBindingValue(userValue);
		const risky = keys.filter((key) => keyRiskReason(key, support) !== null);
		if (risky.length === 0) continue;
		const firstReason = keyRiskReason(risky[0] ?? "", support) ?? support.reason;
		if (source === "default" && support.name === "Apple_Terminal" && risky.every(keyUsesAltLetter)) {
			macosDefaultAltKeys.push(...risky);
			continue;
		}
		warnings.push({ id, keys: risky, terminal: support.name, reason: firstReason, source });
	}
	if (macosDefaultAltKeys.length > 0) {
		warnings.unshift({
			id: MACOS_OPTION_DEFAULT_WARNING_ID,
			keys: [...new Set(macosDefaultAltKeys)],
			terminal: support.name,
			reason: support.reason,
			source: "default",
		});
	}
	return warnings;
}

function isMacosOptionDefaultWarning(warning: PlatformKeybindingWarning): boolean {
	return warning.id === MACOS_OPTION_DEFAULT_WARNING_ID;
}

export function formatPlatformKeybindingNotice(warnings: ReadonlyArray<PlatformKeybindingWarning>): string {
	const macosOption = warnings.find(isMacosOptionDefaultWarning);
	if (macosOption && warnings.length === 1) {
		const keys = macosOption.keys
			.map((key) => {
				const base = altLetterBase(key);
				return base ? `Alt+${base.toUpperCase()}` : key;
			})
			.join(", ");
		return `Clio keybinding notice: Terminal.app may not send Option-letter shortcuts by default (${keys}). Enable Use Option as Meta key in Settings ▸ Profiles ▸ Keyboard for native Alt, or use Ctrl+G then the shortcut letter, slash commands (/help lists commands), and /help.\n`;
	}
	const count = warnings.reduce((sum, entry) => sum + entry.keys.length, 0);
	const detail = warnings
		.flatMap((entry) => entry.keys.map((key) => `${entry.id}="${key}" (${entry.source}, ${entry.reason})`))
		.join(", ");
	return `Clio keybinding notice: ${count} keybinding${count === 1 ? "" : "s"} may not fire reliably in this terminal: ${detail}. Rebind in settings.yaml or inspect /help.\n`;
}

function joinKeys(keys: ReadonlyArray<KeyId>): string {
	if (keys.length === 0) return "(unbound)";
	if (keys.length === 1) return String(keys[0]);
	return keys.join(" / ");
}

const VIEWPORT_LEADER_TARGETS: LeaderTarget[] = [
	{ key: "z", id: "tui.editor.undo" },
	{ key: "r", id: "tui.altScreen.search" },
	{ key: "p", id: "tui.altScreen.pageUp" },
	{ key: "n", id: "tui.altScreen.pageDown" },
	{ key: "home", id: "tui.altScreen.top" },
	{ key: "end", id: "tui.altScreen.bottom" },
	{ key: "", id: "tui.altScreen.previousPrompt" },
	{ key: "", id: "tui.altScreen.nextPrompt" },
];

function keybindingScope(id: string): string {
	if (id.startsWith("clio-coder.")) return "composer";
	if (id.startsWith("tui.select.")) return "selection";
	if (/tui.altScreen.search(Next|Previous|Close)/u.test(id)) return "search";
	if (id.startsWith("tui.altScreen.")) return "fullscreen composer";
	return "editable field";
}

function legacyKey(key: string): string {
	const canonical = canonicalKey(key);
	return (
		({ "ctrl+i": "tab", "ctrl+m": "enter", "ctrl+[": "escape", "ctrl+_": "ctrl+-" } as Record<string, string>)[
			canonical
		] ?? canonical
	);
}

/** Selection, search and editable input deliberately share delivered keys. */
function scopesOverlap(a: string, b: string): boolean {
	const left = keybindingScope(a),
		right = keybindingScope(b);
	if (left === "selection" || right === "selection") return left === right;
	if (left === "search" || right === "search") return left === right;
	if (
		(a === "clio-coder.exit" && b === "tui.editor.deleteCharForward") ||
		(b === "clio-coder.exit" && a === "tui.editor.deleteCharForward")
	)
		return false;
	return true;
}

function effectiveConflicts(inner: KeybindingsManager): KeybindingConflict[] {
	const keys = new Map<string, string[]>();
	for (const id of Object.keys(CLIO_KEYBINDINGS) as Keybinding[]) {
		for (const key of inner.getKeys(id)) {
			const canonical = legacyKey(key);
			const ids = keys.get(canonical) ?? [];
			if (!ids.includes(id)) ids.push(id);
			keys.set(canonical, ids);
		}
	}
	return [...keys]
		.filter(
			([, ids]) =>
				ids.length > 1 && ids.some((id, index) => ids.slice(index + 1).some((other) => scopesOverlap(id, other))),
		)
		.map(([key, keybindings]) => ({
			key: key as KeyId,
			keybindings: keybindings.filter((id) => keybindings.some((other) => other !== id && scopesOverlap(id, other))),
		}));
}

function buildManager(
	overrides: Readonly<Record<string, string | string[]>>,
	env: Readonly<Record<string, string | undefined>>,
	install: boolean,
): ClioKeybindingManager {
	let validated = validateKeybindings(overrides);
	const inner = new KeybindingsManager(CLIO_KEYBINDINGS, validated.valid);
	if (install) setKeybindings(inner);
	let generation = 0;
	const listeners = new Set<() => void>();
	const isDisabled = (id: Keybinding): boolean => {
		const value = inner.getUserBindings()[id];
		return Array.isArray(value) && value.length === 0;
	};
	const leaderTargets = (): LeaderTarget[] => {
		if (inner.getKeys("clio-coder.leader").length === 0) return [];
		const app = CLIO_APP_KEYBINDING_IDS.flatMap((id) => {
			const descriptor = CLIO_APP_KEYBINDINGS[id];
			return "leader" in descriptor ? [{ key: descriptor.leader, id }] : [];
		});
		return [...app, ...VIEWPORT_LEADER_TARGETS].filter(({ id }) => !isDisabled(id));
	};
	const actionLabel = (id: Keybinding): string => {
		const keys = inner.getKeys(id);
		const suffix = leaderTargets().find((entry) => entry.id === id)?.key;
		return (
			[keys.join(" / "), suffix ? `${inner.getKeys("clio-coder.leader")[0]} ${suffix}` : ""].filter(Boolean).join(" · ") ||
			"unbound; see /help"
		);
	};
	return {
		matches: (data, id) => inner.matches(data, id),
		getKeys: (id) => inner.getKeys(id),
		getDescription: (id) => inner.getDefinition(id).description ?? "",
		getConflicts: () => effectiveConflicts(inner),
		get generation() {
			return generation;
		},
		reload(next) {
			validated = validateKeybindings(next);
			inner.setUserBindings(validated.valid);
			if (install) setKeybindings(inner);
			generation += 1;
			for (const listener of listeners) listener();
		},
		onReload(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		isDisabled,
		actionLabel,
		overrideCount: () => Object.keys(validated.valid).length,
		invalidCount: () => validated.invalid.reduce((sum, entry) => sum + entry.keys.length, 0),
		invalidBindings: () => validated.invalid,
		platformWarnings: () => detectPlatformKeybindingWarnings(validated.valid, detectTerminalKeySupport(env)),
		leaderTargets,
		hotkeyEntries: () =>
			(Object.keys(CLIO_KEYBINDINGS) as Keybinding[]).map((id) => ({
				id,
				keys: joinKeys(inner.getKeys(id)),
				description: `${inner.getDefinition(id).description ?? ""} (${keybindingScope(id)}${isDisabled(id) ? "; disabled by user" : ""})${id === "tui.input.copy" ? "; composer Ctrl+C cancels; use native terminal clipboard" : ""}`,
				source: validated.valid[id] === undefined ? "default" : "user",
			})),
	};
}

export function createKeybindingManager(
	settings: Readonly<ClioSettings>,
	env: Readonly<Record<string, string | undefined>> = process.env,
): ClioKeybindingManager {
	return buildManager(settings.interface.keybindings ?? {}, env, true);
}

export function createKeybindingManagerForTesting(
	overrides: Readonly<Record<string, string | string[]>> = {},
	env: Readonly<Record<string, string | undefined>> = {},
): ClioKeybindingManager {
	return buildManager(overrides, env, false);
}
