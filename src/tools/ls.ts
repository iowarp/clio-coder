import { lstat, opendir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { Type } from "typebox";
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
import { truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 500;

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

export const lsTool: ToolSpec = {
	name: ToolNames.Ls,
	description:
		'List directory entries sorted alphabetically, "/" suffix for directories, dotfiles included. Symlinks render as name@ -> target, broken links as name@ (broken), and inaccessible entries are marked and counted.',
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Directory to list." })),
		limit: Type.Optional(Type.Number({ description: `Max entries (default ${DEFAULT_LIMIT}).` })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const rootArg = typeof args.path === "string" ? args.path : ".";
		const root = resolveReadPath(rootArg);
		const limit = parseLimit(args.limit);

		try {
			const rootStat = await stat(root);
			if (!rootStat.isDirectory()) {
				return { kind: "error", message: `ls: not a directory: ${root}` };
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `ls: ${msg}` };
		}
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
			const allows =
				options?.allowsObservationPath ??
				((entryPath: string) =>
					policy?.evaluate({ tool: "read", args: { path: entryPath } }).reasonCode !== "path-policy:zeroAccessPaths");
			let withheldPaths = 0;
			let visibleCount = 0;
			let scanned = 0;
			const selection = new BoundedListingSelection(limit);
			// Alphabetical selection requires examining every name, but only limit
			// names are retained. No metadata calls are made for unselected entries.
			for await (const entry of await opendir(root)) {
				if (++scanned % 128 === 0) await yieldToLoop();
				if (options?.signal?.aborted) return { kind: "error", message: "ls: operation aborted during enumeration" };
				if (!allows(path.join(root, entry.name))) {
					withheldPaths++;
					continue;
				}
				visibleCount++;
				selection.add(entry.name);
			}
			const entries = selection.sorted();
			const outputEntries: string[] = [];
			const entryLimitReached = visibleCount > limit;
			const search = newSearchCompleteness();
			for (const entry of entries) {
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
					details: { skipped: search.skipped, selection: { scanned, retained: selection.retained } },
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
			return finalizeObservation({
				tool: ToolNames.Ls,
				withheldPaths,
				unit: "entries",
				output: truncation.content,
				details: { skipped: search.skipped, selection: { scanned, retained: selection.retained } },
				// Offload only when the byte cap cut collected entries; a bare
				// entry limit continues via `next`.
				...(truncation.truncated ? { fullOutput } : {}),
				shownCount: truncation.outputLines,
				totalCount: visibleCount,
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
