import { isRoutingPath } from "../../core/session-routing.js";
import { settingControl } from "../../core/settings-controls.js";
import type { SettingsOrigin } from "../../core/settings-layers.js";
import { renderUsdLimit } from "../../core/telemetry/render.js";
import { settingsChangeKind } from "../../domains/config/classify.js";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { fitRows } from "../overlay-frame.js";
import {
	type ClioTheme,
	chip,
	chipRow,
	type Fact,
	factRows,
	GLYPH,
	positionRow,
	sectionRule,
	selectionRow,
	tableRows,
	titleRow,
	valueRow,
	valueRowLayout,
} from "../theme/index.js";
import type { SettingsCenterItem, SettingsValueSegment } from "./settings.js";

/**
 * How the settings center paints what the catalog builds. Everything here is a
 * pure function of the theme, a width and the row data: the center owns the
 * state and composes these into its lanes, and nothing here reads settings.
 */

/** Where the effective value of a row came from; `session` is an override held in process memory. */
export type SettingValueOrigin = SettingsOrigin | "session";

const SETTINGS_CHOICE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	"safety.autonomy": { default: "Default", yolo: "YOLO" },
	"fleet.permissions.mode": {
		judge: "Safety judge",
		deny: "Deny the tool",
		fail: "Stop the worker",
		escalate: "Ask me",
	},
	"fleet.permissions.escalation.fallback": { deny: "Deny the tool", fail: "Stop the worker" },
	"integrations.externalAgents.defaults.toolGovernance": {
		"clio-coder-policy": "Clio permissions",
		"agent-managed": "Agent permissions",
		"deny-all": "Deny all tools",
	},
	"context.workingSet.policy": {
		"structural-v1": "Structure (classic)",
		"structural-v2": "Structure (current)",
		"age-horizon": "Age only",
	},
	"context.workingSet.profile": {
		default: "Default",
		"data-analysis": "Data analysis",
		"web-design": "Web design",
	},
	"interface.outputDetail": { compact: "Compact", standard: "Standard", detailed: "Detailed" },
	"interface.mode": { regular: "Scrollback", fullscreen: "Full screen" },
	"interface.fullscreenScrollbar": { hidden: "Hidden", auto: "Automatic", always: "Always" },
	"interface.smoothStreaming": { off: "Off", auto: "Automatic", on: "On" },
	"interface.panes.enabled": { off: "Off", auto: "Automatic" },
	"interface.panes.notifications": { failures: "Failures only", all: "All updates", off: "Off" },
	"interface.panes.layout": { off: "Off", workers: "Workers", cockpit: "Workers and files" },
	"interface.panes.files.mode": { companion: "Stay open", chooser: "Choose once" },
	"interface.panes.files.profile": { managed: "Clio theme", user: "My file manager" },
	"fleet.worktrees.root": { disk: "Disk", tmpfs: "Memory", auto: "Automatic" },
};

export function formatSettingsValue(path: string, value: string): string {
	const control = settingControl(path);
	const named = SETTINGS_CHOICE_LABELS[path]?.[value];
	if (named) return named;
	if (control?.kind === "boolean" && value === "true") return "On";
	if (control?.kind === "boolean" && value === "false") return "Off";
	if (path === "integrations.git.commitAttribution" && value === "enabled") return "On";
	if (path === "integrations.git.commitAttribution" && value === "disabled") return "Off";
	if (path.endsWith("thinkingLevel") && value && value !== "(unset)" && value !== "(automatic)")
		return value === "xhigh" ? "Extra high" : `${value[0]?.toUpperCase()}${value.slice(1)}`;
	if (
		value === "(automatic)" ||
		(value === "auto" && (control?.choices?.includes("auto") || path === "fleet.concurrency"))
	)
		return "Automatic";
	if (value === "(empty)" || value === "(none)") return "None";
	if (value === "(off)") return "Off";
	if (value === "(unset)") return "Not set";
	if (value === "(connection default)") return "Connection default";
	if (value === "(session target)") return "Chat connection";
	if (value === "(orchestrator target)") return "Chat model";
	if (value === "(config directory)") return "Default location";
	if (value === "(local only)") return "Local only";
	if (value === "(unconfirmed)") return "Not confirmed";
	if (value === "(built-in)") return "Built in";
	if (value === "(defaults)") return "Default keys";
	if (value === "(turn end only)") return "At turn end";
	if (path === "turnControl.workflows" && !value.startsWith("["))
		return `${value.split(",").filter((entry) => entry.trim().length > 0).length} enabled`;
	if (path === "chat.maxOutputTokens" && value === "0") return "Model limit";
	if (path === "context.workingSet.minEvictableTokens" && value === "0") return "Any size";
	if ((path === "chat.retry.maxRetries" || path === "fleet.retry.maxRetries") && value === "0") return "No retries";
	if (path === "chat.retry.firstTokenStallMs" && value === "0") return "Wait indefinitely";
	if (path === "fleet.retry.routeCooldownMs" && value === "0") return "No wait";
	if ((control?.kind === "list" || control?.kind === "json") && (value.startsWith("[") || value.startsWith("{"))) {
		try {
			const collection: unknown = JSON.parse(value);
			const count = Array.isArray(collection)
				? collection.length
				: collection !== null && typeof collection === "object"
					? Object.keys(collection).length
					: 0;
			if (path === "turnControl.workflows") return `${count} enabled`;
			if (path === "fleet.rosters") return count === 0 ? "No rosters" : `${count} rosters`;
			if (path === "fleet.nodes") return count === 0 ? "No remote nodes" : `${count} remote nodes`;
			if (path === "interface.keybindings") return count === 0 ? "Default keys" : `${count} custom keys`;
			if (path === "integrations.externalAgents.entries")
				return count === 0 ? "No external agents" : `${count} external agents`;
			if (path === "fleet.adaptiveRouting.agentRoles") return count === 0 ? "No active routes" : `${count} active routes`;
			if (path === "chat.modelPicker.favorites") return count === 0 ? "No favorites" : `${count} favorites`;
			return `${count} ${count === 1 ? "entry" : "entries"}`;
		} catch {
			// The editor shows the unparsed value while an invalid draft is being corrected.
		}
	}
	if (control?.kind !== "number" && path !== "fleet.concurrency") return value;
	const number = Number(value);
	if (!value.trim() || !Number.isFinite(number)) return value;
	if (path.endsWith("Ms") || path.endsWith("TimeoutMs") || path.endsWith("DelayMs")) {
		if (path === "integrations.externalAgents.defaults.turnTimeoutMs" && number === 0) return "No limit";
		if (number >= 60_000 && number % 60_000 === 0) return `${number / 60_000} min`;
		if (number >= 1_000 && number % 1_000 === 0) return `${number / 1_000} sec`;
		return `${number.toLocaleString()} ms`;
	}
	if (path.endsWith("Seconds")) {
		if (number >= 60 && number % 60 === 0) return `${number / 60} min`;
		return `${number.toLocaleString()} sec`;
	}
	if (path.endsWith("Bytes")) return `${(number / 1024).toLocaleString()} KB`;
	if (path === "safety.limits.sessionCostUsd") return renderUsdLimit(number);
	if (
		path === "context.compaction.threshold" ||
		path === "context.workingSet.target" ||
		path === "context.workingSet.rearmFraction" ||
		path.endsWith(".ratio")
	)
		return `${Math.round(number * 100)}%`;
	return number.toLocaleString();
}

export function settingsPathLabel(path: string): string {
	const control = settingControl(path);
	if (control) return control.label;
	if (path === "targets" || path.startsWith("targets.")) return "Connections";
	if (path.startsWith("fleet.agentProfiles.")) return `Agent ${path.slice("fleet.agentProfiles.".length)} profile`;
	if (path.startsWith("fleet.profiles.")) {
		const [, name, field] = path.match(/^fleet\.profiles\.([^.]+)(?:\.(.+))?$/) ?? [];
		const part =
			field === "target"
				? "connection"
				: field === "thinkingLevel"
					? "thinking level"
					: field === "node"
						? "placement"
						: field;
		return `Profile ${name ?? ""}${part ? ` ${part}` : ""}`;
	}
	const last = path.split(".").at(-1) ?? path;
	return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * When a change to this row reaches the running system, in the vocabulary of
 * the config-change classification: the same answer the change plan gives
 * after a value is chosen, stated before the operator opens the row.
 */
export function effectTiming(item: SettingsCenterItem): string | null {
	if (item.presentationKind === "group-header" || item.id === "targets" || item.id === "targets.add-cta") return null;
	if (item.id.startsWith("maintenance.")) return null;
	if (item.scope === "restart") return "after restart";
	if (item.id.startsWith("targets.")) return "chat now · workers next dispatch";
	if (item.id.startsWith("workers.") || item.configPath.startsWith("fleet.")) return "next dispatch";
	if (item.readOnly) return null;
	if (settingsChangeKind(item.configPath) === "nextTurn" && !isRoutingPath(item.configPath)) return "next request";
	return "now";
}

/** The short form beside a value: which layer set it. Built-in defaults say nothing; the row's default mark already does. */
function originChip(origin: SettingValueOrigin | null | undefined): string | null {
	switch (origin) {
		case "session":
			return "session";
		case "project":
		case "project.local":
			return "project";
		case "user":
			return "user";
		case "cli":
			return "cli";
		default:
			return null;
	}
}

/** The long form in the inspector: which file or state holds the value, as a noun phrase. */
function originPhrase(origin: SettingValueOrigin | null | undefined): string | null {
	switch (origin) {
		case "session":
			return "this session, not saved";
		case "project":
			return "project settings.yaml";
		case "project.local":
			return "project settings.local.yaml";
		case "user":
			return "user settings.yaml";
		case "cli":
			return "a command-line flag";
		case "built-in":
			return "built-in default";
		default:
			return null;
	}
}

/** The origin as a sentence fragment for the fact strip: `from user settings.yaml`, `set this session, not saved`. */
function originFact(origin: SettingValueOrigin | null | undefined): string | null {
	const phrase = originPhrase(origin);
	if (phrase === null) return null;
	return origin === "session" ? `set ${phrase}` : origin === "built-in" ? phrase : `from ${phrase}`;
}

export function isModified(item: SettingsCenterItem): boolean {
	return !item.readOnly && item.defaultValue !== undefined && item.currentValue !== item.defaultValue;
}

function paintSegments(
	theme: ClioTheme,
	segments: ReadonlyArray<SettingsValueSegment>,
	selected: boolean,
	readOnly: boolean,
): string {
	return segments
		.map((segment) => {
			switch (segment.tone) {
				case "healthy":
					return theme.fg("success", segment.text);
				case "degraded":
					return theme.fg("warning", segment.text);
				case "unhealthy":
					return theme.fg("error", segment.text);
				case "unknown":
					return theme.fg("unknownValue", segment.text);
				case "activity":
					return theme.fg("activity", segment.text);
				default:
					return theme.fg("fieldValue", segment.text, readOnly ? "readOnly" : selected ? "selected" : "normal");
			}
		})
		.join("");
}

export interface SettingRowState {
	selected: boolean;
	/** The value on screen: the Space preview while one is pending, the current value otherwise. */
	displayValue: string;
	pending: boolean;
	pinned: boolean;
	origin: SettingValueOrigin | null;
}

/** The label column every row of a list shares: the widest label, capped so values keep room. */
export function settingsLabelWidth(items: ReadonlyArray<SettingsCenterItem>): number {
	const widest = items.reduce(
		(max, item) => (item.presentationKind === "group-header" ? max : Math.max(max, visibleWidth(item.label))),
		8,
	);
	return Math.min(widest, 34);
}

/**
 * A value that names a target or model keeps its tail when it must shorten;
 * the suffix is what tells two builds apart. A prose value on the same path
 * (`Connection default`) has spaces and is cut at its end like any sentence.
 */
function isIdentityValue(item: SettingsCenterItem, value: string): boolean {
	if (/\s/u.test(stripTerminalSequences(value))) return false;
	const last = item.configPath.split(".").at(-1) ?? "";
	return (
		last === "model" ||
		last === "target" ||
		last === "defaultModel" ||
		item.id.startsWith("workers.profiles") ||
		item.id.startsWith("workers.agentBindings") ||
		item.configPath === "chat.modelPicker.cycleSet"
	);
}

/** The value a row shows, painted for its kind and selection state. */
function settingValueText(theme: ClioTheme, item: SettingsCenterItem, state: SettingRowState): string {
	const plain = (): string => formatSettingsValue(item.configPath, state.displayValue);
	if (state.pending) return plain();
	if (item.presentationKind === "read-only-fact")
		return item.valueSegments.length <= 1
			? theme.fg("readOnlyFact", plain())
			: paintSegments(theme, item.valueSegments, state.selected, true);
	if (item.presentationKind === "setting" && item.valueSegments.length <= 1) return plain();
	return paintSegments(theme, item.valueSegments, state.selected, item.readOnly);
}

/**
 * The row's whole value when the lane cannot show all of it, or null when the
 * row fits. The inspector says the whole value then, because a model id cut
 * to its first thirty cells is not the fact the operator came for. The origin
 * yields before the value does, so only the full room counts.
 */
export function clippedSettingValue(
	theme: ClioTheme,
	item: SettingsCenterItem,
	width: number,
	labelWidth: number,
	state: SettingRowState,
): string | null {
	if (item.presentationKind === "group-header" || item.id === "targets.add-cta" || item.targetConsole) return null;
	const shown = stripTerminalSequences(settingValueText(theme, item, state));
	const { valueWidth } = valueRowLayout({ labelWidth, width });
	// A row built from segments (a profile, a node) may arrive already
	// compacted by its builder; its `currentValue` still holds the whole fact.
	const full =
		item.valueSegments.length > 1 && !state.pending
			? item.currentValue
			: formatSettingsValue(item.configPath, state.displayValue);
	const compacted = item.valueSegments.length > 1 && shown.includes(GLYPH.ellipsis) && full !== shown;
	return visibleWidth(shown) <= valueWidth && !compacted ? null : full;
}

export function renderSettingRow(
	theme: ClioTheme,
	item: SettingsCenterItem,
	width: number,
	labelWidth: number,
	state: SettingRowState,
): string {
	// A group rule names a block of rows; the lane's title is the one orange anchor, so the rule stays ivory.
	if (item.presentationKind === "group-header") return sectionRule(theme, width, item.label, { token: "groupHeading" });
	if (item.id === "targets.add-cta") {
		return valueRow(theme, {
			focused: state.selected,
			label: state.selected ? item.label : theme.style("commandHint", item.label, { bold: true }),
			labelWidth,
			value: theme.fg(state.selected ? "selectedOption" : "menuDescription", item.currentValue),
			width,
		});
	}
	const modified = isModified(item);
	const changed = state.pending || modified;
	const value = settingValueText(theme, item, state);
	const label =
		item.presentationKind === "action" && !state.selected
			? theme.style("commandHint", item.label, { bold: true })
			: item.label;
	const origin = state.pending ? "preview" : originChip(state.origin);
	return valueRow(theme, {
		focused: state.selected,
		label,
		labelWidth,
		value,
		changed,
		...(state.pinned ? { mark: theme.fg("annotation", GLYPH.favorite) } : {}),
		...(origin === null ? {} : { origin }),
		...(isIdentityValue(item, value) ? { fit: "identity" as const } : {}),
		disabled: item.readOnly && item.presentationKind !== "status" && item.presentationKind !== "action",
		width,
	});
}

/**
 * The Connections table: one row per target with its health first, so the
 * column that says whether the connection works is the one that survives the
 * narrowest lane. Lower-priority columns drop whole, never a cell at a time.
 * Returns the table's lines and, for the windowing caller, which line each
 * item starts on: the header item owns the column labels and their divider.
 */
export function renderTargetTable(
	theme: ClioTheme,
	items: ReadonlyArray<SettingsCenterItem>,
	selectedId: string | null,
	width: number,
	labelWidth: number,
): { lines: string[]; starts: number[] } {
	const targets = items.filter((item) => item.targetConsole !== undefined);
	const table = tableRows(
		theme,
		{
			header: true,
			columns: [
				{ label: "", min: 1, max: 1, priority: 9 },
				{ label: "Health", min: 7, priority: 8 },
				{ label: "Connection", min: 6, priority: 10 },
				{ label: "Used by", min: 4, priority: 5 },
				{ label: "Type", min: 4, priority: 4 },
				{ label: "Latency", min: 5, priority: 6, align: "right" },
			],
			rows: targets.map((item) => {
				const console = item.targetConsole;
				const focused = item.id === selectedId;
				if (!console) return [];
				return [
					focused ? theme.fg("selectedOption", GLYPH.cursor) : " ",
					paintSegments(theme, [console.health], focused, false),
					focused ? theme.style("selectedOption", console.id, { bold: true }) : theme.fg("modelIdentity", console.id),
					{ text: console.roles, tone: "neutral" },
					{ text: console.runtime, tone: "muted" },
					{ text: console.latency, tone: "muted" },
				];
			}),
		},
		width,
	);
	const lines: string[] = [];
	const starts: number[] = [];
	let targetIndex = 0;
	for (const item of items) {
		starts.push(lines.length);
		if (item.id === "targets") {
			lines.push(...table.slice(0, 2));
			continue;
		}
		if (item.targetConsole) {
			const line = table[2 + targetIndex];
			targetIndex += 1;
			if (line !== undefined) lines.push(line);
			continue;
		}
		lines.push(
			renderSettingRow(theme, item, width, labelWidth, {
				selected: item.id === selectedId,
				displayValue: item.currentValue,
				pending: false,
				pinned: false,
				origin: null,
			}),
		);
	}
	return { lines, starts };
}

export interface SectionLaneRow {
	label: string;
	/** The current section: highlighted whether or not the lane holds the cursor. */
	current: boolean;
	/** The lane holds the cursor and this row is the current one. */
	focused: boolean;
	/** Dim or accent count after the label: changed settings, or matches while filtering. */
	badge?: string;
}

export function renderSectionLane(theme: ClioTheme, rows: ReadonlyArray<SectionLaneRow>, width: number): string[] {
	return rows.map(
		(row) =>
			selectionRow(theme, {
				focused: row.focused,
				label: row.current && !row.focused ? theme.style("selectedOption", row.label, { bold: true }) : row.label,
				...(row.badge === undefined ? {} : { meta: row.badge }),
				width,
			})[0] ?? "",
	);
}

export interface InspectorContext {
	sectionLabel: string;
	sectionDescription: string;
	/** `3 of 12`, the section's place in the catalog. */
	position: string;
	/** The section's size in its own noun (`9 settings`, `3 connections`) and how many rows differ from their default. */
	counts: { label: string; changed: number };
	/** The row under the cursor, or null while the section lane holds it. */
	item: SettingsCenterItem | null;
	/** The row's whole value when the lane cut it; the inspector says it in full. */
	fullValue?: string;
	origin: SettingValueOrigin | null;
	pinned: boolean;
	pinnable: boolean;
	/** The row's home section, shown only from Recent & Pinned. */
	homeLabel?: string;
}

function markCut(lines: ReadonlyArray<string>, kept: number): string[] {
	const out = lines.slice(0, Math.max(0, kept));
	const last = out.at(-1);
	if (lines.length > out.length && last !== undefined) out[out.length - 1] = `${last}${GLYPH.ellipsis}`;
	return out;
}

/** The one-row summary of a section: how many rows it holds and how many were changed. */
function sectionFacts(theme: ClioTheme, counts: InspectorContext["counts"]): Array<string | null> {
	return [
		chip(theme, counts.label, "muted"),
		counts.changed > 0 ? chip(theme, `${counts.changed} changed from default`, "accent", GLYPH.scoped) : null,
	];
}

/** What the row is, said once: its default, where its value came from, what the value means, and how it is reached. */
function itemFacts(theme: ClioTheme, context: InspectorContext, item: SettingsCenterItem): Array<string | null> {
	const facts: Array<string | null> = [];
	if (item.id.startsWith("maintenance.")) facts.push(chip(theme, `run in a terminal: ${item.currentValue}`, "muted"));
	else if (item.id === "targets.add-cta") facts.push(chip(theme, "Enter opens the guided setup", "muted"));
	else if (item.readOnly) facts.push(chip(theme, `read-only here · ${item.affordance}`, "muted"));
	else if (item.presentationKind === "status" || item.presentationKind === "action")
		facts.push(chip(theme, item.affordance, "muted"));
	if (!item.readOnly && item.defaultValue !== undefined) {
		const shown = formatSettingsValue(item.configPath, item.defaultValue);
		facts.push(chip(theme, isModified(item) ? `default was ${shown}` : `default ${shown}`, "muted"));
	}
	const origin = originFact(context.origin);
	if (!item.readOnly && origin !== null && (context.origin !== "built-in" || isModified(item)))
		facts.push(chip(theme, origin, context.origin === "session" ? "accent" : "muted"));
	const meaning = item.valueHelp?.[item.currentValue];
	if (!item.readOnly && meaning) facts.push(chip(theme, meaning, "neutral"));
	if (context.homeLabel !== undefined) facts.push(chip(theme, `in ${context.homeLabel}`, "muted"));
	if (context.pinnable)
		facts.push(chip(theme, context.pinned ? `${GLYPH.favorite} pinned · p unpins` : "p pins", "muted"));
	return facts;
}

/**
 * The strip under the lanes at two-lane widths: a labelled rule that names
 * the row and says when a change lands, the description, and one row of
 * facts. It takes at most four rows, so the list above it keeps the height
 * that used to go to a ten-row footer of mostly blank lines.
 */
export function renderInspector(theme: ClioTheme, context: InspectorContext, width: number, budget: number): string[] {
	if (budget <= 0) return [];
	const safe = Math.max(1, width);
	const item = context.item;
	const rule =
		item === null
			? sectionRule(theme, safe, context.sectionLabel, { meta: context.position })
			: sectionRule(theme, safe, item.label, {
					meta: ((): string => {
						const timing = effectTiming(item);
						return timing === null ? context.position : `applies ${timing}`;
					})(),
				});
	const description = wrapTextWithAnsi(
		theme.fg("body", item === null ? context.sectionDescription : item.description),
		safe,
	);
	const facts = chipRow(
		theme,
		item === null ? sectionFacts(theme, context.counts) : itemFacts(theme, context, item),
		safe,
	);
	// A cut value outranks the description: the row already said what the
	// setting is called, and the one thing the lane could not say is its value.
	const value =
		context.fullValue === undefined
			? []
			: factRows(theme, [{ label: "Value", value: context.fullValue, tone: "neutral" }], safe, { stack: "never" });
	if (budget === 1) return [rule];
	if (budget === 2) return [rule, value[0] ?? (facts.length > 0 ? facts : (description[0] ?? ""))];
	const prose = Math.max(0, budget - 2 - value.length);
	const lines = [rule, ...value, ...markCut(description, Math.min(2, prose))];
	if (facts.length > 0) lines.push(facts);
	return lines.slice(0, budget);
}

/** The narrow page's one or two rows under the list: the rule, then the first line of the description. */
export function renderNarrowInspector(
	theme: ClioTheme,
	context: InspectorContext,
	width: number,
	budget: number,
): string[] {
	if (budget <= 0) return [];
	const lines = renderInspector(theme, context, width, 3);
	if (budget === 1) return lines.slice(1, 2).length > 0 ? lines.slice(1, 2) : lines.slice(0, 1);
	return lines.slice(0, budget);
}

/**
 * The third lane at 120 columns and up: the row's full explanation with its
 * facts as a label/value table and the scope note pinned at the bottom, which
 * is the answer to "where does this land" and keeps its rows when the
 * explanation above is cut.
 */
export function renderDetailLane(theme: ClioTheme, context: InspectorContext, width: number, height: number): string[] {
	const safe = Math.max(1, width);
	const item = context.item;
	if (item === null) {
		const rows = [
			titleRow(theme, context.sectionLabel, safe, { meta: context.position }),
			"",
			...wrapTextWithAnsi(theme.fg("body", context.sectionDescription), safe),
			"",
			chipRow(theme, sectionFacts(theme, context.counts), safe),
		];
		const note = wrapTextWithAnsi(theme.fg("annotation", "Tab or → opens its settings"), safe);
		return pinNote(rows, note, safe, height);
	}
	const timing = effectTiming(item);
	const body: string[] = [
		titleRow(theme, item.label, safe, timing === null ? {} : { meta: `applies ${timing}` }),
		"",
		...wrapTextWithAnsi(theme.fg("body", item.description), safe),
	];
	if (item.help) body.push("", ...wrapTextWithAnsi(theme.fg("help", item.help), safe));
	const facts: Fact[] = [];
	if (context.fullValue !== undefined) facts.push({ label: "Value", value: context.fullValue });
	if (!item.readOnly && item.defaultValue !== undefined)
		facts.push({ label: "Default", value: formatSettingsValue(item.configPath, item.defaultValue), tone: "muted" });
	const origin = originPhrase(context.origin);
	if (!item.readOnly && origin !== null)
		facts.push({ label: "From", value: origin, tone: context.origin === "session" ? "accent" : "neutral" });
	const meaning = item.valueHelp?.[item.currentValue];
	if (!item.readOnly && meaning) facts.push({ label: "Means", value: meaning });
	if (!item.readOnly && item.values && item.values.length > 0)
		facts.push({
			label: "Choices",
			value: item.values.map((value) => formatSettingsValue(item.configPath, value)).join(", "),
			tone: "muted",
		});
	if (context.homeLabel !== undefined) facts.push({ label: "In", value: context.homeLabel, tone: "muted" });
	// Facts keep label and value on one row at every lane width: the lane is
	// never under thirty cells, and a stacked `From` cost two rows and a blank.
	if (facts.length > 0) body.push("", ...factRows(theme, facts, safe, { stack: "never" }));
	const note = wrapTextWithAnsi(theme.fg("annotation", scopeNote(item, context)), safe);
	return pinNote(body, note, safe, height);
}

function scopeNote(item: SettingsCenterItem, context: InspectorContext): string {
	const pin = context.pinnable ? (context.pinned ? ` · ${GLYPH.favorite} pinned, p unpins` : " · p pins") : "";
	if (item.id.startsWith("maintenance.")) return `Run in a terminal: ${item.currentValue}`;
	if (item.id === "targets.add-cta")
		return "Enter opens the guided setup in the dock; Save writes global connection settings";
	if (item.submenu && (item.presentationKind === "status" || item.presentationKind === "action"))
		return `${item.affordance} · nothing changes until an action is confirmed`;
	if (item.readOnly) return `Read-only here · ${item.affordance}`;
	if (item.scope === "restart") return `Enter edits · saved to settings.yaml, applied after a restart${pin}`;
	return `Enter edits · nothing changes until you pick a scope${pin}`;
}

/** Keep the note on the last rows; cut the body above it with a marker when the column is short. */
function pinNote(body: ReadonlyArray<string>, note: ReadonlyArray<string>, width: number, height: number): string[] {
	const noteKept = note.slice(0, Math.max(1, height - 1));
	const bodyBudget = Math.max(0, height - noteKept.length - 1);
	const kept = body.slice(0, bodyBudget);
	while (kept.length > 0 && (kept.at(-1) ?? "").trim().length === 0) kept.pop();
	const marked = markCut(body, kept.length);
	const filler = Array.from({ length: Math.max(0, height - marked.length - noteKept.length) }, () => "");
	return fitRows([...marked, ...filler, ...noteKept], width, height);
}

/** The `3–9 of 14 rows` line a windowed rows lane ends on. */
export function renderRowsPosition(
	theme: ClioTheme,
	position: { start: number; end: number; total: number },
	width: number,
): string {
	return positionRow(theme, { ...position, unit: "rows" }, width);
}
