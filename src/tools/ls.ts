import { lstat, opendir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { Type } from "typebox";
import { packedSourceDirectory, packedSourcePathsUnder } from "../core/source-pack.js";
import { ToolNames } from "../core/tool-names.js";
import { createSafetyPolicyEngine } from "../domains/safety/policy-engine.js";
import {
	commitObservationReservation,
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "./observation.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { newSearchCompleteness, skipSearchPath } from "./spawn-hygiene.js";
import { hookLandingRefusal } from "./tool-landing.js";
import { truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 500;
const PACKED_MARK = " (packed)";
const PACKED_NOTICE =
	"\n[(packed) entries ship inside dist/assets/source.pack, not as files on disk; read opens them by this path.]";

function parseLimit(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_LIMIT;
}

interface ListingEntry {
	name: string;
	order: number;
}

const compareEntries = (a: ListingEntry, b: ListingEntry): number =>
	a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.order - b.order;

/** A max heap retains the earliest names, preserving directory read order for collation ties. */
export class BoundedListingSelection {
	private readonly entries: ListingEntry[] = [];
	private nextOrder = 0;
	constructor(private readonly limit: number) {}
	get retained(): number {
		return this.entries.length;
	}
	private entryAt(index: number): ListingEntry {
		const entry = this.entries[index];
		if (!entry) throw new Error("Invalid listing heap index");
		return entry;
	}
	add(name: string): void {
		const entry = { name, order: this.nextOrder++ };
		if (this.entries.length < this.limit) {
			this.entries.push(entry);
			let i = this.entries.length - 1;
			while (i > 0) {
				const parent = Math.floor((i - 1) / 2);
				if (compareEntries(this.entryAt(parent), entry) >= 0) break;
				this.entries[i] = this.entryAt(parent);
				i = parent;
			}
			this.entries[i] = entry;
			return;
		}
		if (compareEntries(entry, this.entryAt(0)) >= 0) return;
		this.entries[0] = entry;
		let i = 0;
		while (2 * i + 1 < this.entries.length) {
			let child = 2 * i + 1;
			if (child + 1 < this.entries.length && compareEntries(this.entryAt(child + 1), this.entryAt(child)) > 0) child++;
			if (compareEntries(entry, this.entryAt(child)) >= 0) break;
			this.entries[i] = this.entryAt(child);
			i = child;
		}
		this.entries[i] = entry;
	}
	sorted(): string[] {
		return [...this.entries].sort(compareEntries).map((entry) => entry.name);
	}
}

/** Names a fast pass retains beyond the limit, so a few withheld names do not force a full screening pass. */
const selectionCapacity = (limit: number): number => Math.max(limit * 2, limit + 64);

interface ListingSelectionResult {
	/** Visible names in listing order, at most `limit`. */
	names: string[];
	/** Rendered packed entries by name, withheld ones removed. */
	packedRendered: Map<string, string>;
	scanned: number;
	retained: number;
	/** Names the path policy judged; every scanned name on the full pass. */
	screened: number;
	withheld: number;
	/** Every visible name, or null when names past the shown prefix were never screened. */
	visible: number | null;
	/** Visible or unscreened names exist past `names`. */
	more: boolean;
}

/**
 * Alphabetical selection requires examining every name, but the path policy
 * costs a filesystem walk per name. The fast pass screens only the names that
 * can be shown; `screenEvery` screens every name (exact visible total) and is
 * used when withheld names exhaust the fast pass's candidates. Returns null on
 * abort, and "short" when the fast pass could not fill the limit.
 */
async function selectListing(
	root: string,
	onDisk: boolean,
	packed: ReturnType<typeof packedSourcePathsUnder>,
	limit: number,
	allows: (entryPath: string) => boolean,
	signal: AbortSignal | undefined,
	screenEvery: boolean,
): Promise<ListingSelectionResult | null | "short"> {
	const capacity = screenEvery ? limit : selectionCapacity(limit);
	const selection = new BoundedListingSelection(capacity);
	let scanned = 0;
	let screened = 0;
	let withheld = 0;
	const screen = (name: string): boolean => {
		screened++;
		if (allows(path.join(root, name))) return true;
		withheld++;
		return false;
	};
	// Names seen on disk, kept only when the pack also has entries here.
	const diskNames = packed ? new Set<string>() : null;
	if (onDisk) {
		for await (const entry of await opendir(root)) {
			if (++scanned % 128 === 0) await yieldToLoop();
			if (signal?.aborted) return null;
			if (screenEvery && !screen(entry.name)) continue;
			diskNames?.add(entry.name);
			selection.add(entry.name);
		}
	}
	// Packed names carry their rendering ("name/" or "name") so they are
	// never stat'ed; a directory also present on disk lists once, as disk.
	const packedRendered = new Map<string, string>();
	for (const rendered of packed ? [...packed.directories, ...packed.files] : []) {
		const name = rendered.endsWith("/") ? rendered.slice(0, -1) : rendered;
		if (diskNames?.has(name) || packedRendered.has(name)) continue;
		scanned++;
		if (screenEvery && !screen(name)) continue;
		packedRendered.set(name, `${rendered}${PACKED_MARK}`);
		selection.add(name);
	}
	const candidates = selection.sorted();
	if (screenEvery) {
		const visible = scanned - withheld;
		return {
			names: candidates,
			packedRendered,
			scanned,
			retained: selection.retained,
			screened,
			withheld,
			visible,
			more: visible > limit,
		};
	}
	// Every name was retained: screen them all so the visible total is exact.
	const allRetained = scanned <= capacity;
	const names: string[] = [];
	let visibleScreened = 0;
	for (const name of candidates) {
		if (!allRetained && names.length >= limit) break;
		if (!screen(name)) {
			packedRendered.delete(name);
			continue;
		}
		visibleScreened++;
		if (names.length < limit) names.push(name);
	}
	if (!allRetained && names.length < limit) return "short";
	return {
		names,
		packedRendered,
		scanned,
		retained: selection.retained,
		screened,
		withheld,
		visible: allRetained ? visibleScreened : null,
		more: allRetained ? visibleScreened > limit : true,
	};
}

export const lsTool: ToolSpec = {
	name: ToolNames.Ls,
	description:
		'List directory entries alphabetically, "/" after directories, dotfiles included; symlinks render as name@ -> target, broken links as name@ (broken), and inaccessible entries are marked and counted.',
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Directory to list." })),
		limit: Type.Optional(Type.Number({ description: `Max entries (default ${DEFAULT_LIMIT}).` })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const rootArg = typeof args.path === "string" ? args.path : ".";
		const root = resolveReadPath(rootArg);
		const moved = hookLandingRefusal("ls", options?.hookLanding, root);
		if (moved !== null) return { kind: "error", message: moved };
		const limit = parseLimit(args.limit);

		// An installed package serves most of its own src/ from the source pack,
		// so a directory there may exist only in the pack or hold packed files.
		let onDisk = true;
		try {
			const rootStat = await stat(root);
			if (!rootStat.isDirectory()) {
				return { kind: "error", message: `ls: not a directory: ${root}` };
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT" || packedSourceDirectory(root) === null) {
				const msg = err instanceof Error ? err.message : String(err);
				return { kind: "error", message: `ls: ${msg}` };
			}
			onDisk = false;
		}
		const packed = packedSourcePathsUnder(root, { depth: 1 });
		const reservation = reserveObservation(OBSERVE_SELF_CAPS.ls, options);
		if (reservation.exhausted) {
			return observationBudgetExhausted({
				tool: ToolNames.Ls,
				unit: "entries",
				reservation,
				subject: `listing ${rootArg}`,
				hint: "Use find with a narrower pattern or continue in a follow-up turn.",
			});
		}

		commitObservationReservation(reservation);
		try {
			const policy = options?.allowsObservationPath ? undefined : createSafetyPolicyEngine({ cwd: process.cwd() });
			const allows = options?.allowsObservationPath ?? ((entryPath: string) => policy?.readablePath(entryPath) !== false);
			let picked = await selectListing(root, onDisk, packed, limit, allows, options?.signal, false);
			if (picked === "short") picked = await selectListing(root, onDisk, packed, limit, allows, options?.signal, true);
			if (picked === null || picked === "short")
				return { kind: "error", message: "ls: operation aborted during enumeration" };
			const { names: entries, packedRendered, scanned, withheld: withheldPaths } = picked;
			const selectionDetails = { scanned, retained: picked.retained, screened: picked.screened };
			const outputEntries: string[] = [];
			const entryLimitReached = picked.more;
			const search = newSearchCompleteness();
			let packedShown = 0;
			for (const entry of entries) {
				const packedEntry = packedRendered.get(entry);
				if (packedEntry !== undefined) {
					outputEntries.push(packedEntry);
					packedShown++;
					continue;
				}
				const entryPath = path.join(root, entry);
				try {
					const entryStat = await lstat(entryPath);
					if (entryStat.isSymbolicLink()) {
						const target = await readlink(entryPath);
						try {
							await stat(entryPath);
							outputEntries.push(`${entry}@ -> ${target}`);
						} catch (error) {
							const code = (error as NodeJS.ErrnoException).code;
							outputEntries.push(`${entry}@ (${code === "ENOENT" || code === "ENOTDIR" ? "broken" : "unreadable"})`);
							skipSearchPath(search, entryPath);
						}
					} else {
						outputEntries.push(entryStat.isDirectory() ? `${entry}/` : entry);
					}
				} catch {
					outputEntries.push(`${entry} (unreadable)`);
					skipSearchPath(search, entryPath);
				}
			}

			if (outputEntries.length === 0) {
				return finalizeObservation({
					tool: ToolNames.Ls,
					withheldPaths,
					unit: "entries",
					output: "(empty directory)",
					details: { skipped: search.skipped, selection: selectionDetails },
					shownCount: 0,
					totalCount: 0,
					truncated: false,
					reservation,
					...(options ? { options } : {}),
				});
			}

			const fullOutput = outputEntries.join("\n");
			const truncation = truncateHead(fullOutput, {
				maxBytes: reservation.callCapBytes,
				maxLines: Number.MAX_SAFE_INTEGER,
			});
			const truncated = entryLimitReached || truncation.truncated;
			// The fast pass screens only the names it shows, so the rest may hold
			// protected paths and the visible total is only a lower bound.
			const unscreenedNotice =
				picked.visible === null
					? `\n[${scanned} names in this directory; only the first ${picked.screened} in order were checked against path policy, so the visible total is not counted.]`
					: "";
			return finalizeObservation({
				tool: ToolNames.Ls,
				withheldPaths,
				unit: "entries",
				output: truncation.content + (packedShown > 0 ? PACKED_NOTICE : "") + unscreenedNotice,
				details: {
					skipped: search.skipped,
					selection: selectionDetails,
					...(packedRendered.size > 0 ? { packed: { entries: packedRendered.size, shown: packedShown } } : {}),
				},
				// Offload only when the byte cap cut collected entries; a bare
				// entry limit continues via `next`.
				...(truncation.truncated ? { fullOutput } : {}),
				shownCount: truncation.outputLines,
				totalCount: picked.visible,
				truncated,
				...(entryLimitReached ? { next: `limit=${limit * 2}` } : {}),
				reservation,
				...(options ? { options } : {}),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `ls: ${msg}` };
		} finally {
			releaseObservation(reservation);
		}
	},
};
