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
import { isToolProfileName } from "../tools/profiles.js";
import { parseRunCliArgs, type RunCliArgs } from "./args.js";
import { runClioCommand } from "./clio.js";
import { buildInitialMessage, readPipedStdin, shouldReadPipedStdin } from "./initial-message.js";
import { flushRawStdout, restoreStdout, takeOverStdout } from "./output-guard.js";

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
  --json                    stream JSONL events for the main-agent path; dispatch streams events and receipt JSON
  --agent <recipe-id>       dispatch a fleet agent instead of the main agent
  --agent-profile <name>    named fleet profile for dispatch
  --agent-runtime <id>      pick the first fleet profile whose endpoint uses this runtime
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

async function assemblePrompt(
	parsed: RunCliArgs,
): Promise<{ prompt: string; images?: ReadonlyArray<ImageContent> } | null> {
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
					...(parsed.target !== undefined ? { target: parsed.target } : {}),
					...(parsed.model !== undefined ? { model: parsed.model } : {}),
					...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
					...(parsed.sampling !== undefined ? { sampling: parsed.sampling } : {}),
				},
			});
			await flushRawStdout();
			return code;
		} finally {
			restoreStdout();
		}
	}

	return runDispatch(parsed as RunCliArgs & { agentId: string }, assembled.prompt, {
		...options,
		noSkills,
		skillPaths,
	});
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
		const profileEndpointId = parsed.agentProfile
			? settings.workers?.profiles?.[parsed.agentProfile]?.endpoint
			: undefined;
		const runtimeByEndpoint = new Map(settings.endpoints.map((endpoint) => [endpoint.id, endpoint.runtime] as const));
		const runtimeEndpointId = parsed.agentRuntime
			? [settings.workers?.default, ...Object.values(settings.workers?.profiles ?? {})].find(
					(profile) => profile?.endpoint && runtimeByEndpoint.get(profile.endpoint) === parsed.agentRuntime,
				)?.endpoint
			: undefined;
		const targetEndpointId =
			parsed.target ??
			profileEndpointId ??
			runtimeEndpointId ??
			settings.workers?.default?.endpoint ??
			settings.orchestrator?.endpoint;
		const endpoint = targetEndpointId ? providers.getEndpoint(targetEndpointId) : null;
		const runtime = endpoint ? providers.getRuntime(endpoint.runtime) : null;
		if (!endpoint || !runtime) {
			process.stderr.write("clio run: --api-key supplied but no target resolved; pass --target <id>\n");
			await loaded.stop();
			return 2;
		}
		providers.auth.setRuntimeOverrideForTarget(endpoint, runtime, options.apiKey);
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
	if (parsed.target) dispatchReq.endpoint = parsed.target;
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

	try {
		const handle = await dispatch.dispatch(dispatchReq);
		const onSignal = (): void => dispatch.abort(handle.runId);
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);

		let accumulatedText = "";
		for await (const event of handle.events) {
			if (parsed.json) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
				continue;
			}
			const e = event as { type?: string; text?: string };
			if (e.type === "text_delta" && typeof e.text === "string") {
				accumulatedText += e.text;
			}
			if (e.type && e.type !== "heartbeat" && e.type !== "text_delta") {
				process.stderr.write(`${e.type}\n`);
			}
		}

		if (!parsed.json) {
			process.stdout.write(accumulatedText);
		}

		const receipt = await handle.finalPromise;
		process.stdout.write(`\n${parsed.json ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt)}\n`);

		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);

		await dispatch.drain();
		await loaded.stop();
		return mapExitCode(receipt);
	} catch (err) {
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
	return `receipt: ${r.runId} agent=${r.agentId} exit=${r.exitCode} target=${r.endpointId} model=${r.wireModelId} tokens=${r.tokenCount}${reasoning}${failure} start=${r.startedAt} end=${r.endedAt}`;
}

function mapExitCode(r: RunReceipt): number {
	if (r.exitCode === 0) return 0;
	return r.exitCode === 2 ? 2 : 1;
}
