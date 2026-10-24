/**
 * What a server does with gpt-oss Harmony frames, and the vLLM flags that make
 * it do all of it (#435). A leaf shared by the engine's recovery layer, the
 * vLLM runtime probe and the `targets` report, so the flag text exists once.
 */

export const VLLM_GPT_OSS_SERVE_FLAGS =
	"--reasoning-parser openai_gptoss --tool-call-parser openai --enable-auto-tool-choice";

/**
 * How much of the Harmony format the server parsed itself, read from one
 * response: `none` left the analysis channel in raw markers, `reasoning-only`
 * parsed reasoning but left other frames raw, `full` returned structured
 * fields, `unknown` gave no evidence either way.
 */
export type HarmonyServerParsing = "none" | "reasoning-only" | "full" | "unknown";

/** The vLLM flags a server at this level is missing, as a sentence tail, or empty. */
export function missingVllmHarmonyFlags(level: HarmonyServerParsing | undefined): string {
	switch (level) {
		case "none":
			return `; for vLLM add ${VLLM_GPT_OSS_SERVE_FLAGS}`;
		case "reasoning-only":
			return "; for vLLM add --tool-call-parser openai --enable-auto-tool-choice";
		default:
			return "";
	}
}
