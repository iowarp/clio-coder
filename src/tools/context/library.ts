import { ToolNames } from "../../core/tool-names.js";
import type {
	LibraryInventory,
	LibraryInventoryOptions,
	LibraryOrigin,
	LibraryPackageRecord,
	LibraryResource,
} from "../../domains/resources/library-inventory.js";
import { finalizeObservation, type ObservationReservation } from "../observation.js";
import type { ToolInvokeOptions, ToolResult } from "../registry.js";
import { byteLength } from "../truncate-utf8.js";

/**
 * scope=library: one bounded, body-free READ over the shared recipe inventory.
 *
 * It answers what recipes exist, who owns them, how they are actually invoked,
 * and what an uninstalled package would provide. It activates, registers,
 * installs and pins nothing, and it never returns an instruction body. Skill
 * activation stays entirely under scope=skills.
 *
 * Three row types, never conflated. A `resource` is a recipe that loaded and is
 * usable now. A `hint` is a catalog claim about a member of a package: it names
 * its installable owner and that member's honest status, and it never carries
 * an invocation, because nothing has loaded it. A `package` is the install
 * target itself.
 *
 * The inventory module is reached by dynamic import so scope=workspace,
 * scope=docs and scope=skills never pay for agent, prompt and fleet discovery.
 * Only the types cross statically, and those are erased.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Hint names listed on one package row before it reports a remainder instead. */
const MAX_PROVIDES = 12;
const MAX_DESCRIPTION = 160;
const MAX_REASON = 200;
const MAX_DIAGNOSTICS = 3;
const MAX_DIAGNOSTIC = 160;
const MAX_ORIGIN_VALUE = 240;
const MAX_REQUIRES = 8;
const MAX_INVOCATION = 200;
/** How much of an echoed argument comes back in the payload header. */
const MAX_ECHO = 120;

export type LibraryRowKind = "skill" | "agent" | "prompt" | "fleet" | "plugin";

export interface LibraryScopeDeps {
	getCwd(): string;
	/**
	 * False on every native worker registry. A worker has skill discovery
	 * disabled and no admitted library projection of its own, so this read
	 * refuses there rather than handing it the global library through a new
	 * endpoint. Read-only is not an argument for exposure.
	 */
	skillMarketplace?: boolean;
	/** The run's skill-loader posture; `--no-skills` and compat-root trust both apply here. */
	skillLoaderOptions?: { trustProjectCompatRoots?: boolean; disableDiscovery?: boolean };
}

const WORKER_UNAVAILABLE =
	'context: scope="library" is unavailable in this run; a worker has no library projection of its own and cannot install or activate anything. ' +
	"Work from the resources your assignment already bound, and record the gap with the limitation tool if it blocks the task.";

const OPERATOR_NOTE =
	"Read-only catalog: you cannot install or activate from here. Suggest /library to the operator for packages and /skill <name> for a skill. A hint row is a catalog claim, not a loaded recipe, and cannot be invoked.";
const NOTE_SKILLS_OFF = "Skill discovery is off for this run, so no skill rows are listed.";
const NOTE_INVENTORY_CAPPED =
	"The inventory returned as many records as it carries, so this listing and its install evidence are incomplete; narrow with kind or query.";
const NOTE_AMBIGUOUS_REF = "This ref matched several records; select one by the key on its row.";
const NOTE_NO_MATCH = "Nothing matched; drop ref or query to list the catalog.";
const NOTE_NO_BUDGET = "The remaining observation budget cannot carry a row this turn; continue in a follow-up turn.";
/** Every clause at once, for measuring the envelope a page must fit inside. */
const ALL_NOTE_CLAUSES = [
	OPERATOR_NOTE,
	NOTE_SKILLS_OFF,
	NOTE_INVENTORY_CAPPED,
	NOTE_AMBIGUOUS_REF,
	NOTE_NO_MATCH,
	NOTE_NO_BUDGET,
].join(" ");

function clampLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function clampOffset(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

function bound(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function boundDiagnostics(diagnostics: ReadonlyArray<string>): string[] {
	return diagnostics.slice(0, MAX_DIAGNOSTICS).map((entry) => bound(entry, MAX_DIAGNOSTIC));
}

/**
 * Origin is mandatory evidence, so it is passed through rather than summarized:
 * source class, URL, catalog, original agent, original path and marketplace all
 * stay distinct fields. Only the individual string values are bounded, because
 * a pathological path must not be able to spend the whole page budget.
 */
function boundOrigin(origin: LibraryOrigin): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(origin)) {
		out[key] = typeof value === "string" ? bound(value, MAX_ORIGIN_VALUE) : value;
	}
	return out;
}

/**
 * Resource rows keep the origin evidence and the actual runtime name, and drop
 * the absolute path: the model's move on a recipe is to invoke it or suggest
 * it, never to open its file, and a body-free projection should not hand out
 * the one field that routes around itself.
 *
 * `audience: "model"` already drops untrusted, invalid, shadowed, unavailable
 * and manual-only rows, so availability, reason and diagnostics are emitted
 * only if one ever survives that filter. They cost nothing when it does not,
 * and a silently mislabelled row is worse than a redundant field.
 */
function projectResource(resource: LibraryResource, ambiguous: boolean): Record<string, unknown> {
	return {
		row: "resource",
		kind: resource.kind,
		name: resource.name,
		// The stable inventory key is what disambiguates two same-named
		// resources from different owners; it is spent only when there are two.
		...(ambiguous ? { key: resource.key } : {}),
		description: bound(resource.description, MAX_DESCRIPTION),
		owner: resource.owner ? resource.owner.ref : resource.source.class,
		scope: resource.source.scope,
		origin: boundOrigin(resource.origin),
		...(resource.format !== undefined ? { format: resource.format } : {}),
		...(resource.availability !== "available" ? { availability: resource.availability } : {}),
		...(resource.reason !== undefined ? { reason: bound(resource.reason, MAX_REASON) } : {}),
		...(resource.invocation !== undefined ? { invocation: bound(resource.invocation, MAX_INVOCATION) } : {}),
		...(resource.diagnostics.length > 0 ? { diagnostics: boundDiagnostics(resource.diagnostics) } : {}),
	};
}

/**
 * The identity of a record whose full projection does not fit the remaining
 * budget. A page that could carry nothing would otherwise be replaced whole by
 * the envelope's JSON stub, which tells the caller less than the name of the
 * thing it could not show.
 */
function identityOnly(row: Record<string, unknown>): Record<string, unknown> {
	return {
		row: row.row,
		kind: row.kind,
		name: row.name,
		...(row.key !== undefined ? { key: row.key } : {}),
		...(row.ref !== undefined ? { ref: row.ref } : {}),
		...(row.owner !== undefined ? { owner: row.owner } : {}),
		truncatedRecord: true,
	};
}

/**
 * A hint row is a catalog claim about one member of a package. It never has an
 * invocation: nothing loaded it, and a hint that looked invocable would be an
 * invitation to call something that does not exist.
 *
 * `member` is the honest state of that member here. When the owning package is
 * not installed, the member is not installed either. When the package *is*
 * installed and the member did not turn up as an actual resource, this read
 * cannot tell whether it is absent, untrusted, or filtered from the model's
 * view, so it says `unknown` and reports the owner's real copy states rather
 * than claiming the member is merely uninstalled.
 *
 * `copiesCapped` collapses that first case into the second. When the inventory
 * truncated its copy list, an empty `owner.copies` is no longer evidence that
 * nothing is installed, only that this read did not see it, and calling that
 * `not-installed` would invent a fact.
 */
function projectHint(
	kind: string,
	name: string,
	description: string | undefined,
	owner: LibraryPackageRecord,
	copiesCapped: boolean,
): Record<string, unknown> {
	const installed = owner.copies.map((copy) => ({ scope: copy.scope, state: copy.state }));
	return {
		row: "hint",
		kind,
		name,
		...(description !== undefined ? { description: bound(description, MAX_DESCRIPTION) } : {}),
		owner: owner.ref,
		ownerInstalled: installed,
		member: installed.length === 0 && !copiesCapped ? "not-installed" : "unknown",
		origin: boundOrigin(owner.origin),
		...(owner.format !== undefined ? { format: owner.format } : {}),
	};
}

/**
 * Package rows are install targets. `provides` is a bounded hint list generated
 * from validated payloads: it names what the package would contribute, never
 * proves the package is usable, and never triggers a fetch. A row with no hints
 * says so honestly instead of claiming empty contents.
 */
function projectPackage(record: LibraryPackageRecord, copiesCapped: boolean): Record<string, unknown> {
	const provides = record.provides ?? [];
	const shownProvides = provides.slice(0, MAX_PROVIDES);
	const installed = record.copies.map((copy) => ({ scope: copy.scope, state: copy.state }));
	return {
		row: "package",
		kind: record.kind,
		name: record.name,
		ref: record.ref,
		description: bound(record.description, MAX_DESCRIPTION),
		...(record.version !== undefined ? { version: record.version } : {}),
		origin: boundOrigin(record.origin),
		...(record.format !== undefined ? { format: record.format } : {}),
		installed,
		// An empty list under a capped copy read is silence, not absence.
		...(installed.length === 0 && copiesCapped ? { installedUnknown: true } : {}),
		...(record.provides === undefined
			? { provides: "unknown until inspection" }
			: {
					provides: shownProvides.map((hint) => `${hint.kind}:${hint.name}`),
					...(provides.length > shownProvides.length ? { providesOmitted: provides.length - shownProvides.length } : {}),
				}),
		...(record.requires !== undefined
			? {
					requires: record.requires.slice(0, MAX_REQUIRES),
					...(record.requires.length > MAX_REQUIRES ? { requiresOmitted: record.requires.length - MAX_REQUIRES } : {}),
				}
			: {}),
		...(record.refusal !== undefined ? { refusal: bound(record.refusal, MAX_REASON) } : {}),
	};
}

/**
 * `limit` is an upper bound on rows; the byte cap is the real one. A page that
 * overruns the reservation is replaced wholesale by the envelope's JSON stub,
 * which costs the caller a round trip and returns nothing readable, so the page
 * is cut here instead and the remainder is offered as the next offset. The
 * budget is the reservation's, so a partly spent turn pool narrows the page
 * rather than voiding it.
 *
 * `envelopeBytes` is measured, not assumed: the header echoes, the note and the
 * inventory diagnostics all vary, and a fixed reserve that four diagnostics can
 * exceed is how a bounded page turns back into a stub.
 */
function fitPage(
	candidate: ReadonlyArray<Record<string, unknown>>,
	capBytes: number,
	envelopeBytes: number,
): Record<string, unknown>[] {
	const budget = capBytes - envelopeBytes;
	let used = 0;
	const page: Record<string, unknown>[] = [];
	for (const row of candidate) {
		const cost = byteLength(JSON.stringify(row)) + 1;
		if (used + cost <= budget) {
			used += cost;
			page.push(row);
			continue;
		}
		// Nothing has fitted yet and this record is too large on its own: return
		// its identity so the caller learns what is there and can ask for it by
		// ref, instead of getting a stub that names nothing.
		if (page.length === 0) {
			const identity = identityOnly(row);
			if (byteLength(JSON.stringify(identity)) + 1 <= budget) page.push(identity);
		}
		break;
	}
	return page;
}

/** Same kind and name from two different sources: the row must carry its key. */
function ambiguousNames(resources: ReadonlyArray<LibraryResource>): Set<string> {
	const seen = new Map<string, number>();
	for (const resource of resources) {
		const id = `${resource.kind}:${resource.name}`;
		seen.set(id, (seen.get(id) ?? 0) + 1);
	}
	return new Set([...seen].filter(([, count]) => count > 1).map(([id]) => id));
}

/**
 * Which hints a `ref` admits.
 *
 * An exact resource key identifies one loaded resource, so it admits no hints
 * at all: a package's other members are not what was asked for. A package ref
 * deliberately opens that package, so it admits every member of it. A bare
 * runtime name admits only the hints of that name, wherever they are owned; it
 * must not pull in an owner's unrelated siblings just because the owner matched.
 */
function hintSelection(
	ref: string,
	inventory: LibraryInventory,
): { mode: "all" } | { mode: "none" } | { mode: "owner"; ref: string } | { mode: "name"; name: string } {
	if (ref.length === 0) return { mode: "all" };
	if (ref.includes("@")) return { mode: "none" };
	const owner = inventory.packages.find((record) => record.ref === ref);
	if (owner) return { mode: "owner", ref: owner.ref };
	const colon = ref.indexOf(":");
	return { mode: "name", name: colon >= 0 ? ref.slice(colon + 1) : ref };
}

function hintRows(
	inventory: LibraryInventory,
	resources: ReadonlyArray<LibraryResource>,
	kind: LibraryRowKind | undefined,
	query: string,
	ref: string,
	copiesCapped: boolean,
): Record<string, unknown>[] {
	if (kind === "plugin") return [];
	const selection = hintSelection(ref, inventory);
	if (selection.mode === "none") return [];
	// A hint whose actual resource is already on the page is noise: the loaded
	// row is strictly better evidence about the same member.
	const actual = new Set(
		resources
			.filter((resource) => resource.owner)
			.map((resource) => `${resource.owner?.ref}|${resource.kind}|${resource.name}`),
	);
	const needle = query.toLowerCase();
	const rows: Record<string, unknown>[] = [];
	for (const record of inventory.packages) {
		if (selection.mode === "owner" && record.ref !== selection.ref) continue;
		for (const hint of record.provides ?? []) {
			if (kind !== undefined && hint.kind !== kind) continue;
			if (selection.mode === "name" && hint.name !== selection.name) continue;
			if (actual.has(`${record.ref}|${hint.kind}|${hint.name}`)) continue;
			if (needle.length > 0 && !`${hint.kind}:${hint.name} ${hint.description ?? ""}`.toLowerCase().includes(needle))
				continue;
			rows.push(projectHint(hint.kind, hint.name, hint.description, record, copiesCapped));
		}
	}
	return rows;
}

export async function runLibraryScope(
	deps: LibraryScopeDeps,
	args: Record<string, unknown>,
	reservation: ObservationReservation,
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	if (deps.skillMarketplace === false) {
		return { kind: "error", message: WORKER_UNAVAILABLE };
	}
	const kind = typeof args.kind === "string" ? (args.kind as LibraryRowKind) : undefined;
	const query = typeof args.query === "string" ? args.query.trim() : "";
	const ref = typeof args.ref === "string" ? args.ref.trim() : "";
	const limit = clampLimit(args.limit);
	const offset = clampOffset(args.offset);
	// `--no-skills` is an explicit operator choice for this run. Listing skills
	// as invocable afterwards would be a lie: nothing in this process can load
	// one. Packages that provide skills stay visible; that is catalog metadata,
	// not discovery.
	const skillsDisabled = deps.skillLoaderOptions?.disableDiscovery === true;
	// Packages are read at every kind: `kind=plugin` keeps its documented
	// meaning (packages whose own kind is plugin) and a recipe kind still finds
	// the installable owners that provide it.
	const wantsResources = kind !== "plugin" && !(kind === "skill" && skillsDisabled);

	let inventory: LibraryInventory;
	try {
		inventory = await loadInventory({
			cwd: deps.getCwd(),
			audience: "model",
			include: { packages: true, copies: false, resources: wantsResources },
			...(kind !== undefined ? { kinds: [kind] } : {}),
			...(query.length > 0 ? { query } : {}),
			...(ref.length > 0 ? { ref } : {}),
			...(deps.skillLoaderOptions?.trustProjectCompatRoots !== undefined
				? { trustProjectCompatRoots: deps.skillLoaderOptions.trustProjectCompatRoots }
				: {}),
		});
	} catch (err) {
		return {
			kind: "error",
			message: `context: library inventory unavailable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const resources = wantsResources
		? inventory.resources.filter((resource) => !(skillsDisabled && resource.kind === "skill"))
		: [];
	const ambiguous = ambiguousNames(resources);
	// Usable now, then what a package claims it would add, then the install
	// targets themselves. Each half arrives in the inventory's deterministic
	// order, so the concatenation is a stable total order and paging it cannot
	// repeat or skip a row between calls.
	// Copies are reported as truncated even when this read did not ask for them,
	// because they are the owner and install evidence behind package and hint
	// rows: a capped copy list means those rows are incomplete too.
	const copiesCapped = inventory.truncated.copies;
	const rows: Record<string, unknown>[] = [
		...resources.map((resource) => projectResource(resource, ambiguous.has(`${resource.kind}:${resource.name}`))),
		...hintRows(inventory, resources, kind, query, ref, copiesCapped),
		...inventory.packages.map((record) => projectPackage(record, copiesCapped)),
	];
	const total = rows.length;
	// The inventory caps how many records it returns. When it did, `total` counts
	// what came back rather than what exists, and the payload says so instead of
	// implying the collection ends here.
	const inventoryCapped = inventory.truncated.resources || inventory.truncated.packages || copiesCapped;
	const diagnostics = boundDiagnostics(inventory.diagnostics);

	const header = {
		scope: "library",
		...(kind !== undefined ? { kind } : {}),
		...(query.length > 0 ? { query: bound(query, MAX_ECHO) } : {}),
		...(ref.length > 0 ? { ref: bound(ref, MAX_ECHO) } : {}),
		total,
		...(inventoryCapped ? { totalIsLowerBound: true } : {}),
		offset,
		...(diagnostics.length > 0 ? { diagnostics } : {}),
	};
	// Measure the envelope with every optional clause present, so the page that
	// fits inside it still fits once the real, shorter note is written.
	const envelopeBytes = byteLength(
		JSON.stringify({ ...header, shown: total, nextOffset: total, rows: [], note: ALL_NOTE_CLAUSES }),
	);
	const page = fitPage(rows.slice(offset, offset + limit), reservation.callCapBytes, envelopeBytes);
	// A page that carried nothing must not hand back an offset equal to the one
	// it was given: that is a loop, not a continuation.
	const exhaustedPage = page.length === 0 && total > offset;
	const nextOffset = !exhaustedPage && offset + page.length < total ? offset + page.length : undefined;

	const payload = {
		...header,
		shown: page.length,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		rows: page,
		note: [
			OPERATOR_NOTE,
			...(skillsDisabled ? [NOTE_SKILLS_OFF] : []),
			...(inventoryCapped ? [NOTE_INVENTORY_CAPPED] : []),
			...(ref.length > 0 && total > 1 ? [NOTE_AMBIGUOUS_REF] : []),
			...(total === 0 && (ref.length > 0 || query.length > 0) ? [NOTE_NO_MATCH] : []),
			...(exhaustedPage ? [NOTE_NO_BUDGET] : []),
		].join(" "),
	};

	return finalizeObservation({
		tool: ToolNames.Context,
		unit: "entries",
		format: "json",
		output: JSON.stringify(payload),
		shownCount: page.length,
		totalCount: total,
		truncated: nextOffset !== undefined || inventoryCapped || exhaustedPage,
		...(nextOffset !== undefined ? { next: `offset=${nextOffset}` } : {}),
		reservation,
		...(options ? { options } : {}),
	});
}

async function loadInventory(options: LibraryInventoryOptions): Promise<LibraryInventory> {
	const { readLibraryInventory } = await import("../../domains/resources/library-inventory.js");
	return readLibraryInventory(options);
}
