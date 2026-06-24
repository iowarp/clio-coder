import { readSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { readFileArgsAsync } from "../core/file-references.js";
import { clioDataDir } from "../core/xdg.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule } from "../domains/context/index.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { buildMemoryPromptSection, loadMemoryRecordsSync } from "../domains/memory/index.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { loadSkills, ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SessionDomainModule } from "../domains/session/index.js";
import type { ImageContent } from "../engine/types.js";
import { assistantTextFromEvent } from "../tools/dispatch.js";
import { isToolProfileName } from "../tools/profiles.js";
import { parseRunCliArgs, type RunCliArgs } from "./args.js";
import { runClioCommand } from "./clio.js";
import { buildInitialMessage, readPipedStdin, shouldReadPipedStdin } from "./initial-message.js";
import { flushRawStdout, restoreStdout, takeOverStdout } from "./output-guard.js";
import { setupSteerChannel } from "./steer-channel.js";

const USAGE =
	'usage: clio run [--target <id>] [--model <wireId>] [--thinking <level>] [--json] [--agent <recipe-id>] "<task>"\n';

const HELP = `clio run [flags] "<task>"

Run one headless main-agent turn. Fleet dispatch is explicit with --agent.

Flags:
  --target <id>             one-run main-agent or dispatch target override
  --model <wireId>          one-run model override
  --thinking <level>        one-run thinking level: off|minimal|low|medium|high|xhigh
  --temperature <N>         one-run sampler override for supported local/OpenAI-compatible runtimes
  --top-p <N>               one-run nucleus sampling override (0..1)
  --top-k <N>               one-run top-k override
  --min-p <N>               one-run min-p override (0..1)
  --presence-penalty <N>    one-run presence penalty override
  --frequency-penalty <N>   one-run frequency penalty override
  --repeat-penalty <N>      one-run repeat penalty override
  --max-context-tokens <N>  one-run context-window override for supported local runtimes
  --kv-cache-mode <mode>    one-run KV-cache mode override: f16|f32|none|false|q8_0|q4_0|q4_1|iq4_nl|q5_0|q5_1
  --json                    stream JSONL events for the main-agent path; dispatch streams events and receipt JSON
  --steer-channel <path>    read live steering lines from a FIFO or appended regular file
  --agent <recipe-id>       dispatch a fleet agent instead of the main agent
  --agent-profile <name>    named fleet profile for dispatch
  --agent-runtime <id>      pick the first fleet profile whose target uses this runtime
  --tool-profile <name>     restrict dispatched-agent tools: minimal-local|science-local|full-agent
  --require <capability>    capability the dispatch target must advertise (repeatable)
  --skill <path>            load one explicit skill for this run, repeatable
  --no-skills               disable skill discovery while still honoring --skill
`;

function hasDispatchOnlyOptions(parsed: RunCliArgs): boolean {
	return (
		parsed.agentProfile !== undefined ||
		parsed.agentRuntime !== undefined ||
		parsed.toolProfile !== undefined ||
		parsed.required.length > 0
	);
}

async function assemblePrompt(parsed: RunCliArgs): Promise<{
	prompt: string;
	images?: ReadonlyArray<ImageContent>;
	workingContextPaths?: ReadonlyArray<string>;
} | null> {
	const messages = parsed.messages.length > 0 ? [parsed.messages.join(" ")] : [];
	const stdinContent = shouldReadPipedStdin(messages) ? await readPipedStdin() : undefined;
	const fileRefs = await readFileArgsAsync(parsed.fileArgs, { cwd: process.cwd(), missing: "error" });
	for (const diagnostic of fileRefs.diagnostics) {
		process.stderr.write(`error: ${diagnostic.message}\n`);
	}
	if (fileRefs.diagnostics.some((diagnostic) => diagnostic.type === "error")) return null;
	const initial = buildInitialMessage({
		messages,
		...(stdinContent !== undefined ? { stdinContent } : {}),
		...(fileRefs.text.length > 0 ? { fileText: fileRefs.text } : {}),
		...(fileRefs.images.length > 0 ? { fileImages: fileRefs.images } : {}),
	});
	if (!initial.initialMessage || initial.initialMessage.trim().length === 0) {
		process.stderr.write("clio run: empty task\n");
		process.stderr.write(USAGE);
		return null;
	}
	return {
		prompt: initial.initialMessage,
		...(initial.initialImages && initial.initialImages.length > 0 ? { images: initial.initialImages } : {}),
		...(fileRefs.referencedPaths.length > 0 ? { workingContextPaths: fileRefs.referencedPaths } : {}),
	};
}

/**
 * Preflight every explicit --skill path. Returns one message per path that
 * yields no usable skill, built from the loader's own diagnostics (missing
 * path, not a skill package, or validation failure such as a missing
 * description). Exported for contracts tests.
 */
export function explicitSkillPathErrors(skillPaths: ReadonlyArray<string>): string[] {
	const errors: string[] = [];
	for (const skillPath of skillPaths) {
		const list = loadSkills({ disableDiscovery: true, explicitSkillPaths: [skillPath] });
		if (list.items.length > 0) continue;
		const detail = list.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
		errors.push(detail.length > 0 ? detail : `explicit skill path loaded no skills: ${skillPath}`);
	}
	return errors;
}

export async function runClioRun(
	args: ReadonlyArray<string>,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> } = {},
): Promise<number> {
	const parsed = parseRunCliArgs(args);
	const previousMaxContextTokens = process.env.CLIO_MAX_CONTEXT_TOKENS;
	const previousKvCacheMode = process.env.CLIO_KV_CACHE_MODE;
	try {
		if (parsed.maxContextTokens !== undefined) {
			process.env.CLIO_MAX_CONTEXT_TOKENS = String(parsed.maxContextTokens);
		}
		if (parsed.kvCacheMode !== undefined) {
			process.env.CLIO_KV_CACHE_MODE = parsed.kvCacheMode;
		}
		if (parsed.help) {
			process.stdout.write(HELP);
			return 0;
		}
		for (const diagnostic of parsed.diagnostics) {
			process.stderr.write(`clio run: ${diagnostic.message}\n`);
		}
		if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.stderr.write(USAGE);
			return 2;
		}
		if (parsed.agentId === undefined && hasDispatchOnlyOptions(parsed)) {
			process.stderr.write("clio run: fleet dispatch flags require --agent <recipe-id>\n");
			process.stderr.write(USAGE);
			return 2;
		}

		const noSkills = options.noSkills === true || parsed.noSkills === true;
		const skillPaths = Array.from(new Set([...(options.skillPaths ?? []), ...parsed.skillPaths]));
		// An explicit --skill path is a contract: a path that is missing or loads
		// no valid skill fails the run before any model invocation instead of
		// silently degrading to whatever skills discovery finds.
		const skillPathErrors = explicitSkillPathErrors(skillPaths);
		if (skillPathErrors.length > 0) {
			for (const message of skillPathErrors) {
				process.stderr.write(`clio run: --skill ${message}\n`);
			}
			return 2;
		}

		const assembled = await assemblePrompt(parsed);
		if (!assembled) return 2;

		if (parsed.agentId === undefined) {
			takeOverStdout();
			try {
				const code = await runClioCommand({
					...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
					...(options.noContextFiles ? { noContextFiles: true } : {}),
					...(noSkills ? { noSkills: true } : {}),
					...(skillPaths.length > 0 ? { skillPaths } : {}),
					headless: {
						prompt: assembled.prompt,
						mode: parsed.json ? "json" : "text",
						...(noSkills ? { noSkills: true } : {}),
						...(skillPaths.length > 0 ? { skillPaths } : {}),
						...(assembled.images && assembled.images.length > 0 ? { images: assembled.images } : {}),
						...(assembled.workingContextPaths && assembled.workingContextPaths.length > 0
							? { workingContextPaths: assembled.workingContextPaths }
							: {}),
						...(parsed.target !== undefined ? { target: parsed.target } : {}),
						...(parsed.model !== undefined ? { model: parsed.model } : {}),
						...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
						...(parsed.sampling !== undefined ? { sampling: parsed.sampling } : {}),
						...(parsed.steerChannel !== undefined ? { steerChannel: parsed.steerChannel } : {}),
					},
				});
				await flushRawStdout();
				return code;
			} finally {
				restoreStdout();
			}
		}

		return await runDispatch(parsed as RunCliArgs & { agentId: string }, assembled.prompt, {
			...options,
			noSkills,
			skillPaths,
		});
	} finally {
		if (previousMaxContextTokens === undefined) delete process.env.CLIO_MAX_CONTEXT_TOKENS;
		else process.env.CLIO_MAX_CONTEXT_TOKENS = previousMaxContextTokens;
		if (previousKvCacheMode === undefined) delete process.env.CLIO_KV_CACHE_MODE;
		else process.env.CLIO_KV_CACHE_MODE = previousKvCacheMode;
	}
}

async function runDispatch(
	parsed: RunCliArgs & { agentId: string },
	task: string,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> },
): Promise<number> {
	if (parsed.toolProfile !== undefined && !isToolProfileName(parsed.toolProfile)) {
		process.stderr.write("clio run: --tool-profile must be one of: minimal-local|science-local|full-agent\n");
		process.stderr.write(USAGE);
		return 2;
	}
	if (parsed.target && parsed.agentProfile) {
		process.stderr.write(
			`clio run: --target ${parsed.target} takes precedence; --agent-profile ${parsed.agentProfile} will be ignored\n`,
		);
	}
	if (parsed.target && parsed.agentRuntime) {
		process.stderr.write(
			`clio run: --target ${parsed.target} takes precedence; --agent-runtime ${parsed.agentRuntime} will be ignored\n`,
		);
	}

	ensureClioState();
	const loaded = await loadDomains([
		ConfigDomainModule,
		ResourcesDomainModule,
		ContextDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: options.noContextFiles === true }),
		AgentsDomainModule,
		MiddlewareDomainModule,
		DispatchDomainModule,
		SessionDomainModule,
		LifecycleDomainModule,
	]);
	const dispatch = loaded.getContract<DispatchContract>("dispatch");
	if (!dispatch) {
		process.stderr.write("dispatch domain unavailable\n");
		await loaded.stop();
		return 1;
	}

	if (options.apiKey) {
		const providers = loaded.getContract<ProvidersContract>("providers");
		if (!providers) {
			process.stderr.write("clio run: --api-key supplied but providers domain unavailable\n");
			await loaded.stop();
			return 1;
		}
		const settings = readSettings();
		const profileTargetId = parsed.agentProfile ? settings.workers?.profiles?.[parsed.agentProfile]?.target : undefined;
		const runtimeByTarget = new Map(settings.targets.map((target) => [target.id, target.runtime] as const));
		const runtimeTargetId = parsed.agentRuntime
			? [settings.workers?.default, ...Object.values(settings.workers?.profiles ?? {})].find(
					(profile) => profile?.target && runtimeByTarget.get(profile.target) === parsed.agentRuntime,
				)?.target
			: undefined;
		const targetId =
			parsed.target ??
			profileTargetId ??
			runtimeTargetId ??
			settings.workers?.default?.target ??
			settings.orchestrator?.target;
		const target = targetId ? providers.getTarget(targetId) : null;
		const runtime = target ? providers.getRuntime(target.runtime) : null;
		if (!target || !runtime) {
			process.stderr.write("clio run: --api-key supplied but no target resolved; pass --target <id>\n");
			await loaded.stop();
			return 2;
		}
		providers.auth.setRuntimeOverrideForTarget(target, runtime, options.apiKey);
	}

	const noSkills = options.noSkills === true || parsed.noSkills === true;
	const skillPaths = Array.from(new Set([...(options.skillPaths ?? []), ...parsed.skillPaths]));

	const dispatchReq: DispatchRequest = {
		agentId: parsed.agentId,
		task,
		requestOrigin: "user",
	};
	if (parsed.agentProfile) dispatchReq.workerProfile = parsed.agentProfile;
	if (parsed.agentRuntime) dispatchReq.workerRuntime = parsed.agentRuntime;
	if (parsed.target) dispatchReq.target = parsed.target;
	if (parsed.model) dispatchReq.model = parsed.model;
	if (parsed.thinking) dispatchReq.thinkingLevel = parsed.thinking;
	if (parsed.toolProfile) dispatchReq.toolProfile = parsed.toolProfile;
	if (parsed.required.length > 0) dispatchReq.requiredCapabilities = parsed.required;
	if (noSkills) dispatchReq.noSkills = true;
	if (skillPaths.length > 0) dispatchReq.skillPaths = skillPaths;
	try {
		const settings = readSettings();
		if (settings.skills?.trustProjectCompatRoots) {
			dispatchReq.trustProjectCompatRoots = true;
		}
	} catch {
		// Ignore configuration read errors
	}

	let memorySection = "";
	try {
		const records = loadMemoryRecordsSync(clioDataDir());
		memorySection = buildMemoryPromptSection(records).section;
	} catch (err) {
		process.stderr.write(
			`clio run: memory load failed: ${err instanceof Error ? err.message : String(err)}; continuing without memory\n`,
		);
	}
	if (memorySection.length > 0) dispatchReq.memorySection = memorySection;

	let cleanupSteer: (() => void) | undefined;
	try {
		const handle = await dispatch.dispatch(dispatchReq);
		if (parsed.steerChannel) {
			cleanupSteer = setupSteerChannel(parsed.steerChannel, (line) => {
				try {
					dispatch.steer(handle.runId, line);
				} catch {
					// Ignore delivery errors (e.g., run already finished)
				}
			});
		}
		const onSignal = (): void => dispatch.abort(handle.runId);
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);

		// Human output is the worker's final answer plus the receipt line. Native
		// workers carry the answer in the last assistant message_end event;
		// acp-delegation runs stream it as text_delta increments instead, so the
		// accumulated deltas serve as the fallback. Raw event names are noise for
		// a human reader and stay --json-only.
		let accumulatedText = "";
		let lastAssistantText = "";
		for await (const event of handle.events) {
			if (parsed.json) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
				continue;
			}
			const e = event as { type?: string; text?: string };
			if (e.type === "text_delta" && typeof e.text === "string") {
				accumulatedText += e.text;
			}
			const assistantText = assistantTextFromEvent(event);
			if (assistantText.length > 0) lastAssistantText = assistantText;
		}

		const receipt = await handle.finalPromise;
		if (cleanupSteer) {
			cleanupSteer();
			cleanupSteer = undefined;
		}
		if (parsed.json) {
			process.stdout.write(`\n${JSON.stringify(receipt, null, 2)}\n`);
		} else {
			const answer = lastAssistantText.length > 0 ? lastAssistantText : accumulatedText.trim();
			if (answer.length > 0) process.stdout.write(`${answer}\n`);
			process.stdout.write(`${formatReceipt(receipt)}\n`);
		}

		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);

		await dispatch.drain();
		await loaded.stop();
		return mapExitCode(receipt);
	} catch (err) {
		if (cleanupSteer) {
			cleanupSteer();
		}
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`clio run failed: ${msg}\n`);
		await loaded.stop();
		if (/target '.+' not found/.test(msg)) return 2;
		if (
			msg.includes("unknown agent recipe") ||
			msg.includes("admission") ||
			msg.includes("capability") ||
			msg.includes("budget")
		)
			return 2;
		return 1;
	}
}

function formatReceipt(r: RunReceipt): string {
	const reasoning =
		typeof r.reasoningTokenCount === "number" && r.reasoningTokenCount > 0 ? ` reasoning=${r.reasoningTokenCount}` : "";
	const failure = r.failureMessage ? ` error=${r.failureMessage}` : "";
	return `receipt: ${r.runId} agent=${r.agentId} exit=${r.exitCode} target=${r.targetId} model=${r.wireModelId} tokens=${r.tokenCount}${reasoning}${failure} start=${r.startedAt} end=${r.endedAt}`;
}

function mapExitCode(r: RunReceipt): number {
	if (r.exitCode === 0) return 0;
	return r.exitCode === 2 ? 2 : 1;
}
