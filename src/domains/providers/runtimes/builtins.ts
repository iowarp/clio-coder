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

import anthropic from "./cloud/anthropic.js";
import bedrock from "./cloud/bedrock.js";
import google from "./cloud/google.js";
import groq from "./cloud/groq.js";
import mistral from "./cloud/mistral.js";
import openai from "./cloud/openai.js";
import openrouter from "./cloud/openrouter.js";

import claudeCodeCli from "./subprocess/claude-code-cli.js";
import codexCli from "./subprocess/codex-cli.js";
import geminiCli from "./subprocess/gemini-cli.js";

import aphrodite from "./local/aphrodite.js";
import koboldcpp from "./local/koboldcpp.js";
import lemonadeAnthropic from "./local/lemonade-anthropic.js";
import lemonadeOpenai from "./local/lemonade-openai.js";
import litellmGateway from "./local/litellm-gateway.js";
import llamacppAnthropic from "./local/llamacpp-anthropic.js";
import llamacppCompletion from "./local/llamacpp-completion.js";
import llamacppEmbed from "./local/llamacpp-embed.js";
import llamacppOpenai from "./local/llamacpp-openai.js";
import llamacppRerank from "./local/llamacpp-rerank.js";
import lmstudioNative from "./local/lmstudio-native.js";
import lmstudio from "./local/lmstudio.js";
import localai from "./local/localai.js";
import mistralRs from "./local/mistral-rs.js";
import mlc from "./local/mlc.js";
import ollamaNative from "./local/ollama-native.js";
import ollamaOpenai from "./local/ollama-openai.js";
import openaiCompat from "./local/openai-compat.js";
import sglang from "./local/sglang.js";
import tabbyapi from "./local/tabbyapi.js";
import tgi from "./local/tgi.js";
import vllm from "./local/vllm.js";

const BUILTIN_RUNTIMES: ReadonlyArray<RuntimeDescriptor> = [
	anthropic,
	bedrock,
	google,
	groq,
	mistral,
	openai,
	openrouter,
	claudeCodeCli,
	codexCli,
	geminiCli,
	aphrodite,
	koboldcpp,
	lemonadeAnthropic,
	lemonadeOpenai,
	litellmGateway,
	llamacppAnthropic,
	llamacppCompletion,
	llamacppEmbed,
	llamacppOpenai,
	llamacppRerank,
	lmstudio,
	lmstudioNative,
	localai,
	mistralRs,
	mlc,
	ollamaNative,
	ollamaOpenai,
	openaiCompat,
	sglang,
	tabbyapi,
	tgi,
	vllm,
];

export function registerBuiltinRuntimes(registry: RuntimeRegistry): void {
	for (const desc of BUILTIN_RUNTIMES) {
		if (registry.get(desc.id) !== null) continue;
		registry.register(desc);
	}
}

export { BUILTIN_RUNTIMES };
