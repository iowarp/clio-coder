/**
 * Registers every runtime descriptor that ships in-tree with the given
 * registry. Safe to call repeatedly: descriptor ids that are already
 * registered are skipped, so tests and boot paths that poke pieces of the
 * registry before the providers domain starts won't double-register.
 *
 * Third-party runtimes from ~/.clio/runtimes/ or npm plugins are loaded
 * separately by `loadPluginRuntimes` in `./plugins.ts`.
 */

import type { RuntimeRegistry } from "../registry.js";
import type { RuntimeDescriptor } from "../types/runtime-descriptor.js";
import claudeCodeCli from "./cli-stub/claude-code-cli.js";
import claudeCodeSdk from "./cli-stub/claude-code-sdk.js";
import codexCli from "./cli-stub/codex-cli.js";
import copilotCli from "./cli-stub/copilot-cli.js";
import geminiCli from "./cli-stub/gemini-cli.js";
import openCodeCli from "./cli-stub/opencode-cli.js";
import anthropic from "./cloud/anthropic.js";
import bedrock from "./cloud/bedrock.js";
import deepseek from "./cloud/deepseek.js";
import google from "./cloud/google.js";
import groq from "./cloud/groq.js";
import mistral from "./cloud/mistral.js";
import openai from "./cloud/openai.js";
import openaiCodex from "./cloud/openai-codex.js";
import openrouter from "./cloud/openrouter.js";
import lemonadeAnthropic from "./local-native/lemonade-anthropic.js";
import lemonadeOpenai from "./local-native/lemonade-openai.js";
import llamacpp from "./local-native/llamacpp.js";
import llamacppAnthropic from "./local-native/llamacpp-anthropic.js";
import llamacppCompletion from "./local-native/llamacpp-completion.js";
import llamacppEmbed from "./local-native/llamacpp-embed.js";
import llamacppRerank from "./local-native/llamacpp-rerank.js";
import lmstudioNative from "./local-native/lmstudio-native.js";
import ollamaNative from "./local-native/ollama-native.js";
import sglang from "./local-native/sglang.js";
import vllm from "./local-native/vllm.js";
import anthropicCompat from "./protocol/anthropic-compat.js";
import openaiCompat from "./protocol/openai-compat.js";

const BUILTIN_RUNTIMES: ReadonlyArray<RuntimeDescriptor> = [
	anthropic,
	bedrock,
	deepseek,
	google,
	groq,
	mistral,
	openai,
	openaiCodex,
	openrouter,
	claudeCodeSdk,
	claudeCodeCli,
	codexCli,
	geminiCli,
	copilotCli,
	openCodeCli,
	lemonadeAnthropic,
	lemonadeOpenai,
	llamacpp,
	llamacppAnthropic,
	llamacppCompletion,
	llamacppEmbed,
	llamacppRerank,
	lmstudioNative,
	ollamaNative,
	anthropicCompat,
	openaiCompat,
	sglang,
	vllm,
];

export function registerBuiltinRuntimes(registry: RuntimeRegistry): void {
	for (const desc of BUILTIN_RUNTIMES) {
		if (registry.get(desc.id) !== null) continue;
		registry.register(desc);
	}
}

export { BUILTIN_RUNTIMES };
