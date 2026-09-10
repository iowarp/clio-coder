/**
 * The Library browser's projection: one inventory read becomes the rows, the
 * status line and the detail panes the operator actually sees.
 *
 * Everything here is pure. The overlay owns the keyboard, the lifecycle port
 * owns the writes, and this module owns what is true on screen, so the wording
 * of an origin label or a disabled reason is testable without a terminal.
 */

import type { PluginScope } from "../../domains/plugins/types.js";
import type {
	LibraryCopy,
	LibraryCopyInspection,
	LibraryEntryKind,
	LibraryInventory,
	LibraryOrigin,
	LibraryPackageRecord,
	LibraryProvidedResource,
	LibraryResource,
	LibraryResourceKind,
} from "../../domains/resources/index.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import type { ListOverlayItem } from "./list-overlay.js";

/** Browse lists install targets; Installed lists the copies and recipes that exist here. */
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
	| { kind: "recipe"; resource: LibraryResource }
	| { kind: "member"; owner: LibraryCopy; member: LibraryCopyInspection["resources"][number] }
	| { kind: "hint"; record: LibraryPackageRecord; hint: LibraryProvidedResource }
	| { kind: "notice"; message: string };

export const LIBRARY_GROUP_INSTALLED = "Installed";
export const LIBRARY_GROUP_AVAILABLE = "Available";
export const LIBRARY_GROUP_MEMBERS = "Members";
export const LIBRARY_GROUP_UNMANAGED = "Not a package";
export const LIBRARY_GROUP_NOTICES = "Notices";

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
			return "Bundled with Clio-Coder";
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
	return "Format unknown";
}

/**
 * The persistent mode/scope row, at the width it is drawn.
 *
 * Mode and scope survive every width, because they say what the action keys
 * will do. The counts are what gets dropped first: they are useful, and they
 * are not the thing an operator would be wrong about.
 */
export function libraryStatusLine(
	view: LibraryView,
	counts: { rows: number; notices: number; truncated: boolean },
	width: number,
): string {
	const theme = clioTheme();
	const mode = view.mode === "browse" ? "Browse" : "Installed";
	const scope = view.scope === "user" ? "User" : "Project";
	const core = `${mode} · ${scope}`;
	if (width < 34) return theme.fg("accent", `${mode}·${scope}`);
	const parts = [theme.fg("accent", core)];
	if (view.member) parts.push(theme.fg("dim", `members of ${view.member.ref}`));
	if (width >= 56) parts.push(theme.fg("dim", `${counts.rows} row${counts.rows === 1 ? "" : "s"}`));
	if (counts.notices > 0) parts.push(theme.fg("warning", `${counts.notices} notice${counts.notices === 1 ? "" : "s"}`));
	if (counts.truncated) parts.push(theme.fg("warning", "incomplete results"));
	return parts.join(theme.fg("frame", " │ "));
}

/** The composer text a `use` on this recipe writes, or null when its use is another surface. */
export function libraryUseInvocation(kind: LibraryResourceKind, name: string): string | null {
	if (kind === "skill") return `/skill ${name} `;
	if (kind === "agent") return `/run ${name} `;
	if (kind === "prompt") return `/${name} `;
	// A fleet's use is its `/fleet run` approval preview, not composer text.
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
 * Nothing here guesses. A core or loose recipe is not a package, so it offers
 * no package lifecycle at all and says so; an unavailable recipe offers no
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
		if (!here) reasons.push(`No ${view.scope} copy; install writes one. Press s to select the other scope.`);
		return {
			install: !here && !subject.record.refusal,
			remove: !!here,
			enable: !!here,
			update: !!here,
			use: false,
			open: true,
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
				? "Core recipes ship with Clio-Coder and have no package to install, update or remove."
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
		open: !!owner,
		reasons,
	};
}

function copyStateWord(copy: LibraryCopy): string {
	const theme = clioTheme();
	if (copy.state === "loadable") return theme.fg("success", "loadable");
	if (copy.state === "disabled") return theme.fg("warning", "disabled");
	if (copy.state === "shadowed") return theme.fg("dim", "shadowed");
	return theme.fg("error", copy.state);
}

function availabilityWord(resource: LibraryResource): string {
	const theme = clioTheme();
	if (resource.availability === "available") return theme.fg("success", "available");
	if (resource.availability === "untrusted") return theme.fg("warning", "untrusted");
	if (resource.availability === "shadowed") return theme.fg("dim", "shadowed");
	return theme.fg("error", resource.availability);
}

function metaOf(parts: ReadonlyArray<string | undefined>): string {
	return parts.filter((part): part is string => !!part && part.length > 0).join(" · ");
}

function packageDetail(record: LibraryPackageRecord, view: LibraryView, actions: LibraryRowActions): string[] {
	const lines = [`# ${record.name}`, `**Kind:** ${record.kind}`, `**Origin:** ${libraryOriginLabel(record.origin)}`];
	const detail = libraryOriginDetail(record.origin);
	if (detail) lines.push(`**Source:** \`${detail}\``);
	lines.push(`**Format:** ${libraryFormatLabel(record.format)}`);
	if (record.version) lines.push(`**Version:** ${record.version}`);
	if (record.sha256) lines.push(`**Recorded digest:** \`${record.sha256.slice(0, 12)}\``);
	lines.push(
		`**Installed copies:** ${
			record.copies.length === 0 ? "none" : record.copies.map((copy) => `${copy.scope} (${copy.state})`).join(", ")
		}`,
	);
	lines.push(`**Selected scope:** ${view.scope}`);
	if (record.requires?.length) lines.push(`**Requires:** ${record.requires.join(", ")}`);
	if (record.provides?.length)
		lines.push(`**Catalog hints:** ${record.provides.map((hint) => `${hint.kind}:${hint.name}`).join(", ")}`);
	if (record.provides === undefined && record.copies.length === 0)
		lines.push("**Contents:** unknown until this package is inspected or installed.");
	for (const reason of actions.reasons) lines.push(`**Note:** ${reason}`);
	lines.push("", "---", "", record.description);
	return lines;
}

function copyDetail(copy: LibraryCopy, view: LibraryView, actions: LibraryRowActions): string[] {
	const lines = [
		`# ${copy.name}`,
		`**Kind:** ${copy.kind}`,
		`**Scope:** ${copy.scope}`,
		`**State:** ${copy.state}`,
		`**Enabled:** ${copy.enabled ? "yes" : "no"} · **Valid:** ${copy.valid ? "yes" : "no"} · **Compatible:** ${copy.compatible ? "yes" : "no"} · **Effective:** ${copy.effective ? "yes" : "no"}`,
		`**Trust:** ${copy.trust}`,
		`**Origin:** ${libraryOriginLabel(copy.origin)}`,
	];
	const detail = libraryOriginDetail(copy.origin);
	if (detail) lines.push(`**Source:** \`${detail}\``);
	lines.push(`**Format:** ${libraryFormatLabel(copy.format)}`);
	lines.push(`**Root:** \`${copy.root}\``);
	if (copy.overriddenBy) lines.push(`**Overridden by:** the ${copy.overriddenBy} copy`);
	if (copy.recordedDigest)
		lines.push(
			`**Integrity:** recorded \`${copy.recordedDigest.slice(0, 12)}\`${
				copy.observedDigest
					? copy.observedDigest === copy.recordedDigest
						? ", observed identical"
						: `, observed \`${copy.observedDigest.slice(0, 12)}\` (content changed)`
					: ""
			}`,
		);
	if (copy.installedAt) lines.push(`**Installed:** ${copy.installedAt}`);
	lines.push(`**Selected scope:** ${view.scope}`);
	for (const diagnostic of copy.diagnostics) lines.push(`**Diagnostic:** ${diagnostic}`);
	for (const reason of actions.reasons) lines.push(`**Note:** ${reason}`);
	lines.push("", "Press Enter to list this package's members.");
	return lines;
}

function resourceDetail(resource: LibraryResource, actions: LibraryRowActions): string[] {
	const lines = [
		`# ${resource.name}`,
		`**Kind:** ${resource.kind}`,
		`**Use:** ${resource.invocation ? `\`${resource.invocation}\`` : "not invocable in this state"}`,
		`**Availability:** ${resource.availability}`,
		`**Source:** ${resource.source.class} (${resource.source.id}), ${resource.source.scope} scope`,
		`**Origin:** ${libraryOriginLabel(resource.origin)}`,
	];
	const detail = libraryOriginDetail(resource.origin);
	if (detail) lines.push(`**Location:** \`${detail}\``);
	if (resource.format) lines.push(`**Format:** ${libraryFormatLabel(resource.format)}`);
	lines.push(`**Trusted:** ${resource.trusted ? "yes" : "no"}`);
	if (resource.owner)
		lines.push(
			`**Owner:** ${resource.owner.ref} (${resource.owner.scope} scope)${
				resource.owner.componentId ? `, declared component \`${resource.owner.componentId}\`` : ""
			}`,
		);
	lines.push(`**Path:** \`${resource.path}\``);
	if (resource.audience) lines.push(`**Audience:** ${resource.audience}`);
	if (resource.reason) lines.push(`**Reason:** ${resource.reason}`);
	for (const diagnostic of resource.diagnostics) lines.push(`**Diagnostic:** ${diagnostic}`);
	for (const reason of actions.reasons) lines.push(`**Note:** ${reason}`);
	lines.push("", "---", "", resource.description);
	return lines;
}

function memberDetail(subject: Extract<LibraryRowSubject, { kind: "member" }>, actions: LibraryRowActions): string[] {
	const lines = [
		`# ${subject.member.name}`,
		`**Kind:** ${subject.member.kind}`,
		`**Owner:** ${subject.owner.ref} (${subject.owner.scope} scope, ${subject.owner.state})`,
		`**Valid:** ${subject.member.valid ? "yes" : "no"}`,
	];
	if (subject.member.componentId) lines.push(`**Declared component:** \`${subject.member.componentId}\``);
	lines.push(`**Path:** \`${subject.member.path}\``);
	lines.push(`**Origin:** ${libraryOriginLabel(subject.owner.origin)}`);
	for (const diagnostic of subject.member.diagnostics) lines.push(`**Diagnostic:** ${diagnostic}`);
	for (const reason of actions.reasons) lines.push(`**Note:** ${reason}`);
	if (subject.member.description) lines.push("", "---", "", subject.member.description);
	return lines;
}

/** The rows one view draws, with the subject behind each id. */
export interface LibraryRowSet {
	items: ListOverlayItem[];
	subjects: Map<string, LibraryRowSubject>;
	notices: number;
	truncated: boolean;
}

function push(set: LibraryRowSet, id: string, subject: LibraryRowSubject, item: Omit<ListOverlayItem, "id">): void {
	set.subjects.set(id, subject);
	set.items.push({ id, ...item });
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
		inventory.truncated.resources ? "recipes" : undefined,
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
 * findable before it is installed. Installed keeps the category's recipes, plus
 * the copies of that package kind that produced no loadable resource, so a
 * damaged package stays reachable for repair instead of vanishing with the
 * recipes it failed to provide.
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
}

/**
 * Build one view's rows.
 *
 * The two modes answer different questions and so they list different records.
 * Browse lists install targets, which is what an operator wanting something new
 * is looking at. Installed lists what this machine actually has, which is what
 * an operator repairing something is looking at. Neither hides the other's
 * evidence: a browse row states its installed copies and an installed row
 * states its origin.
 */
export function buildLibraryRows(options: LibraryRowOptions): LibraryRowSet {
	const { inventory, view } = options;
	const theme = clioTheme();
	const set: LibraryRowSet = { items: [], subjects: new Map(), notices: 0, truncated: false };

	if (view.member && options.inspection) {
		const owner = options.inspection.copy;
		for (const member of options.inspection.resources) {
			const subject: LibraryRowSubject = { kind: "member", owner, member };
			const actions = libraryRowActions(subject, view);
			push(set, `mem:${owner.ref}@${owner.scope}#${member.kind}:${member.name}`, subject, {
				label: member.name,
				meta: metaOf([
					member.kind,
					member.valid ? theme.fg("success", "valid") : theme.fg("error", "invalid"),
					member.componentId ? `component ${member.componentId}` : undefined,
				]),
				group: LIBRARY_GROUP_MEMBERS,
				detail: () => memberDetail(subject, actions),
			});
		}
		for (const item of options.inspection.ancillary) {
			const subject: LibraryRowSubject = {
				kind: "notice",
				message: `${item.kind} ${item.id} is declared package metadata, not a recipe. It runs only on an explicit request.`,
			};
			push(set, `note:ancillary:${item.kind}:${item.id}`, subject, {
				label: `${item.kind}: ${item.id}`,
				meta: theme.fg("dim", "companion file"),
				group: LIBRARY_GROUP_NOTICES,
				detail: () => [`# ${item.id}`, `**Declared as:** ${item.kind}`, `**Path:** \`${item.path}\``, "", subject.message],
			});
			set.notices += 1;
		}
		for (const diagnostic of options.inspection.diagnostics) {
			const subject: LibraryRowSubject = { kind: "notice", message: diagnostic };
			push(set, `note:member-diag:${set.notices}`, subject, {
				label: `${theme.fg("warning", GLYPH.warnInline)} ${diagnostic}`,
				meta: theme.fg("dim", "inspection"),
				group: LIBRARY_GROUP_NOTICES,
				detail: () => ["# Inspection diagnostic", diagnostic],
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
				label: record.name,
				meta: metaOf([
					libraryOriginLabel(record.origin),
					record.version ? `v${record.version}` : undefined,
					here ? theme.fg("success", `${here.scope} ${here.state}`) : theme.fg("dim", "not in this scope"),
					hints.length > 0 ? `${hints.length} hinted` : undefined,
				]),
				group: record.copies.length > 0 ? LIBRARY_GROUP_INSTALLED : LIBRARY_GROUP_AVAILABLE,
				detail: () => packageDetail(record, view, actions),
			});
		}
	} else {
		for (const copy of inventory.copies) {
			const subject: LibraryRowSubject = { kind: "copy", copy };
			const actions = libraryRowActions(subject, view);
			push(set, `copy:${copy.ref}@${copy.scope}`, subject, {
				label: copy.name,
				meta: metaOf([
					libraryOriginLabel(copy.origin),
					copy.scope,
					copyStateWord(copy),
					copy.trust === "foreign" ? theme.fg("warning", "foreign") : undefined,
				]),
				group: LIBRARY_GROUP_INSTALLED,
				detail: () => copyDetail(copy, view, actions),
			});
		}
		for (const resource of inventory.resources) {
			const subject: LibraryRowSubject = { kind: "recipe", resource };
			const actions = libraryRowActions(subject, view);
			push(set, `res:${resource.key}`, subject, {
				label: resource.name,
				meta: metaOf([
					libraryOriginLabel(resource.origin),
					resource.owner ? resource.owner.ref : resource.source.class,
					availabilityWord(resource),
				]),
				group: resource.owner ? LIBRARY_GROUP_INSTALLED : LIBRARY_GROUP_UNMANAGED,
				detail: () => resourceDetail(resource, actions),
			});
		}
	}

	const truncation = libraryTruncationNotice(inventory);
	set.truncated = truncation !== undefined;
	for (const message of [options.failure, truncation, ...inventory.diagnostics].filter(
		(entry): entry is string => entry !== undefined,
	)) {
		const subject: LibraryRowSubject = { kind: "notice", message };
		push(set, `note:${set.notices}`, subject, {
			label: `${theme.fg("warning", GLYPH.warnInline)} ${message}`,
			meta: theme.fg("dim", "library"),
			group: LIBRARY_GROUP_NOTICES,
			detail: () => ["# Library notice", "", message],
		});
		set.notices += 1;
	}
	return set;
}
