/**
 * Store ids (evidence ids, eval ids, session ids) are identifiers, not
 * filesystem paths. A store resolves them by joining under a fixed root, so an
 * id carrying a path separator, a `.`/`..` segment, a NUL, or an absolute path
 * could escape that root and read or write an unintended file. Validate the id
 * before any join. This lives in `core` so every store and CLI surface shares
 * one rule and one error type.
 */

/** Thrown when a caller-supplied store id is not a safe identifier. */
export class InvalidIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidIdError";
	}
}

/**
 * A safe id is non-empty, contains no path separator (`/` or `\`), no NUL, and
 * is not a bare `.`/`..` segment. Those are the only tokens that let `join`
 * escape a fixed root, so rejecting them is sufficient without an allowlist that
 * would break existing id shapes.
 */
export function isSafeId(id: string): boolean {
	if (id.length === 0) return false;
	if (id.includes("/") || id.includes("\\")) return false;
	if (id.includes("\0")) return false;
	if (id === "." || id === "..") return false;
	return true;
}

/** Throw {@link InvalidIdError} unless `id` is a safe identifier. `kind` names the id in the message. */
export function assertSafeId(id: string, kind: string): void {
	if (!isSafeId(id)) {
		throw new InvalidIdError(`invalid ${kind} id '${id}': must not contain path separators or path segments`);
	}
}
