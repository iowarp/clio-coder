/**
 * Strips tokenizer special-token sentinels from assistant-generated text.
 *
 * Local inference servers (LM Studio, llama.cpp, Ollama) and routed providers
 * sometimes leak the underlying tokenizer's end-of-text or chat-template
 * sentinels into the streamed response. The leak happens when the model emits
 * the sentinel as a regular generated token because the chat template is
 * misconfigured or the server does not strip special tokens before returning
 * them. Once leaked, strings like `<|endoftext|>` render verbatim in the TUI
 * and persist into turn history, where they confuse the next turn.
 *
 * This helper is conservative: it strips only the exact union of known
 * tokenizer sentinels listed in {@link KNOWN_SENTINELS}. Lookalike strings
 * such as `<|something_random|>` are preserved so that a user pasting
 * tokenizer documentation into Clio sees their text untouched. The helper
 * is designed for assistant-generated text deltas only; never call it on
 * user-typed input or tool result content.
 *
 * The sentinel union covers Qwen (`<|endoftext|>`, `<|im_start|>`,
 * `<|im_end|>`, `<|fim_*|>`), Llama 3 (`<|eot_id|>`), Gemma (`<|end_of_turn|>`),
 * older sentence-piece models (`<s>`, `</s>`), and CodeGemma's
 * `<|file_separator|>`. Add new entries to {@link KNOWN_SENTINELS} when a
 * model family with a different chat template starts leaking.
 */

const KNOWN_SENTINELS: ReadonlyArray<string> = [
	"<|endoftext|>",
	"<|im_start|>",
	"<|im_end|>",
	"<|eot_id|>",
	"<|end_of_turn|>",
	"<|fim_prefix|>",
	"<|fim_middle|>",
	"<|fim_suffix|>",
	"<|file_separator|>",
	"<s>",
	"</s>",
];

/**
 * Single compiled RegExp matching every known sentinel. Sourced from
 * {@link KNOWN_SENTINELS} so the list stays the single source of truth.
 */
const SENTINEL_RE = new RegExp(KNOWN_SENTINELS.map((s) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|"), "g");

/**
 * Length of the longest known sentinel. Used by the streaming stripper to
 * decide how many trailing characters of a chunk to buffer when those
 * characters could be the prefix of a sentinel that completes in the next
 * chunk.
 */
const MAX_SENTINEL_LEN = KNOWN_SENTINELS.reduce((max, s) => (s.length > max ? s.length : max), 0);

/**
 * Strip every occurrence of a known sentinel from `text`. Use this on
 * non-streaming assistant text or to scrub a complete buffer in one shot.
 */
export function stripTokenizerSentinels(text: string): string {
	if (text.length === 0) return text;
	return text.replace(SENTINEL_RE, "");
}

/**
 * Returns true when `tail` is a non-empty prefix of any known sentinel.
 * The streaming stripper uses this to decide whether to hold a trailing
 * fragment back until the next chunk arrives.
 */
function isSentinelPrefix(tail: string): boolean {
	if (tail.length === 0) return false;
	for (const sentinel of KNOWN_SENTINELS) {
		if (sentinel.length > tail.length && sentinel.startsWith(tail)) return true;
	}
	return false;
}

/**
 * Stateful stripper for streaming text deltas. A sentinel may straddle a
 * chunk boundary (e.g. `<|endoftex` arrives in one delta and `t|>` in the
 * next), so the stripper keeps a small trailing buffer when the tail of the
 * incoming chunk could be the start of a sentinel and only emits that tail
 * once the next chunk confirms or denies the match. Call {@link flush} when
 * the upstream stream ends to release any buffered remainder; anything left
 * at that point cannot be a sentinel and is emitted verbatim minus any
 * complete sentinels still embedded in it.
 */
export interface SentinelStripper {
	/** Sanitize the next streamed chunk, returning the safe-to-emit prefix. */
	push(chunk: string): string;
	/** Drain the trailing buffer at end-of-stream. */
	flush(): string;
}

export function createSentinelStripper(): SentinelStripper {
	let buffer = "";
	return {
		push(chunk: string): string {
			if (chunk.length === 0) return "";
			buffer += chunk;
			// Strip every complete sentinel currently in the buffer.
			const stripped = buffer.replace(SENTINEL_RE, "");
			// Hold back at most MAX_SENTINEL_LEN - 1 trailing characters when
			// they form a non-empty prefix of any known sentinel. Anything
			// shorter than that cannot complete a sentinel without further
			// input.
			const holdMax = Math.min(stripped.length, MAX_SENTINEL_LEN - 1);
			let hold = 0;
			for (let take = holdMax; take > 0; take--) {
				const tail = stripped.slice(stripped.length - take);
				if (isSentinelPrefix(tail)) {
					hold = take;
					break;
				}
			}
			const safe = hold === 0 ? stripped : stripped.slice(0, stripped.length - hold);
			buffer = hold === 0 ? "" : stripped.slice(stripped.length - hold);
			return safe;
		},
		flush(): string {
			if (buffer.length === 0) return "";
			const remainder = buffer.replace(SENTINEL_RE, "");
			buffer = "";
			return remainder;
		},
	};
}
