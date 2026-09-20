import { AppProblem } from "./problem.js";

/**
 * The one way a browser may name a durable artifact.
 *
 * Every other adapter takes fixed argv precisely so that nothing the browser
 * says can steer a child process. Two operations cannot work that way: reading
 * one evidence bundle and verifying one receipt both need an id, and an id typed
 * into a URL is exactly the free-form argv the rest of this boundary refuses.
 *
 * The resolution is that the browser never introduces an id. It may only echo
 * one the server itself served, inside the bounded snapshot the server is
 * currently showing. The server keeps that window here, replaces it wholesale on
 * every fresh listing, and refuses anything outside it loudly rather than
 * passing it on. An id that has aged out is no longer referenceable, which is
 * the honest consequence: the browser is asking about something the server is no
 * longer claiming exists.
 *
 * This is deliberately not a cache, a session, or a capability token. It is the
 * smallest thing that makes "the browser may only point at what it was shown"
 * checkable in one place.
 */

/** Artifact families a browser may reference. One window is kept per family. */
export const ARTIFACT_KINDS = ["evidence", "run", "dispatch"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Fleet roots and dispatch runs are separate families because the fleet page
 * shows both listings at once: merging them would mean whichever query resolved
 * second silently unlinked the other list's receipts. They are admitted together
 * because a receipt, an evidence build and a receipt verify all take a run id
 * and cannot tell which listing showed it.
 */
export const RUN_KINDS = ["run", "dispatch"] as const satisfies readonly ArtifactKind[];

/**
 * The widest window any projection may serve. Every list route is clamped below
 * it, so the cap is not the operating limit: it is the assertion that a
 * projection which somehow returned an unbounded list is a bug to be surfaced
 * rather than an allowlist to be filled.
 */
export const MAX_SERVED_ARTIFACT_IDS = 64;

/**
 * The shape an artifact id may take. Membership in the window is the real check.
 * This is the second one, and it exists because an admitted id becomes a child
 * process argument: no separator, no traversal, no leading dash a command could
 * read as a flag, and no length that could push a command line past a limit.
 * Identical to `Id` in contracts/common.ts, restated so this file stands alone.
 */
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isArtifactId(value: unknown): value is string {
	return typeof value === "string" && ARTIFACT_ID.test(value) && !value.includes("..");
}

export type RefusalReason = "no-window" | "outside-window" | "malformed";

/**
 * A reference the server declined. 403 rather than 404: the token was valid and
 * the server never looked the id up, so reporting "not found" would claim a
 * search that did not happen. `reason` keeps the three operator states apart.
 */
export class ArtifactNotServedError extends AppProblem {
	override readonly name = "ArtifactNotServedError";
	constructor(
		readonly kind: ArtifactKind,
		readonly reason: RefusalReason,
		message: string,
	) {
		super("unauthorized", message, 403);
	}
}

/** A projection tried to serve something it could not have produced. */
export class ArtifactServeError extends AppProblem {
	override readonly name = "ArtifactServeError";
	constructor() {
		super("internal", "This app could not record which artifacts it is showing.");
	}
}
function serveError(why: string) {
	// The operator gets a generic internal problem; the cause is a server bug and
	// belongs in the log, not in a response a browser reads.
	console.error(`[clio-coder:gui] artifact window refused a projection: ${why}`);
	return new ArtifactServeError();
}

export class ArtifactWindow {
	readonly #windows = new Map<ArtifactKind, Set<string>>();

	/**
	 * Record the ids one listing showed, replacing that family's window.
	 *
	 * Wholesale replacement rather than accumulation is the point. Merging would
	 * let the referenceable set grow for the life of the process and would let a
	 * browser reach an artifact the server stopped showing several refreshes ago.
	 */
	serve(kind: ArtifactKind, ids: readonly string[]): void {
		this.#windows.set(kind, this.#validated(kind, ids, new Set<string>()));
	}

	/**
	 * Add the ids of a follow-on page to an existing window, evicting oldest-first
	 * at MAX_SERVED_ARTIFACT_IDS. Only a cursored request may extend: the first
	 * page of a listing always calls serve() so a refresh still narrows the window
	 * rather than widening it forever.
	 */
	extend(kind: ArtifactKind, ids: readonly string[]): void {
		const current = this.#windows.get(kind) ?? new Set<string>();
		const next = this.#validated(kind, ids, new Set(current));
		while (next.size > MAX_SERVED_ARTIFACT_IDS) {
			const oldest = next.values().next().value;
			if (oldest === undefined) break;
			next.delete(oldest);
		}
		this.#windows.set(kind, next);
	}

	/** Record a page, replacing on a fresh listing and extending only when the caller cursored into it. */
	page(kind: ArtifactKind, cursor: string | undefined, ids: readonly string[]): void {
		if (cursor) this.extend(kind, ids);
		else this.serve(kind, ids);
	}

	/** Forget every window. Used when the server stops claiming any snapshot is current. */
	clear(): void {
		this.#windows.clear();
	}

	/** How many ids of this family are currently referenceable. */
	size(kind: ArtifactKind): number {
		return this.#windows.get(kind)?.size ?? 0;
	}

	/**
	 * Return `id` when the server served it in the current window, and throw
	 * otherwise. The returned value is the caller's only licence to put an id into
	 * argv, so callers must use the return rather than their own input.
	 */
	admit(kind: ArtifactKind, id: unknown): string {
		if (!isArtifactId(id))
			throw new ArtifactNotServedError(kind, "malformed", `That ${kind} reference is not an identifier.`);
		const window = this.#windows.get(kind);
		if (window === undefined)
			throw new ArtifactNotServedError(
				kind,
				"no-window",
				`Read the ${kind} record before asking about one of its entries.`,
			);
		if (!window.has(id))
			throw new ArtifactNotServedError(
				kind,
				"outside-window",
				`That ${kind} is not in the record this session is showing. Refresh and try again.`,
			);
		return id;
	}

	/**
	 * Admit against several families, returning the first that licenses the id.
	 * The refusal reported is the most actionable one: telling an operator to
	 * refresh beats telling them to read a record they may already be looking at.
	 */
	admitAny(kinds: readonly [ArtifactKind, ...ArtifactKind[]], id: unknown): string {
		let refusal: ArtifactNotServedError | undefined;
		for (const kind of kinds) {
			try {
				return this.admit(kind, id);
			} catch (error) {
				if (!(error instanceof ArtifactNotServedError)) throw error;
				if (!refusal || (refusal.reason === "no-window" && error.reason !== "no-window")) refusal = error;
			}
		}
		throw refusal;
	}

	#validated(kind: ArtifactKind, ids: readonly string[], into: Set<string>): Set<string> {
		if (ids.length > MAX_SERVED_ARTIFACT_IDS)
			throw serveError(`A ${kind} projection served more ids than this server will hold.`);
		const seen = new Set<string>();
		for (const id of ids) {
			// Both of these are server-side bugs rather than hostile input: every
			// projection that feeds this already rejects a malformed or duplicated id,
			// so reaching here means the caller did not use one.
			if (!isArtifactId(id)) throw serveError(`A ${kind} projection served an id this server cannot reference.`);
			if (seen.has(id)) throw serveError(`A ${kind} projection served ${id} twice.`);
			seen.add(id);
			into.delete(id);
			into.add(id);
		}
		return into;
	}
}
