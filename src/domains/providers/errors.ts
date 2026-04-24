/**
 * Provider-level error discriminators (Phase 12 slice 12d).
 *
 * pi-ai does not export a typed context-overflow error. Providers surface
 * overflow in different shapes (OpenAI 400 + message, Anthropic 400 + message,
 * llama.cpp 400 + message, Groq/Mistral 400 + message). The chat-loop catches
 * whatever the agent throws, inspects it with `toContextOverflowError`, and
 * routes the one-shot compact-and-retry path when the heuristic matches.
 *
 * The matcher is intentionally narrow. An unknown provider variant falls
 * through as a plain error so the user sees the real upstream message rather
 * than a misleading "context overflow" banner. Known substrings are listed
 * below; if a provider rewords its error, update this list in the same
 * commit as the observation.
 */

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
 * Known substrings that identify a context-length overflow across providers.
 *
 *   /context[_ -]length.*exceed/i: OpenAI "context_length_exceeded",
 *     "context length exceeded", "maximum context length".
 *   /maximum context length/i: OpenAI variant without "exceed".
 *   /context[_ -]window.*exceed/i: llama.cpp / Groq "context window exceeded".
 *   /prompt is too long/i: Anthropic literal.
 *   /request (?:is )?too large/i: Anthropic / Groq large-payload rejection.
 *   /token(?:s)?.{0,40}exceed/i: catches "tokens exceed" without keying on
 *                                   the word "context" (Groq, Mistral).
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
	/context[_ -]length.*exceed/i,
	/maximum context length/i,
	/context[_ -]window.*exceed/i,
	/prompt is too long/i,
	/request (?:is )?too large/i,
	/token(?:s)?.{0,40}exceed/i,
];

/**
 * Coerce an arbitrary thrown value into a ContextOverflowError when its
 * message matches a known overflow pattern. Returns null when the value does
 * not look like an overflow; the caller should then surface the original
 * error to the user unchanged.
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
	for (const pattern of CONTEXT_OVERFLOW_PATTERNS) {
		if (pattern.test(message)) return new ContextOverflowError(message, err);
	}
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
