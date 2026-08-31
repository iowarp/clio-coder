/**
 * The one way a browser may name a durable artifact.
 *
 * Every other host adapter takes fixed argv precisely so that nothing the
 * browser says can steer a child process. Two operations cannot work that way:
 * reading one evidence bundle and verifying one receipt both need an id, and an
 * id typed into a frame is exactly the free-form argv the rest of this boundary
 * refuses.
 *
 * The resolution is that the browser never introduces an id. It may only echo
 * one the host itself served, inside the bounded snapshot the host is currently
 * showing. The host keeps that window here, replaces it wholesale on every new
 * snapshot, and refuses anything outside it loudly rather than passing it on.
 * An id that has aged out of the window is no longer referenceable, which is
 * the honest consequence: the browser is asking about something the host is no
 * longer claiming exists.
 *
 * This is deliberately not a cache, a session, or a capability token. It is the
 * smallest thing that makes "the browser may only point at what it was shown"
 * checkable in one place, so no adapter has to re-derive it.
 */

/** Artifact families a browser may reference. One window is kept per family. */
export const ARTIFACT_KINDS = ["evidence", "run"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The widest window any projection may serve.
 *
 * Every projection that feeds this is already bounded well below it, so the cap
 * is not the operating limit. It is the assertion that a projection which
 * somehow returned an unbounded list is a bug to be surfaced rather than an
 * allowlist to be filled.
 */
export const MAX_SERVED_ARTIFACT_IDS = 64;

/**
 * The shape an artifact id may take.
 *
 * Membership in the window is the real check. This is the second one, and it
 * exists because an admitted id becomes a child process argument: no separator,
 * no traversal, no leading dash that a command could read as a flag, and no
 * length that could push a command line past a limit.
 */
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isArtifactId(value: unknown): value is string {
	return typeof value === "string" && ARTIFACT_ID.test(value) && !value.includes("..");
}

/**
 * A reference the host declined. `reason` separates the two operator states
 * that a single "not found" would blur together.
 */
export class ArtifactNotServedError extends Error {
	override readonly name = "ArtifactNotServedError";

	constructor(
		readonly kind: ArtifactKind,
		readonly reason: "no-window" | "outside-window" | "malformed",
		message: string,
	) {
		super(message);
	}
}

/** A projection tried to serve something it could not have produced. */
export class ArtifactServeError extends Error {
	override readonly name = "ArtifactServeError";
}

export class ArtifactAllowlist {
	readonly #windows = new Map<ArtifactKind, ReadonlySet<string>>();

	/**
	 * Record the ids one snapshot showed, replacing that family's window.
	 *
	 * Wholesale replacement rather than accumulation is the point. Merging would
	 * let the referenceable set grow for the life of the process and would let a
	 * browser reach an artifact the host stopped showing several refreshes ago.
	 */
	serve(kind: ArtifactKind, ids: readonly string[]): void {
		if (ids.length > MAX_SERVED_ARTIFACT_IDS) {
			throw new ArtifactServeError(`A ${kind} projection served more ids than the host will hold.`);
		}
		const window = new Set<string>();
		for (const id of ids) {
			// Both of these are host-side bugs rather than hostile input: every
			// projection that feeds this already rejects a malformed or duplicated
			// id, so reaching here means the caller did not use one.
			if (!isArtifactId(id)) {
				throw new ArtifactServeError(`A ${kind} projection served an id this host cannot reference.`);
			}
			if (window.has(id)) {
				throw new ArtifactServeError(`A ${kind} projection served ${id} twice.`);
			}
			window.add(id);
		}
		this.#windows.set(kind, window);
	}

	/** Forget every window. Used when the host stops claiming any snapshot is current. */
	clear(): void {
		this.#windows.clear();
	}

	/** How many ids of this family are currently referenceable. */
	size(kind: ArtifactKind): number {
		return this.#windows.get(kind)?.size ?? 0;
	}

	/**
	 * Return `id` when the host served it in the current window, and throw
	 * otherwise. The returned value is the caller's only licence to put an id
	 * into argv, so callers must use the return rather than their own input.
	 */
	admit(kind: ArtifactKind, id: unknown): string {
		if (!isArtifactId(id)) {
			throw new ArtifactNotServedError(kind, "malformed", `That ${kind} reference is not an identifier.`);
		}
		const window = this.#windows.get(kind);
		if (window === undefined) {
			throw new ArtifactNotServedError(
				kind,
				"no-window",
				`Read the ${kind} record before asking about one of its entries.`,
			);
		}
		if (!window.has(id)) {
			throw new ArtifactNotServedError(
				kind,
				"outside-window",
				`That ${kind} is not in the record this session is showing. Refresh and try again.`,
			);
		}
		return id;
	}
}
