/**
 * Local lexical matching over skill text. No model call, no network, and no
 * request text ever leaves the process.
 *
 * Two callers with two different error costs share this vocabulary.
 * `promotion.ts` scores an *unsolicited* install offer, where a false positive
 * costs operator trust, so it keeps its own conservative thresholds on top of
 * these helpers. The catalog view filters a listing the model explicitly asked
 * to narrow, where the expensive error is the opposite one: a skill the
 * operator named that the filter silently hides. {@link lexicalMatches} is
 * tuned for that second case and is not a promotion matcher.
 */

/**
 * Words too common in a coding request to distinguish one skill from another.
 * Shared so both matchers agree about what carries no signal.
 */
export const TOKEN_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"for",
	"with",
	"this",
	"that",
	"when",
	"what",
	"how",
	"into",
	"from",
	"use",
	"used",
	"using",
	"one",
	"not",
	"skill",
	"skills",
	"clio",
	"please",
	"can",
	"you",
	"should",
	"would",
	"about",
	"need",
	"want",
	"help",
	"make",
	"file",
	"files",
	"code",
]);

/** Lowercase, punctuation to spaces, whitespace collapsed. */
export function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Distinctive tokens: 4+ chars and outside the stopword set.
 *
 * The 4-character floor belongs to the promotion matcher, which fires an offer
 * nobody asked for and must not do so on `tdd` appearing in a sentence. The
 * catalog filter deliberately does not use this.
 */
export function distinctiveTokens(text: string): Set<string> {
	return new Set(
		normalize(text)
			.split(" ")
			.filter((token) => token.length >= 4 && !TOKEN_STOPWORDS.has(token)),
	);
}

/** How many of a multi-word query's tokens a row has to carry. */
export type LexicalMatchMode = "all" | "any";

/** Query tokens worth matching on: 2+ chars, outside the stopword set. */
function queryTokens(normalizedQuery: string): string[] {
	return normalizedQuery.split(" ").filter((token) => token.length >= 2 && !TOKEN_STOPWORDS.has(token));
}

/**
 * A token matches a word outright, or as its prefix once it is 3+ characters.
 *
 * Prefix matching is what makes `conflict` find `resolve-merge-conflicts` and
 * `worktree` find `worktree-create`. It is floored at 3 characters so a
 * two-letter token cannot match most of the catalog.
 */
function wordMatches(words: ReadonlySet<string>, token: string): boolean {
	if (words.has(token)) return true;
	if (token.length < 3) return false;
	for (const word of words) {
		if (word.startsWith(token)) return true;
	}
	return false;
}

/**
 * Does `haystack` match `query`?
 *
 * An empty query matches everything, so a caller can pass the operator's
 * argument through without branching.
 *
 * The whole query matching as a word sequence always wins, which is how a name
 * shorter than the token floor (`tdd`, `prd`) stays findable by typing it. The
 * sequence is matched with word boundaries on both ends, so `git` does not hit
 * `digital`.
 *
 * Failing that, the query is tokenized and matched per token. `mode` decides
 * whether every token must land or any one of them may: the catalog view tries
 * `all` first and only falls back to `any` when that returned nothing, so a
 * precise query narrows and a conversational one still finds something instead
 * of an empty page.
 */
export function lexicalMatches(query: string, haystack: string, mode: LexicalMatchMode = "all"): boolean {
	const normalizedQuery = normalize(query);
	if (normalizedQuery.length === 0) return true;
	const normalizedHaystack = normalize(haystack);
	if (` ${normalizedHaystack} `.includes(` ${normalizedQuery} `)) return true;
	const tokens = queryTokens(normalizedQuery);
	if (tokens.length === 0) return false;
	const words = new Set(normalizedHaystack.split(" ").filter((word) => word.length > 0));
	return mode === "all"
		? tokens.every((token) => wordMatches(words, token))
		: tokens.some((token) => wordMatches(words, token));
}
