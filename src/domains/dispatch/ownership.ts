/**
 * Which Clio session and project a dispatch run or detached batch belongs to.
 *
 * Every dispatch store lives in the one machine-wide state dir, so every Clio
 * process on the machine reads every other process's runs, receipts, batches,
 * and gate records. Without an owner, a session opened in one project was
 * nudged to collect a batch another project dispatched, collected it (closing
 * the owner's agent ledger), and could cancel or continue runs it never made.
 *
 * A run or batch stamped with a session id belongs to that session alone. A
 * row with no session id was written before runs carried one, or by a process
 * with no session (`clio-coder fleet`), and belongs to whatever session runs in
 * the project it was dispatched from.
 *
 * Two strengths of check, for two kinds of use:
 *   owns  acting on a row: nudging, collecting, cancelling, continuing,
 *         recovering its gate decisions.
 *   sees  reading a row: status, receipt, evidence, the /view overlay. A
 *         sibling session in the same project may read its runs.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalizePath, createPathWalkMemo } from "../../core/path-canonical.js";

export interface DispatchOwner {
	/** Clio session id of this process; null when it runs without one. */
	readonly sessionId: string | null;
	/** Workspace the process runs in; project-scoped checks resolve against it. */
	readonly cwd: string;
}

export interface OwnedRunFields {
	readonly sessionId: string | null;
	readonly cwd: string;
}

export interface OwnedBatchFields {
	readonly sessionId: string | null;
	readonly cwd?: string;
}

/** An aggregate over runs, such as an evidence bundle: one session id and the cwds its runs executed in. */
export interface OwnedBundleFields {
	readonly sessionId: string | null;
	readonly cwds: ReadonlyArray<string>;
}

export interface DispatchOwnership {
	readonly owner: DispatchOwner;
	/** True when `cwd` is the owner's workspace or inside it. */
	inProject(cwd: string | undefined): boolean;
	ownsRun(run: OwnedRunFields): boolean;
	seesRun(run: OwnedRunFields): boolean;
	ownsBatch(batch: OwnedBatchFields): boolean;
	seesBundle(bundle: OwnedBundleFields): boolean;
}

/**
 * The owner a caller holding a dispatch contract acts as. The contract's own
 * owner wins because it is what stamped the runs; the invocation's session id
 * only fills in for a contract that has none.
 */
export function dispatchOwnerOf(
	dispatch: { owner?: () => DispatchOwner },
	fallbackSessionId?: string | null,
): DispatchOwner {
	const owner = dispatch.owner?.();
	const fallback = fallbackSessionId ?? null;
	if (owner === undefined) return { sessionId: fallback, cwd: process.cwd() };
	return owner.sessionId === null && fallback !== null ? { ...owner, sessionId: fallback } : owner;
}

/**
 * Ownership checks for one owner. Canonical paths are memoized for the life of
 * the returned object, so build one per listing or tool call and drop it: a
 * listing over the whole ledger resolves the same few cwds a thousand times.
 */
export function dispatchOwnership(owner: DispatchOwner): DispatchOwnership {
	const memo = createPathWalkMemo();
	const canonical = new Map<string, string | null>();
	const canonicalOf = (path: string): string | null => {
		let cached = canonical.get(path);
		if (cached === undefined) {
			cached = canonicalizePath(resolve(path), memo);
			canonical.set(path, cached);
		}
		return cached;
	};
	const inProject = (cwd: string | undefined): boolean => {
		// An empty cwd is a row whose origin was never recorded. Resolving it
		// would yield this process's cwd and adopt it into every project.
		if (cwd === undefined || cwd.length === 0 || owner.cwd.length === 0) return false;
		const root = canonicalOf(owner.cwd);
		const candidate = canonicalOf(cwd);
		if (root === null || candidate === null) return false;
		const rel = relative(root, candidate);
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	};
	const ownsRun = (run: OwnedRunFields): boolean =>
		run.sessionId !== null && run.sessionId !== undefined ? run.sessionId === owner.sessionId : inProject(run.cwd);
	return {
		owner,
		inProject,
		ownsRun,
		seesRun: (run) => ownsRun(run) || inProject(run.cwd),
		ownsBatch: (batch) =>
			batch.sessionId !== null && batch.sessionId !== undefined
				? batch.sessionId === owner.sessionId
				: inProject(batch.cwd),
		seesBundle: (bundle) =>
			(bundle.sessionId !== null && bundle.sessionId === owner.sessionId) || bundle.cwds.some((cwd) => inProject(cwd)),
	};
}
