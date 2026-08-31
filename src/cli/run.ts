import { type ClioSettings, readSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { readFileArgsAsync } from "../core/file-references.js";
import { withRunOverrides } from "../core/run-overrides.js";
import { clioDataDir } from "../core/xdg.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { createContextDomainModule } from "../domains/context/runtime.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { agentRoleFactsResolver, requestExecutionRole } from "../domains/dispatch/execution-role.js";
import { createDispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import {
	buildMemoryPromptSection,
	canonicalMemoryRepositoryIdentity,
	loadMemoryRecordsSync,
} from "../domains/memory/index.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { loadSkills, ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { SessionDomainModule } from "../domains/session/index.js";
import type { ImageContent } from "../engine/types.js";
import { assistantTextFromEvent, receiptResponseModelIdObservationLabel } from "../tools/dispatch-event-text.js";
import { isToolProfileName } from "../tools/profiles.js";
import { parseRunCliArgs, type RunCliArgs } from "./args.js";
import { runClioCommand } from "./clio.js";
import { buildInitialMessage, readPipedStdin, shouldReadPipedStdin } from "./initial-message.js";
import { projectDispatchJsonEvent } from "./modes/json-stream.js";
import { flushRawStdout, restoreStdout, takeOverStdout } from "./output-guard.js";
import { setupSteerChannel } from "./steer-channel.js";

const USAGE =
	'usage: clio-coder run [--target <id>] [--model <wireId>] [--thinking <level>] [--autonomy <level>] [--json] [--json-events full|terminal] [--session <id>|--continue] [--agent <recipe-id>] "<task>"\n';

const HELP = `clio-coder run [flags] "<task>"

Run one headless main-agent turn. Fleet dispatch is explicit with --agent.

Flags:
  --target <id>             one-run main-agent or dispatch target override
  --model <wireId>          one-run model override
  --thinking <level>        one-run thinking level: off|minimal|low|medium|high|xhigh|max
  --autonomy <level>        one-run autonomy: read-only|suggest|auto-edit|full-auto
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
  --json-events <mode>      main-agent JSON stream mode: full|terminal; implies --json
  --steer-channel <path>    read live steering lines from a FIFO or appended regular file
  --session <id>            append this turn to an existing session
  --continue                append this turn to the most recent session for this cwd
  --agent <recipe-id>       dispatch a fleet agent instead of the main agent
  --agent-profile <name>    named fleet profile for dispatch
  --agent-runtime <id>      pick the first fleet profile whose target uses this runtime
  --tool-profile <name>     restrict dispatched-agent tools: minimal-local|science-local|full-agent
  --require <capability>    capability the dispatch target must advertise (repeatable)
  --skill <path>            load one explicit skill for this run, repeatable
  --no-skills               disable skill discovery while still honoring --skill

A headless turn starts a fresh session unless --session or --continue names one
to append to. A named session that cannot be resumed fails the run: an answer
written without the history the caller asked for is worse than no answer. The
session id is reported on stderr, and as the "session" event under --json.

There is no operator in a headless run: permission asks are denied, and the
ask_user interview tool is not registered. Skills that interview fall back to
their stated defaults; supply decisions in the task prompt instead.

A turn that ends by writing an artifact (plan/review/report) has no assistant
message after it, because writing the artifact is the answer. Text mode prints
that tool's result line, naming what was written and where; --json carries the
artifact content itself in the event stream.
`;

function hasDispatchOnlyOptions(parsed: RunCliArgs): boolean {
	return (
		parsed.agentProfile !== undefined ||
		parsed.agentRuntime !== undefined ||
		parsed.toolProfile !== undefined ||
		parsed.required.length > 0
	);
}

/**
 * True when an explicit --target override names a target that is not in
 * settings.targets. `readSettings().targets` is the same source the runtime
 * resolver checks (providers.getTarget), so this mirrors its `target-not-found`
 * verdict without booting the providers domain. Unreadable/invalid settings
 * fall through (returns false) so the normal boot path surfaces that error
 * instead of a misleading "target not found".
 */
function explicitTargetMissing(targetId: string): boolean {
	try {
		return !readSettings().targets.some((target) => target.id === targetId);
	} catch {
		return false;
	}
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
		process.stderr.write("clio-coder run: empty task\n");
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

/**
 * The TUI's verdict for a command-shaped token the registry does not own,
 * applied to a headless task. Returns the refusal message, or null when the
 * task is not an unknown command.
 *
 * `parseSlashCommand` is the canonical shape test and the canonical registry
 * walk, so a token that is one word of letters, digits, hyphens, or colons and
 * names no command lands here exactly as it does in the editor. Prose keeps
 * reaching the model: an absolute path such as `/home/user/notes` carries a
 * separator and is not one word, and `\/tmp is full` is the same escape the
 * editor honors.
 *
 * A prompt template claims the token before the refusal does. Only membership
 * is checked, not expansion: a template that exists but refuses (an untrusted
 * project root, an unreadable body) has its own message, which the headless
 * boot path already prints from the expansion itself. Deciding that here would
 * duplicate the trust rules and put two refusals on one token.
 *
 * Both modules are imported lazily. `clio-coder run` reaches the model through
 * a dynamic `bootOrchestrator` import to keep its startup off the interactive
 * and resource module graphs, and a task that does not start with a slash must
 * not pay for either.
 */
export async function unknownSlashCommandRefusal(task: string): Promise<string | null> {
	if (!task.trim().startsWith("/")) return null;
	const { parseSlashCommand } = await import("../interactive/slash-commands.js");
	const command = parseSlashCommand(task);
	if (command.kind !== "unknown-command") return null;
	const { loadPromptTemplates } = await import("../domains/resources/index.js");
	const templates = loadPromptTemplates({ cwd: process.cwd() });
	if (templates.items.some((template) => template.name === command.token)) return null;
	return `/${command.token} is not a command. Type /help for the list.`;
}

export async function runClioRun(
	args: ReadonlyArray<string>,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> } = {},
): Promise<number> {
	const parsed = parseRunCliArgs(args);
	// One-run overrides ride the scoped run-overrides transport (restored on
	// exit) so dispatched worker subprocesses inherit them; see
	// core/run-overrides.ts.
	return withRunOverrides(
		{
			...(parsed.maxContextTokens !== undefined ? { maxContextTokens: parsed.maxContextTokens } : {}),
			...(parsed.kvCacheMode !== undefined ? { kvCacheMode: parsed.kvCacheMode } : {}),
		},
		async () => {
			if (parsed.help) {
				process.stdout.write(HELP);
				return 0;
			}
			for (const diagnostic of parsed.diagnostics) {
				process.stderr.write(`clio-coder run: ${diagnostic.message}\n`);
			}
			if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
				process.stderr.write(USAGE);
				return 2;
			}
			if (parsed.agentId === undefined && hasDispatchOnlyOptions(parsed)) {
				process.stderr.write("clio-coder run: fleet dispatch flags require --agent <recipe-id>\n");
				process.stderr.write(USAGE);
				return 2;
			}
			if (parsed.sessionId !== undefined && parsed.continueSession) {
				process.stderr.write("clio-coder run: --session and --continue name different sessions; pass one\n");
				process.stderr.write(USAGE);
				return 2;
			}
			// A dispatched agent runs in its own worker with its own transcript,
			// so there is no main-agent session for it to continue.
			if ((parsed.sessionId !== undefined || parsed.continueSession) && parsed.agentId !== undefined) {
				process.stderr.write("clio-coder run: --session and --continue apply to the main agent, not --agent dispatch\n");
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
					process.stderr.write(`clio-coder run: --skill ${message}\n`);
				}
				return 2;
			}

			const assembled = await assemblePrompt(parsed);
			if (!assembled) return 2;

			if (parsed.agentId === undefined) {
				// A mistyped slash command is a usage error, not a task. Refusing it
				// here keeps it from booting a session and spending a model turn on a
				// command that was never run, which is what the TUI has always done
				// and what docs/extensions-and-sharing.md documents for both surfaces.
				const slashRefusal = await unknownSlashCommandRefusal(assembled.prompt);
				if (slashRefusal !== null) {
					process.stderr.write(`clio-coder run: ${slashRefusal}\n`);
					return 2;
				}
				// An explicit --target override is a one-run target; a missing id is an
				// operator config error, not an assistant response. Reject it before the
				// headless turn so the resolver diagnostic never streams to stdout as a
				// message_end/agent_end assistant turn.
				if (parsed.target !== undefined && explicitTargetMissing(parsed.target)) {
					process.stderr.write(`clio-coder run: target '${parsed.target}' not found in settings.targets\n`);
					return 2;
				}
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
							jsonEvents: parsed.jsonEvents,
							...(noSkills ? { noSkills: true } : {}),
							...(skillPaths.length > 0 ? { skillPaths } : {}),
							...(assembled.images && assembled.images.length > 0 ? { images: assembled.images } : {}),
							...(assembled.workingContextPaths && assembled.workingContextPaths.length > 0
								? { workingContextPaths: assembled.workingContextPaths }
								: {}),
							...(parsed.target !== undefined ? { target: parsed.target } : {}),
							...(parsed.model !== undefined ? { model: parsed.model } : {}),
							...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
							...(parsed.autonomy !== undefined ? { autonomy: parsed.autonomy } : {}),
							...(parsed.sampling !== undefined ? { sampling: parsed.sampling } : {}),
							...(parsed.steerChannel !== undefined ? { steerChannel: parsed.steerChannel } : {}),
							...(parsed.sessionId !== undefined
								? { resumeSession: { kind: "id" as const, id: parsed.sessionId } }
								: parsed.continueSession
									? { resumeSession: { kind: "latest" as const } }
									: {}),
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
		},
	);
}

async function runDispatch(
	parsed: RunCliArgs & { agentId: string },
	task: string,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> },
): Promise<number> {
	if (parsed.toolProfile !== undefined && !isToolProfileName(parsed.toolProfile)) {
		process.stderr.write("clio-coder run: --tool-profile must be one of: minimal-local|science-local|full-agent\n");
		process.stderr.write(USAGE);
		return 2;
	}
	if (parsed.target && parsed.agentProfile) {
		process.stderr.write(
			`clio-coder run: --target ${parsed.target} takes precedence; --agent-profile ${parsed.agentProfile} will be ignored\n`,
		);
	}
	if (parsed.target && parsed.agentRuntime) {
		process.stderr.write(
			`clio-coder run: --target ${parsed.target} takes precedence; --agent-runtime ${parsed.agentRuntime} will be ignored\n`,
		);
	}

	ensureClioState();
	let effectiveSettings: Readonly<ClioSettings> | undefined;
	const loaded = await loadDomains([
		ConfigDomainModule,
		ResourcesDomainModule,
		createContextDomainModule({ noContextFiles: options.noContextFiles === true }),
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: options.noContextFiles === true }),
		AgentsDomainModule,
		MiddlewareDomainModule,
		SessionDomainModule,
		// Observability subscribes to the dispatch terminal events so a headless
		// run auto-builds its forensic evidence bundle and sidecar index, the same
		// as an interactive session. It depends only on providers + session, both
		// loaded above.
		ObservabilityDomainModule,
		SchedulingDomainModule,
		createDispatchDomainModule({
			getSettings: () => effectiveSettings,
			autonomyOverride: parsed.autonomy !== undefined,
		}),
		LifecycleDomainModule,
	]);
	const config = loaded.getContract<ConfigContract>("config");
	const baseSettings = config?.get() ?? readSettings();
	effectiveSettings =
		parsed.autonomy === undefined ? baseSettings : { ...structuredClone(baseSettings), autonomy: parsed.autonomy };
	const dispatch = loaded.getContract<DispatchContract>("dispatch");
	if (!dispatch) {
		process.stderr.write("dispatch domain unavailable\n");
		await loaded.stop();
		return 1;
	}

	if (options.apiKey) {
		const providers = loaded.getContract<ProvidersContract>("providers");
		if (!providers) {
			process.stderr.write("clio-coder run: --api-key supplied but providers domain unavailable\n");
			await loaded.stop();
			return 1;
		}
		const settings = effectiveSettings;
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
			process.stderr.write("clio-coder run: --api-key supplied but no target resolved; pass --target <id>\n");
			await loaded.stop();
			return 2;
		}
		providers.auth.setRuntimeOverrideForTarget(target, runtime, options.apiKey);
	}

	const noSkills = options.noSkills === true || parsed.noSkills === true;
	const skillPaths = Array.from(new Set([...(options.skillPaths ?? []), ...parsed.skillPaths]));

	const runAgents = loaded.getContract<AgentsContract>("agents");
	const dispatchReq: DispatchRequest = {
		agentId: parsed.agentId,
		executionRole: requestExecutionRole({
			agentId: parsed.agentId,
			...(runAgents ? { resolveFacts: agentRoleFactsResolver((id: string) => runAgents.getSpec(id)) } : {}),
		}),
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
		const settings = effectiveSettings;
		if (settings.skills?.trustProjectCompatRoots) {
			dispatchReq.trustProjectCompatRoots = true;
		}
	} catch {
		// Ignore configuration read errors
	}

	let memorySection = "";
	try {
		const records = loadMemoryRecordsSync(clioDataDir());
		const boundProfileName = parsed.agentProfile ?? effectiveSettings.workers.agentBindings[parsed.agentId];
		const boundProfile = boundProfileName ? effectiveSettings.workers.profiles[boundProfileName] : undefined;
		const configuredRuntime = (targetId: string | null | undefined): string | undefined =>
			effectiveSettings.targets.find((target) => target.id === targetId)?.runtime;
		const profileRuntimeId = configuredRuntime(boundProfile?.target);
		// The memory section is compiled before fleet routing settles. Admit a
		// runtime-scoped record only when every permitted initial and fallback
		// route is constrained to the same runtime.
		const memoryRuntimeId =
			parsed.target !== undefined
				? configuredRuntime(parsed.target)
				: boundProfileName !== undefined
					? parsed.agentRuntime === profileRuntimeId
						? profileRuntimeId
						: undefined
					: parsed.agentRuntime;
		memorySection = buildMemoryPromptSection(records, {
			scopes: ["global", "repo", "runtime", "agent"],
			activeRepository: canonicalMemoryRepositoryIdentity(process.cwd()),
			activeRuntime: memoryRuntimeId === undefined ? null : { kind: "runtime", key: memoryRuntimeId },
			activeAgent: { kind: "agent", key: parsed.agentId },
		}).section;
	} catch (err) {
		process.stderr.write(
			`clio-coder run: memory load failed: ${err instanceof Error ? err.message : String(err)}; continuing without memory\n`,
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
				process.stdout.write(`${JSON.stringify(projectDispatchJsonEvent(event))}\n`);
				continue;
			}
			const e = event as { type?: string; text?: string };
			// A failover hop supersedes the previous attempt: its text is not the
			// assignment's answer, and the terminal receipt describes the last one.
			if (e.type === "attempt_start") {
				accumulatedText = "";
				lastAssistantText = "";
				continue;
			}
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
		process.stderr.write(`clio-coder run failed: ${msg}\n`);
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
	const responseModelIdObservation = receiptResponseModelIdObservationLabel(r);
	return `receipt: ${r.runId} agent=${r.agentId} exit=${r.exitCode} target=${r.targetId} requested_model_id=${r.wireModelId}${responseModelIdObservation ? ` ${responseModelIdObservation}` : ""} tokens=${r.tokenCount}${reasoning}${failure} start=${r.startedAt} end=${r.endedAt}`;
}

function mapExitCode(r: RunReceipt): number {
	if (r.exitCode === 0) return 0;
	return r.exitCode === 2 ? 2 : 1;
}
