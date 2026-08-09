/**
 * The context budget Clio is built for, in one place.
 *
 * These are not preferences and not a recommendation. Every tier Clio targets
 * (hosted frontier models, LM Studio, llama.cpp, vLLM, SGLang) ships models at
 * 128k or more, and Clio's own prompt envelope plus a repository's worth of
 * tool results does not fit in less. A number below this floor is nearly always
 * a runtime that was asked and did not answer, not a model that is genuinely
 * that small.
 *
 * The historical 8192 default predates every model Clio runs against. It was
 * indistinguishable from a real answer at every call site that consumed it, so
 * a target that simply failed to report its window silently ran the whole
 * session at 6% of its real capacity. Assuming the floor and saying the number
 * is unverified is both more accurate and recoverable; assuming 8192 is neither.
 */

/** Context window Clio assumes when a chat target does not report a real one. */
export const CLIO_MIN_CONTEXT_WINDOW = 131_072;

/** Output tokens Clio requests per turn when nothing smaller is configured. */
export const CLIO_MIN_MAX_OUTPUT_TOKENS = 32_768;

/**
 * The window below which Clio says the target is too small for the work.
 *
 * Separate from {@link CLIO_MIN_CONTEXT_WINDOW} on purpose, and 3,072 tokens
 * under it. Several frontier models ship at exactly 128,000 rather than 2^17,
 * and a warning that a 128,000-token model is 2% short of Clio's assumption is
 * noise on a target that is entirely adequate. The assumption is what Clio uses
 * when nobody answers; this is what Clio complains about.
 */
export const CLIO_CONTEXT_WINDOW_WARN_BELOW = 128_000;
