/**
 * The Library browser's projection: one inventory read becomes the rows, the
 * status line and the detail panes the operator actually sees.
 *
 * The overlay owns the keyboard, the lifecycle port
 * owns the writes, and this module owns what is true on screen, so the wording
 * of an origin label or a disabled reason is testable without a terminal.
 *
 * Every pane answers the operator's question first: is this installed here,
 * is it usable, and which keys act on it. The facts follow as a table and the
 * description last, composed from the shared design primitives.
 */

import { readLifecycleReceipts } from "../../core/library-receipts.js";
import type { PluginScope } from "../../domains/plugins/types.js";
import {
	describeLibraryPair,
	type LibraryComponent,
	type LibraryComponentKind,
	type LibraryCopy,
	type LibraryCopyInspection,
	type LibraryCopyUpdate,
	type LibraryEntryKind,
	type LibraryInventory,
	type LibraryOrigin,
	type LibraryPackageRecord,
	type LibraryPairs,
	type LibraryProvidedResource,
} from "../../domains/resources/index.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../../domains/safety/call-target.js";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import { displaySafe } from "../display-safe.js";
import {
	type ClioTheme,
	chip,
	chipRows,
	clioTheme,
	dotSep,
	type Fact,
	factRows,
	fitUnits,
	GLYPH,
	keyCap,
	type StatusKind,
	statusChip,
	statusSeverity,
	titleRow,
} from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";
import { type ListOverlayItem, markdownRows } from "./list-overlay.js";

/** Browse lists install targets; Installed lists the copies and components that exist here. */
export type LibraryMode = "browse" | "installed";

export interface LibraryView {
	category: LibraryEntryKind;
	mode: LibraryMode;
	scope: PluginScope;
	/** Set while drilled into one package's members. */
	member?: { ref: string; scope?: PluginScope } | undefined;
}

/** What one row is, so an action never has to re-parse a row id it printed. */
export type LibraryRowSubject =
	| { kind: "package"; record: LibraryPackageRecord }
	| { kind: "copy"; copy: LibraryCopy }
	| { kind: "component"; resource: LibraryComponent }
	| { kind: "member"; owner: LibraryCopy; member: LibraryCopyInspection["resources"][number] }
	| { kind: "hint"; record: LibraryPackageRecord; hint: LibraryProvidedResource }
	| { kind: "notice"; message: string };

export const LIBRARY_GROUP_INSTALLED = "Installed";
export const LIBRARY_GROUP_AVAILABLE = "Available";
export const LIBRARY_GROUP_MEMBERS = "Members";
export const LIBRARY_GROUP_UNMANAGED = "Not a package";
export const LIBRARY_GROUP_NOTICES = "Notices";

/** Fact tables keep their label column at every width, the way the key detail does. */
const FACT_OPTIONS = { labelRole: "fieldName" as const, stack: "never" as const };

/** External text is never trusted on a row: one line, controls neutralized. */
const safe = sanitizeCallTargetText;

/**
 * A pane in two parts: the head the engine pins while the rest scrolls (the
 * name, the status chips, the keys and the reasons a key is absent), then the
 * facts and the prose.
 */
interface DetailRows {
	head: string[];
	rest: string[];
}

/**
 * Where the bytes came from, in words.
 *
 * Origin is evidence about location and adoption. Format, trust, scope and
 * availability are four other facts and each gets its own column or line, which
 * is why none of them is folded into this string.
 */
export function libraryOriginLabel(origin: LibraryOrigin): string {
	switch (origin.kind) {
		case "bundled":
			return "Bundled with Clio";
		case "remote":
			return "Remote";
		case "local":
			return "Local";
		case "imported":
			return `Imported from ${origin.agent}`;
		case "core":
			return "Core";
		default:
			return "Unknown origin";
	}
}

/** The origin as a row chip: the same fact in fewer cells, so a narrow row keeps its name. */
function libraryOriginShort(origin: LibraryOrigin): string {
	switch (origin.kind) {
		case "bundled":
			return "Bundled";
		case "imported":
			return `From ${origin.agent}`;
		default:
			return libraryOriginLabel(origin);
	}
}

/** The address behind the label: URL, path, catalog or marketplace, whichever the evidence carries. */
function libraryOriginDetail(origin: LibraryOrigin): string | undefined {
	switch (origin.kind) {
		case "bundled":
			return origin.catalog;
		case "remote":
			return [origin.url, origin.catalog].filter(Boolean).join(" · ");
		case "local":
			return [origin.path, origin.catalog].filter(Boolean).join(" · ");
		case "imported":
			return [origin.path, origin.marketplace].filter(Boolean).join(" · ");
		case "core":
			return "src/domains/agents";
		default:
			return origin.detail;
	}
}

/** Vendor packaging format, which is neither a location nor a trust decision. */
function libraryFormatLabel(format: string | undefined): string {
	if (format === "claude-code") return "Claude Code format";
	if (format === "codex") return "Codex format";
	if (format === "portable") return "Portable format";
	if (format === "agent-skill") return "Bare Agent Skills directory";
	return "Format unknown";
}

/** A copy state in words: "loadable" was the loader's term, not what the operator sees happen. */
function copyStateWords(state: string): string {
	switch (state) {
		case "loadable":
			return "active";
		case "shadowed":
			return "overridden";
		case "incompatible":
			return "needs another Clio version";
		case "untrusted":
			return "not trusted";
		default:
			return safe(state);
	}
}

/** Where a copy is and what it is doing there, as one phrase. */
function copyPhrase(scope: string, state: string): string {
	return `${scope}: ${copyStateWords(state)}`;
}

/** A copy state as the outcome glyph it carries, so a damaged copy reads as damaged without color. */
function copyStateStatus(state: string): StatusKind {
	if (state === "loadable") return "ok";
	if (state === "disabled") return "warning";
	if (state === "shadowed") return "cancelled";
	return "error";
}

function availabilityStatus(availability: LibraryComponent["availability"]): StatusKind {
	if (availability === "available") return "ok";
	if (availability === "untrusted") return "warning";
	if (availability === "shadowed") return "cancelled";
	return "error";
}

/**
 * The persistent mode/scope row, at the width it is drawn.
 *
 * Mode and scope survive every width, each with the key that changes it,
 * because they say what the action keys will do and the footer cannot always
 * hold those keys. The notices come next, since a notice is something to act
 * on, and the counts are what gets dropped first: they are useful, and they are
 * not the thing an operator would be wrong about. Chips are dropped whole, so a
 * narrow row never ends on a cut word.
 */
export function libraryStatusLine(
	view: LibraryView,
	counts: { rows: number; notices: number; truncated: boolean },
	width: number,
): string {
	const theme = clioTheme();
	const mode = view.mode === "browse" ? "Browse" : "Installed";
	const scope = view.scope === "user" ? "User" : "Project";
	const unit = view.member ? "member" : view.mode === "browse" ? "package" : "entry";
	const plural = unit === "entry" ? "entries" : `${unit}s`;
	const total = `${counts.rows} ${counts.rows === 1 ? unit : plural}`;
	const wide = width >= 96;
	const keyed = width >= 48;
	const notices =
		counts.notices > 0
			? `${keyCap(theme, "n")} ${theme.fg("warning", `${counts.notices} ${counts.notices === 1 ? "notice" : "notices"}`)}`
			: wide
				? null
				: `${keyCap(theme, "n")} ${theme.fg("annotation", "notices")}`;
	// The current view and scope read as facts, and each key names where it goes, so
	// "[b] Browse" can no longer be read as "press b to browse" while browsing.
	const otherMode = view.mode === "browse" ? (wide ? "installed only" : "Installed") : wide ? "browse all" : "Browse";
	const otherScope = view.scope === "user" ? "Project" : "User";
	const parts = keyed
		? [
				wide ? `${theme.fg("fieldValue", `${mode}:`)} ${theme.fg("annotation", total)}` : theme.fg("fieldValue", mode),
				`${keyCap(theme, "b")} ${theme.fg("annotation", otherMode)}`,
				wide ? `${theme.fg("annotation", "Scope")} ${theme.fg("fieldValue", scope)}` : theme.fg("fieldValue", scope),
				// A notice is something to act on, so it outlasts the key that flips the scope.
				notices,
				`${keyCap(theme, "s")} ${theme.fg("annotation", otherScope)}`,
				wide ? null : theme.fg("annotation", total),
				counts.truncated ? statusChip(theme, "warning", wide ? "incomplete results" : "incomplete") : null,
				view.member && wide
					? theme.fg(
							"annotation",
							`members of ${safe(view.member.ref)}${view.member.scope ? ` (${view.member.scope})` : ""}`,
						)
					: null,
			]
		: [
				theme.fg("fieldValue", mode),
				theme.fg("fieldValue", scope),
				notices,
				theme.fg("annotation", total),
				counts.truncated ? statusChip(theme, "warning", "incomplete") : null,
			];
	// Whole chips are dropped from the right, with the dim ellipsis that says
	// so, rather than a cut that lands inside a word.
	return fitUnits(
		theme,
		"",
		parts.filter((part): part is string => part !== null && part.length > 0),
		width,
	);
}

/** One phrase for a copy its catalog row has moved past. */
function libraryUpdateLabel(update: LibraryCopyUpdate): string {
	return update.reason === "newer-version" ? `update ${update.version} available` : "changed content available";
}

/** The composer text a `use` on this component writes, or null when its use is another surface. */
export function libraryUseInvocation(kind: LibraryComponentKind, name: string): string | null {
	if (kind === "skill") return `/skill ${name} `;
	if (kind === "agent") return `/run ${name} `;
	if (kind === "prompt") return `/${name} `;
	// A playbook's use is its `/fleet run` approval preview, not composer text.
	return null;
}

/** Which keys this row offers, and why the others are absent. */
export interface LibraryRowActions {
	install: boolean;
	remove: boolean;
	enable: boolean;
	update: boolean;
	use: boolean;
	open: boolean;
	/** One sentence per unavailable action, shown in the detail pane rather than as a dead key. */
	reasons: string[];
}

function ownerScopeOf(record: LibraryPackageRecord, scope: PluginScope): { scope: PluginScope } | undefined {
	return record.copies.find((copy) => copy.scope === scope);
}

/**
 * A row's available actions, computed from the same records the row printed.
 *
 * Nothing here guesses. A core or loose component is not a package, so it offers
 * no package lifecycle at all and says so; an unavailable component offers no
 * `use`, because the invocation would fail; and a package with no copy in the
 * selected scope offers install rather than update.
 */
export function libraryRowActions(subject: LibraryRowSubject, view: LibraryView): LibraryRowActions {
	const none: LibraryRowActions = {
		install: false,
		remove: false,
		enable: false,
		update: false,
		use: false,
		open: false,
		reasons: [],
	};
	if (subject.kind === "notice") return none;
	if (subject.kind === "package") {
		const here = ownerScopeOf(subject.record, view.scope);
		const reasons: string[] = [];
		if (subject.record.refusal) reasons.push(subject.record.refusal);
		if (!here) reasons.push(`Not in ${view.scope} scope yet, so there is nothing to update or remove; s switches scope.`);
		return {
			install: !here && !subject.record.refusal,
			remove: !!here,
			enable: !!here,
			update: !!here,
			use: false,
			open: subject.record.copies.length > 0,
			reasons,
		};
	}
	if (subject.kind === "copy") {
		const selected = subject.copy.scope === view.scope;
		const reasons: string[] = [];
		if (!selected)
			reasons.push(
				`This copy is ${subject.copy.scope} scope and actions select ${view.scope}. Press s to select ${subject.copy.scope}.`,
			);
		return {
			install: false,
			remove: selected,
			enable: selected,
			update: selected,
			use: false,
			open: true,
			reasons,
		};
	}
	if (subject.kind === "member") {
		const selected = subject.owner.scope === view.scope;
		const reasons = [`Actions here identify the whole owner ${subject.owner.ref} in ${view.scope} scope.`];
		if (!selected) reasons.push(`The inspected copy is ${subject.owner.scope}; press s to select it.`);
		if (!subject.member.valid) reasons.push("This member did not validate, so it has no use action.");
		return {
			install: false,
			remove: selected,
			enable: selected,
			update: selected,
			use: false,
			open: false,
			reasons,
		};
	}
	if (subject.kind === "hint") {
		return {
			install: !ownerScopeOf(subject.record, view.scope),
			remove: !!ownerScopeOf(subject.record, view.scope),
			enable: false,
			update: false,
			use: false,
			open: false,
			reasons: [
				`A catalog hint from ${subject.record.ref}. It describes what that package says it contains; nothing is loaded until it is installed and verified.`,
			],
		};
	}
	const resource = subject.resource;
	const owner = resource.owner;
	const usable = resource.availability === "available";
	const reasons: string[] = [];
	if (!usable) reasons.push(resource.reason ?? `This resource is ${resource.availability} and cannot be used.`);
	if (!owner)
		reasons.push(
			resource.source.class === "core"
				? "Core components ship with Clio and have no package to install, update or remove."
				: "This file was found directly in a resource root, not installed as a package, so package lifecycle does not apply.",
		);
	const selected = owner?.scope === view.scope;
	if (owner && !selected) reasons.push(`Owned by ${owner.ref} in ${owner.scope} scope; press s to select it.`);
	return {
		install: false,
		remove: !!owner && selected,
		enable: !!owner && selected,
		update: !!owner && selected,
		use: usable,
		open: false,
		reasons,
	};
}

/** Plain fields are external text; callbacks compose only trusted semantic styling. */
/**
 * A row's status chips, worst first, so the chip a narrowing meta keeps is
 * the one that says something is wrong. Each is rendered when the meta is
 * read, so it repaints with the skin.
 */
function worstFirst(chips: ReadonlyArray<readonly [StatusKind, string] | undefined>): Array<() => string> {
	return chips
		.filter((entry): entry is readonly [StatusKind, string] => entry !== undefined)
		.sort((a, b) => statusSeverity(a[0]) - statusSeverity(b[0]))
		.map(
			([kind, text]) =>
				() =>
					statusChip(clioTheme(), kind, text),
		);
}

function metaOf(parts: ReadonlyArray<string | (() => string) | undefined>): string {
	return parts
		.map((part) => (typeof part === "function" ? part() : part === undefined ? "" : safe(part)))
		.filter(Boolean)
		.join(dotSep(clioTheme()));
}

/** One fact per partner of a plugin or extension, or none when the package has no pair. */
function pairFacts(
	subject: { kind: LibraryEntryKind; name: string; ref: string },
	pairs: LibraryPairs | undefined,
): Fact[] {
	return (pairs?.get(subject.ref as `${LibraryEntryKind}:${string}`) ?? []).map((pair) => ({
		label: pair.role === "extension" ? "Extension" : "Plugin",
		value: safe(describeLibraryPair(subject, pair)),
	}));
}

function lastReceiptFact(id: string, scope: string, kind: string): Fact[] {
	const receipt = readLifecycleReceipts(id, scope, kind).at(-1);
	return receipt
		? [
				{
					label: "Last lifecycle",
					value: safe(
						`${receipt.operation} ${receipt.at} by ${receipt.actor}; ${receipt.id}@${receipt.version ?? "unversioned"}; digest ${receipt.contentDigest ?? "unavailable"}; operation ${receipt.operationId}`,
					),
					tone: "muted",
				},
			]
		: [];
}

/**
 * The keys this row answers to, as key caps with the verb each one really
 * performs: a management key opens a review, never a write. The same words the
 * footer uses, so the pane and the rail never disagree.
 */
function actionKeyChips(theme: ClioTheme, actions: LibraryRowActions): string[] {
	const entry = (key: string, verb: string): string => `${keyCap(theme, key)} ${theme.fg("menuDescription", verb)}`;
	// Enter opens a package's members and does nothing else, so it is named
	// only where it opens something; Tab is the detail key.
	const reviews: Array<[string, string]> = [
		...(actions.install ? [["i", "install"] as [string, string]] : []),
		...(actions.enable ? [["e", "enable/disable"] as [string, string]] : []),
		...(actions.update ? [["u", "update"] as [string, string]] : []),
		...(actions.remove ? [["r", "remove"] as [string, string]] : []),
	];
	// "review" is said once ahead of the keys it covers, so three reviews fit on one row.
	const reviewChips =
		reviews.length === 1
			? reviews.map(([key, verb]) => entry(key, `review ${verb}`))
			: reviews.map(([key, verb], index) =>
					index === 0 ? `${theme.fg("annotation", "review:")} ${entry(key, verb)}` : entry(key, verb),
				);
	return [
		...(actions.use ? [entry("v", "use")] : []),
		...(actions.open ? [entry("Enter", "members")] : []),
		...reviewChips,
	];
}

/** Each reason an action is absent, right under the keys it explains, as an info chip on its own row. */
function noteRows(theme: ClioTheme, reasons: ReadonlyArray<string>, width: number): string[] {
	// Plain dim prose: an info glyph here read as one more key beside the key caps above it.
	return reasons.flatMap((reason) => wrapTextWithAnsi(theme.fg("annotation", safe(reason)), Math.max(1, width)));
}

/** The description last, rendered as Markdown at the pane's width so its code spans and emphasis keep their styling. */
function proseRows(text: string | undefined, width: number): string[] {
	if (!text) return [];
	return ["", ...markdownRows(sanitizeMultilineDisplayText(text).text, width)];
}

function packageDetail(
	record: LibraryPackageRecord,
	view: LibraryView,
	actions: LibraryRowActions,
	pairs: LibraryPairs | undefined,
	width: number,
): DetailRows {
	const theme = clioTheme();
	const provider = record.kind !== view.category;
	const hints = (record.provides ?? []).filter((hint) => view.category === "plugin" || hint.kind === view.category);
	const here = record.copies.find((copy) => copy.scope === view.scope);
	const kindText = `${record.kind}${provider ? ` provider package for ${view.category} components` : " package"}`;
	const status = [
		here
			? statusChip(theme, copyStateStatus(here.state), `installed in ${here.scope} scope, ${copyStateWords(here.state)}`)
			: chip(theme, `not installed in ${view.scope} scope`, "muted", GLYPH.phaseWaiting),
		here?.update ? statusChip(theme, "warning", libraryUpdateLabel(here.update)) : null,
		record.refusal ? statusChip(theme, "error", "cannot be installed") : null,
		record.copies.length > 0 && !here
			? chip(theme, `${record.copies.map((copy) => copyPhrase(copy.scope, copy.state)).join(", ")}`, "muted")
			: null,
	];
	const facts: Fact[] = [
		{ label: "Ref", value: safe(record.ref) },
		{ label: "Kind", value: kindText },
		...(hints.length
			? [
					{
						label: `Catalog hints (${view.category === "plugin" ? "all kinds" : view.category})`,
						value: hints.map((hint) => safe(`${hint.kind}:${hint.name}`)).join(", "),
					},
				]
			: []),
		{ label: "Origin", value: libraryOriginLabel(record.origin) },
	];
	const detail = libraryOriginDetail(record.origin);
	if (detail) facts.push({ label: "Source", value: safe(detail) });
	facts.push({ label: "Format", value: libraryFormatLabel(record.format) });
	if (record.version) facts.push({ label: "Version", value: safe(record.version) });
	if (record.sha256) facts.push({ label: "Recorded digest", value: record.sha256.slice(0, 12), tone: "muted" });
	facts.push({
		label: "Installed copies",
		value:
			record.copies.length === 0
				? "none"
				: record.copies
						.map(
							(copy) =>
								`${copy.scope} (${copyStateWords(copy.state)}${copy.update ? `, ${libraryUpdateLabel(copy.update)}` : ""})`,
						)
						.join(", "),
	});
	facts.push({ label: "Selected scope", value: view.scope });
	if (record.requires?.length) facts.push({ label: "Requires", value: record.requires.join(", ") });
	facts.push(...pairFacts(record, pairs));
	facts.push(...lastReceiptFact(record.name, view.scope, record.kind));
	const notes = [
		...(provider
			? [
					"Catalog hints describe potential components, not loaded components; b switches to Installed, which lists what loaded.",
				]
			: []),
		...(view.category !== "plugin" && (record.provides?.length ?? 0) > hints.length
			? ["Other component kinds are listed in the Plugins category."]
			: []),
		...(record.provides === undefined && record.copies.length === 0
			? ["Contents: unknown until this package is inspected or installed."]
			: []),
	];
	return {
		head: [
			titleRow(theme, safe(record.name), width, { meta: record.version ? `v${safe(record.version)}` : kindText }),
			...chipRows(theme, status, width),
			...chipRows(theme, actionKeyChips(theme, actions), width),
			...noteRows(theme, actions.reasons, width),
		],
		// What the package is comes before how it is filed: the description is the
		// first thing a reader looking at an unfamiliar name needs.
		rest: [
			...proseRows(record.description, width),
			"",
			...factRows(theme, facts, width, FACT_OPTIONS),
			...notes.map((note) => theme.fg("annotation", note)),
		],
	};
}

function copyDetail(
	copy: LibraryCopy,
	view: LibraryView,
	actions: LibraryRowActions,
	pairs: LibraryPairs | undefined,
	width: number,
): DetailRows {
	const theme = clioTheme();
	const flag = (name: string, on: boolean): string => statusChip(theme, on ? "ok" : "error", name);
	const facts: Fact[] = [
		{ label: "Ref", value: safe(copy.ref) },
		{ label: "Kind", value: `${copy.kind} copy` },
		{ label: "Trust", value: safe(copy.trust), ...(copy.trust === "foreign" ? { tone: "warning" as const } : {}) },
		{ label: "Origin", value: libraryOriginLabel(copy.origin) },
	];
	const detail = libraryOriginDetail(copy.origin);
	if (detail) facts.push({ label: "Source", value: safe(detail) });
	facts.push({ label: "Format", value: libraryFormatLabel(copy.format) });
	facts.push({ label: "Root", value: safe(copy.root) });
	if (copy.overriddenBy) facts.push({ label: "Overridden by", value: `the ${copy.overriddenBy} copy`, tone: "warning" });
	if (copy.recordedDigest)
		facts.push({
			label: "Integrity",
			value: `recorded ${copy.recordedDigest.slice(0, 12)}${
				copy.observedDigest
					? copy.observedDigest === copy.recordedDigest
						? ", observed identical"
						: `, observed ${copy.observedDigest.slice(0, 12)} (content changed)`
					: ""
			}`,
			...(copy.observedDigest && copy.observedDigest !== copy.recordedDigest ? { tone: "warning" as const } : {}),
		});
	if (copy.installedAt) facts.push({ label: "Installed", value: safe(copy.installedAt) });
	facts.push({ label: "Selected scope", value: view.scope });
	facts.push(...pairFacts(copy, pairs));
	facts.push(...lastReceiptFact(copy.name, copy.scope, copy.kind));
	for (const diagnostic of copy.diagnostics)
		facts.push({ label: "Diagnostic", value: statusChip(theme, "warning", safe(diagnostic)) });
	return {
		head: [
			titleRow(theme, safe(copy.name), width, {
				meta: `${copy.scope} copy${copy.version ? ` · v${safe(copy.version)}` : ""}`,
			}),
			...chipRows(
				theme,
				[
					statusChip(theme, copyStateStatus(copy.state), copyPhrase(copy.scope, copy.state)),
					copy.update ? statusChip(theme, "warning", libraryUpdateLabel(copy.update)) : null,
					copy.trust === "foreign" ? statusChip(theme, "warning", "foreign") : null,
				],
				width,
			),
			...chipRows(
				theme,
				[
					flag("enabled", copy.enabled),
					flag("valid", copy.valid),
					flag("compatible", copy.compatible),
					flag("effective", copy.effective),
				],
				width,
			),
			...chipRows(theme, actionKeyChips(theme, actions), width),
			...noteRows(theme, actions.reasons, width),
		],
		rest: ["", ...factRows(theme, facts, width, FACT_OPTIONS)],
	};
}

function resourceDetail(resource: LibraryComponent, actions: LibraryRowActions, width: number): DetailRows {
	const theme = clioTheme();
	const facts: Fact[] = [
		{ label: "Key", value: safe(resource.key) },
		{ label: "Kind", value: resource.kind },
		{
			label: "Use",
			value: resource.invocation ? theme.fg("inlineCode", safe(resource.invocation)) : "not invocable in this state",
		},
		{ label: "Source", value: `${resource.source.class} (${safe(resource.source.id)}), ${resource.source.scope} scope` },
		{ label: "Origin", value: libraryOriginLabel(resource.origin) },
	];
	const detail = libraryOriginDetail(resource.origin);
	if (detail) facts.push({ label: "Location", value: safe(detail) });
	if (resource.format) facts.push({ label: "Format", value: libraryFormatLabel(resource.format) });
	if (resource.owner)
		facts.push({
			label: "Owner",
			value: `${safe(resource.owner.ref)} (${resource.owner.scope} scope)${
				resource.owner.componentId ? `, declared component ${safe(resource.owner.componentId)}` : ""
			}`,
		});
	facts.push({ label: "Path", value: safe(resource.path) });
	if (resource.audience) facts.push({ label: "Audience", value: safe(resource.audience) });
	if (resource.reason) facts.push({ label: "Reason", value: safe(resource.reason), tone: "warning" });
	for (const diagnostic of resource.diagnostics)
		facts.push({ label: "Diagnostic", value: statusChip(theme, "warning", safe(diagnostic)) });
	return {
		head: [
			titleRow(theme, safe(resource.name), width, { meta: resource.kind }),
			...chipRows(
				theme,
				[
					statusChip(theme, availabilityStatus(resource.availability), safe(resource.availability)),
					statusChip(theme, resource.trusted ? "ok" : "warning", resource.trusted ? "trusted" : "not trusted"),
					chip(
						theme,
						resource.owner ? `owned by ${safe(resource.owner.ref)}` : `${resource.source.class} component`,
						"muted",
					),
				],
				width,
			),
			...chipRows(theme, actionKeyChips(theme, actions), width),
			...noteRows(theme, actions.reasons, width),
		],
		rest: ["", ...factRows(theme, facts, width, FACT_OPTIONS), ...proseRows(resource.description, width)],
	};
}

function memberDetail(
	subject: Extract<LibraryRowSubject, { kind: "member" }>,
	actions: LibraryRowActions,
	width: number,
): DetailRows {
	const theme = clioTheme();
	const facts: Fact[] = [
		{ label: "Kind", value: subject.member.kind },
		{
			label: "Owner",
			value: `${safe(subject.owner.ref)} (${subject.owner.scope} scope, ${copyStateWords(subject.owner.state)})`,
		},
	];
	if (subject.member.componentId) facts.push({ label: "Declared component", value: safe(subject.member.componentId) });
	facts.push({ label: "Path", value: safe(subject.member.path) });
	facts.push({ label: "Origin", value: libraryOriginLabel(subject.owner.origin) });
	for (const diagnostic of subject.member.diagnostics)
		facts.push({ label: "Diagnostic", value: statusChip(theme, "warning", safe(diagnostic)) });
	return {
		head: [
			titleRow(theme, safe(subject.member.name), width, { meta: subject.member.kind }),
			...chipRows(
				theme,
				[
					subject.member.valid ? statusChip(theme, "ok", "valid") : statusChip(theme, "error", "invalid"),
					statusChip(
						theme,
						copyStateStatus(subject.owner.state),
						`owner ${copyPhrase(subject.owner.scope, subject.owner.state)}`,
					),
				],
				width,
			),
			...chipRows(theme, actionKeyChips(theme, actions), width),
			...noteRows(theme, actions.reasons, width),
		],
		rest: ["", ...factRows(theme, facts, width, FACT_OPTIONS), ...proseRows(subject.member.description, width)],
	};
}

/**
 * A notice pane: the message, then how to get back to the rows it is about.
 * Only a library-wide discovery notice says it covers every category; a
 * package's companion file or an inspection diagnostic belongs to its package.
 */
function noticeDetail(title: string, facts: Fact[], message: string, libraryWide: boolean, width: number): DetailRows {
	const theme = clioTheme();
	return {
		head: [titleRow(theme, title, width)],
		rest: [
			...factRows(theme, facts, width, FACT_OPTIONS),
			...(facts.length > 0 ? [""] : []),
			theme.fg("body", safe(message)),
			"",
			...(libraryWide ? [theme.fg("annotation", "Discovery notices cover all categories.")] : []),
			theme.fg(
				"annotation",
				"From browse focus, n returns to resources. Esc clears a filter or leaves search focus before returning to the parent browser.",
			),
		],
	};
}

/** The rows one view draws, with the subject behind each id. */
export interface LibraryRowSet {
	items: ListOverlayItem[];
	subjects: Map<string, LibraryRowSubject>;
	notices: number;
	truncated: boolean;
}

type RowSpec = Pick<ListOverlayItem, "label" | "meta" | "group" | "searchGroup"> & {
	detail: (width: number) => DetailRows;
};

/**
 * One row and its pane. The pane is built once per width and served to both
 * the rows and the pinned-head count, so a receipt read from disk happens
 * once per frame width rather than twice. The meta is read through to the
 * spec's getter rather than copied: spreading the spec evaluated every row's
 * chips while the rows were built, for the six tabs a switch rebuilds and the
 * thousands of rows no frame draws.
 */
function push(set: LibraryRowSet, id: string, subject: LibraryRowSubject, item: RowSpec): void {
	set.subjects.set(id, subject);
	let memo: { width: number; epoch: number; rows: DetailRows } | null = null;
	const rows = (width: number): DetailRows => {
		if (memo && memo.width === width && memo.epoch === skinEpoch()) return memo.rows;
		memo = { width, epoch: skinEpoch(), rows: item.detail(width) };
		return memo.rows;
	};
	set.items.push({
		id,
		label: subject.kind === "notice" ? clioTheme().fg("warning", safe(item.label)) : safe(item.label),
		...(item.group !== undefined ? { group: item.group } : {}),
		...(item.searchGroup !== undefined ? { searchGroup: item.searchGroup } : {}),
		get meta() {
			return item.meta ?? "";
		},
		detailFormat: "rows",
		detail: (width) => {
			const built = rows(width);
			return [...built.head, ...built.rest];
		},
		detailHead: (width) => rows(width).head.length,
	});
}

/**
 * Display-safe copies by record identity.
 *
 * A tab switch rebuilds every tab's rows from the one cached read, so the deep
 * copy that neutralizes a record's text ran once per record per tab per
 * keystroke: two thirds of a 200 ms switch at 3,000 packages. A refresh reads
 * fresh records, so a copy keyed on the record it was made from is never stale.
 */
const safeRecords = new WeakMap<object, object>();

function safeRecord<T extends object>(record: T): T {
	const known = safeRecords.get(record);
	if (known !== undefined) return known as T;
	const made = displaySafe(record);
	safeRecords.set(record, made);
	return made;
}

function safeInventory(inventory: LibraryInventory): LibraryInventory {
	return {
		...displaySafe({ ...inventory, packages: [], copies: [], resources: [] }),
		packages: inventory.packages.map(safeRecord),
		copies: inventory.copies.map(safeRecord),
		resources: inventory.resources.map(safeRecord),
	};
}

/**
 * Incomplete evidence, said out loud.
 *
 * A capped copy list cannot prove a package is absent, so the browser says the
 * results are incomplete and names the narrower reads that can answer, rather
 * than drawing an "available" row that means "we stopped looking".
 */
export function libraryTruncationNotice(inventory: LibraryInventory): string | undefined {
	const capped = [
		inventory.truncated.packages ? "catalog packages" : undefined,
		inventory.truncated.copies ? "installed copies" : undefined,
		inventory.truncated.resources ? "components" : undefined,
	].filter((part): part is string => part !== undefined);
	if (capped.length === 0) return undefined;
	return `Incomplete results: ${capped.join(", ")} were capped, so an absent row does not prove a package is not installed. Narrow with / search, switch category, or run clio-coder library inspect <ref>.`;
}

/**
 * Narrow one inventory read to the active category.
 *
 * The whole inventory is read once per rebuild rather than once per tab,
 * because the loaders enumerate their roots for precedence either way and five
 * filtered passes would repeat that work five times. Selection is therefore a
 * projection here rather than a `kinds` argument there.
 *
 * Browse keeps a package whose own kind matches or whose catalog hints mention
 * the category, so a bundle that contains the skill someone is looking for is
 * findable before it is installed. Installed keeps the category's components, plus
 * the copies of that package kind that produced no loadable resource, so a
 * damaged package stays reachable for repair instead of vanishing with the
 * components it failed to provide.
 */
export function selectForCategory(inventory: LibraryInventory, view: LibraryView): LibraryInventory {
	if (view.mode === "browse")
		return {
			...inventory,
			packages: inventory.packages.filter(
				(record) => record.kind === view.category || (record.provides ?? []).some((hint) => hint.kind === view.category),
			),
			copies: [],
			resources: [],
		};
	if (view.category === "plugin")
		return {
			...inventory,
			packages: [],
			copies: inventory.copies.filter((copy) => copy.kind === "plugin"),
			resources: [],
		};
	const resources = inventory.resources.filter((resource) => resource.kind === view.category);
	const provided = new Set(resources.map((resource) => resource.owner?.ref).filter(Boolean));
	return {
		...inventory,
		packages: [],
		copies: inventory.copies.filter((copy) => copy.kind === view.category && !provided.has(copy.ref)),
		resources,
	};
}

export interface LibraryRowOptions {
	inventory: LibraryInventory;
	view: LibraryView;
	/** Members of the drilled-into copy, read explicitly rather than during listing. */
	inspection?: LibraryCopyInspection | undefined;
	/** A one-line problem the last read hit, drawn as a notice row rather than swallowed. */
	failure?: string | undefined;
	/** Plugin and extension partners by ref; absent means no pairing is shown. */
	pairs?: LibraryPairs | undefined;
}

/**
 * Build one view's rows.
 *
 * The two modes answer different questions and so they list different records.
 * Browse lists install targets, which is what an operator wanting something new
 * is looking at. Installed lists what this machine actually has, which is what
 * an operator repairing something is looking at. Neither hides the other's
 * evidence: a browse row states its installed copies and an installed row
 * states its origin. A row's metadata leads with the fact that answers the
 * mode's question, as a status chip, and the origin comes last.
 */
export function buildLibraryRows(options: LibraryRowOptions): LibraryRowSet {
	// Every record is neutralized for display once, here, so a field a row or a
	// pane picks up later cannot carry a terminal control past this seam.
	const inventory = safeInventory(options.inventory);
	const inspection = options.inspection === undefined ? undefined : safeRecord(options.inspection);
	const pairs = options.pairs === undefined ? undefined : safeRecord(options.pairs);
	const failure = options.failure === undefined ? undefined : safe(options.failure);
	const { view } = options;
	const theme = clioTheme();
	const set: LibraryRowSet = { items: [], subjects: new Map(), notices: 0, truncated: false };

	if (view.member && inspection) {
		const owner = inspection.copy;
		// The header names the copy, because two copies of one package list
		// the same members and the status row drops the owner below 72 columns.
		// The scope leads because a narrow row cuts the tail, and the ref is long.
		const group = `${LIBRARY_GROUP_MEMBERS} (${owner.scope}) of ${safe(owner.ref)}`;
		for (const member of inspection.resources) {
			const subject: LibraryRowSubject = { kind: "member", owner, member };
			const actions = libraryRowActions(subject, view);
			push(set, `mem:${owner.ref}@${owner.scope}#${member.kind}:${member.name}`, subject, {
				label: member.name,
				get meta() {
					return metaOf([
						() => (member.valid ? statusChip(theme, "ok", "valid") : statusChip(theme, "error", "invalid")),
						member.kind,
						member.componentId ? `component ${member.componentId}` : undefined,
					]);
				},
				group,
				searchGroup: false,
				detail: (width) => memberDetail(subject, actions, width),
			});
		}
		for (const item of inspection.ancillary) {
			const subject: LibraryRowSubject = {
				kind: "notice",
				message: `${item.kind} ${item.id} is declared package metadata, not a component. It runs only on an explicit request.`,
			};
			push(set, `note:ancillary:${item.kind}:${item.id}`, subject, {
				label: `${item.kind}: ${item.id}`,
				get meta() {
					return theme.fg("annotation", "companion file");
				},
				group: LIBRARY_GROUP_NOTICES,
				detail: (width) =>
					noticeDetail(
						safe(item.id),
						[
							{ label: "Declared as", value: safe(item.kind) },
							{ label: "Path", value: safe(item.path) },
						],
						subject.message,
						false,
						width,
					),
			});
			set.notices += 1;
		}
		for (const diagnostic of inspection.diagnostics) {
			const subject: LibraryRowSubject = { kind: "notice", message: diagnostic };
			push(set, `note:member-diag:${set.notices}`, subject, {
				label: `${GLYPH.warnInline} ${diagnostic}`,
				get meta() {
					return theme.fg("annotation", "inspection");
				},
				group: LIBRARY_GROUP_NOTICES,
				detail: (width) => noticeDetail("Inspection diagnostic", [], diagnostic, false, width),
			});
			set.notices += 1;
		}
	} else if (view.mode === "browse") {
		for (const record of inventory.packages) {
			const subject: LibraryRowSubject = { kind: "package", record };
			const actions = libraryRowActions(subject, view);
			const here = record.copies.find((copy) => copy.scope === view.scope);
			const hints = (record.provides ?? []).filter((hint) => view.category === "plugin" || hint.kind === view.category);
			push(set, `pkg:${record.ref}`, subject, {
				label: record.kind !== view.category ? `${record.name} [${record.kind}]` : record.name,
				get meta() {
					// The selected scope is its own chip, so a narrow row drops it whole
					// instead of cutting "project" in half; the status row names it too.
					return metaOf([
						...worstFirst([
							here ? [copyStateStatus(here.state), copyPhrase(here.scope, here.state)] : undefined,
							here?.update ? ["warning", libraryUpdateLabel(here.update as LibraryCopyUpdate)] : undefined,
							record.refusal ? ["error", "refused"] : undefined,
						]),
						here ? undefined : () => chip(theme, "not installed", "muted"),
						here ? undefined : () => chip(theme, `${view.scope} scope`, "muted"),
						record.version ? `v${record.version}` : undefined,
						libraryOriginShort(record.origin),
						hints.length > 0
							? `${hints.length} ${view.category === "plugin" ? "component" : view.category} hints`
							: undefined,
					]);
				},
				group:
					record.kind !== view.category
						? "Provider packages"
						: record.copies.length > 0
							? LIBRARY_GROUP_INSTALLED
							: LIBRARY_GROUP_AVAILABLE,
				detail: (width) => packageDetail(record, view, actions, pairs, width),
			});
		}
	} else {
		for (const copy of inventory.copies) {
			const subject: LibraryRowSubject = { kind: "copy", copy };
			const actions = libraryRowActions(subject, view);
			push(set, `copy:${copy.ref}@${copy.scope}`, subject, {
				label: copy.name,
				get meta() {
					return metaOf([
						...worstFirst([
							[copyStateStatus(copy.state), copyPhrase(copy.scope, copy.state)],
							copy.update ? ["warning", libraryUpdateLabel(copy.update as LibraryCopyUpdate)] : undefined,
							copy.trust === "foreign" ? ["warning", "foreign"] : undefined,
						]),
						libraryOriginShort(copy.origin),
					]);
				},
				group: LIBRARY_GROUP_INSTALLED,
				detail: (width) => copyDetail(copy, view, actions, pairs, width),
			});
		}
		for (const resource of inventory.resources) {
			const subject: LibraryRowSubject = { kind: "component", resource };
			const actions = libraryRowActions(subject, view);
			push(set, `res:${resource.key}`, subject, {
				label: resource.name,
				get meta() {
					return metaOf([
						() => statusChip(theme, availabilityStatus(resource.availability), safe(resource.availability)),
						resource.owner ? resource.owner.ref : resource.source.class,
						libraryOriginShort(resource.origin),
					]);
				},
				group: resource.owner ? LIBRARY_GROUP_INSTALLED : LIBRARY_GROUP_UNMANAGED,
				detail: (width) => resourceDetail(resource, actions, width),
			});
		}
	}

	const truncation = libraryTruncationNotice(inventory);
	set.truncated = truncation !== undefined;
	for (const message of [failure, truncation, ...inventory.diagnostics].filter(
		(entry): entry is string => entry !== undefined,
	)) {
		const subject: LibraryRowSubject = { kind: "notice", message };
		push(set, `note:${set.notices}`, subject, {
			label: `${GLYPH.warnInline} ${message}`,
			get meta() {
				return theme.fg("annotation", "library");
			},
			group: LIBRARY_GROUP_NOTICES,
			detail: (width) => noticeDetail("Library notice", [], message, true, width),
		});
		set.notices += 1;
	}
	return set;
}
