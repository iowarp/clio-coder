/**
 * What a headless run answers a tool call that needs an approval nobody can
 * give. There is no operator on the other end of `clio-coder run`, so every ask-rail
 * call below `full-auto` is denied with this sentence.
 *
 * It lives here rather than inline at the deny site because two surfaces read
 * it: the orchestrator writes it, and the skill-eval harness recognizes it in
 * an arm transcript to tell "the skill did not do the work" apart from "the
 * harness never let it try". A recognizer holding its own copy of the sentence
 * would silently stop matching the day the wording changed.
 */
export const HEADLESS_PERMISSION_DENIED_REASON =
	"clio-coder run cannot confirm permission requests; rerun interactively to approve this action.";

/**
 * The stable clause of that sentence, for matching against transcripts where
 * the remedy half may have been truncated by a preview or elision budget.
 * `HEADLESS_PERMISSION_DENIED_REASON` starts with it, which a contract test
 * pins.
 */
export const HEADLESS_PERMISSION_DENIED_MARKER = "clio-coder run cannot confirm permission requests";
