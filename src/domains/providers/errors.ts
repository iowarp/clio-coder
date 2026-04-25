/**
 * Provider-level error discriminators.
 */
import { isEngineContextOverflow } from "../../engine/ai.js";

/**
 * Discriminated error the chat-loop acts on. `kind` is a literal so union
 * narrowing picks it out even when the original was re-thrown across an async
 * boundary and lost its prototype chain.
 */
export class ContextOverflowError extends Error {
	readonly kind = "context-overflow" as const;
	readonly original: unknown;

	constructor(message: string, original?: unknown) {
		super(message);
		this.name = "ContextOverflowError";
		this.original = original;
	}
}

/**
 * Structural guard. True for both instanceof ContextOverflowError and any
 * plain object carrying `{ kind: "context-overflow" }` so error boundaries
 * can transport the classification across workers without re-hydrating a
 * class instance.
 */
export function isContextOverflowError(err: unknown): err is ContextOverflowError {
	if (err instanceof ContextOverflowError) return true;
	if (!err || typeof err !== "object") return false;
	return (err as { kind?: unknown }).kind === "context-overflow";
}

/**
 * Coerce an arbitrary thrown value into a ContextOverflowError when its
 * message matches pi-ai's context-overflow detector. Returns null when the
 * value does not look like an overflow; the caller should then surface the
 * original error to the user unchanged.
 */
export function toContextOverflowError(err: unknown): ContextOverflowError | null {
	if (isContextOverflowError(err))
		return err instanceof ContextOverflowError
			? err
			: new ContextOverflowError(
					typeof (err as { message?: unknown }).message === "string"
						? (err as { message: string }).message
						: "context overflow",
					err,
				);
	const message = extractMessage(err);
	if (!message) return null;
	if (isEngineContextOverflow(message)) return new ContextOverflowError(message, err);
	return null;
}

function extractMessage(err: unknown): string {
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const m = (err as { message?: unknown }).message;
		if (typeof m === "string") return m;
	}
	return "";
}
