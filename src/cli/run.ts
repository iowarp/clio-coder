import { realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { type ClioSettings, readSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { FileReferenceError, readFileArgsAsync } from "../core/file-references.js";
import { setAutonomousCommitProcess } from "../core/git-commit-attribution.js";
import { readClioVersion } from "../core/package-root.js";
import { requirePricedRefusal, withRunOverrides } from "../core/run-overrides.js";
import { readStrictLayeredSettings, settingsSourceFor } from "../core/settings-layers.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { clioDataDir } from "../core/xdg.js";
import { autonomyCeilingRefusal, yoloRootRefusal } from "../core/yolo-host.js";
import type { isUserOriginAudienceRefusal } from "../domains/agents/spec.js";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import { defaultRoutingIntent } from "../domains/dispatch/routing-intent.js";
import type { RunResult } from "../domains/dispatch/types.js";
import { runtimeNotRegistered } from "../domains/providers/retired-runtimes.js";
import { redactUrlCredentials } from "../domains/safety/redaction.js";
import { SESSION_COST_CEILING_EXIT_CODE, SessionCostCeilingError } from "../domains/scheduling/budget.js";
import type { ImageContent } from "../engine/types.js";
import type { HeadlessRunDeadline } from "../entry/boot-options.js";
import { isToolProfileName } from "../tools/profiles.js";
import { type RunCliArgs, requestedRunLimits, sandboxRequiredRefusal } from "./args.js";
import { classifyDefaultTarget } from "./default-target.js";
import { buildInitialMessage, readPipedStdin } from "./initial-message.js";
import { writeFrame } from "./modes/jsonl.js";
import type { RunJsonAdmissionRefusedFrame, RunJsonAgentFrame } from "./modes/run-json-schema.js";
import { RUN_JSON_SCHEMA_VERSION } from "./modes/run-json-schema.js";
import { flushRawStdout, handleRunStdoutErrors, restoreStdout, takeOverStdout } from "./output-guard.js";
import { loadScriptedAnswers } from "./run-answers.js";
import {
	noteStructuredV2,
	noteTextAnswer,
	requestRunTextSummary,
	startRunOutput,
	withRunFailureReporting,
	withRunResultV2,
	writeRunDiagnostic,
} from "./run-failure.js";
import { RUN_HELP as HELP, RUN_USAGE as USAGE } from "./run-help.js";
import { setupSteerChannel } from "./steer-channel.js";
import { parseRunArgsWithTaskFile } from "./task-envelope.js";

/**
 * Enter the directory `--cwd` names, the way `acp --cwd` does. Everything a run
 * resolves against the working directory reads `process.cwd()`: layered
 * settings, context files, skill discovery, `@file` references, the session
 * ledger, and every tool path (`src/tools/path-utils.ts`). So the chdir happens
 * before any of that, and the path is canonicalized first so the run ledger and
 * every later comparison name the same physical directory. Returns null on
 * success, or the resolved path that could not be entered.
 */
function enterRunCwd(value: string): string | null {
	const resolved = path.resolve(value);
	try {
		process.chdir(realpathSync(resolved));
		return null;
	} catch {
		return resolved;
	}
}

/** timeout(1)'s status, and the one code-step already uses for a timeout. */
const RUN_TIMEOUT_EXIT_CODE = 124;

/**
 * Arm `--timeout`. On expiry the timer starts the process's coordinated
 * shutdown, the path a SIGTERM takes, so the headless drain hook aborts the
 * turn, bash-exec signals any running tool's process group, and the run is
 * recorded before exit. A shutdown that is already under way (a signal, or the
 * run settling on its own) owns the exit code, so the timer then does nothing.
 * The timer is unref'd: it bounds the run and never keeps the process alive.
 */
function armRunTimeout(seconds: number): HeadlessRunDeadline {
	const coordinator = getTerminationCoordinator();
	let expired = false;
	// The budget counts from process start (performance.now() is measured from the time origin), so module
	// load and boot spend it too and `--timeout N` bounds the caller's wall time.
	const endsAt = seconds * 1000;
	const timer = setTimeout(
		() => {
			if (coordinator.getPhase() !== "idle") return;
			expired = true;
			writeRunDiagnostic(`clio-coder run: timed out after ${seconds}s (--timeout)\n`);
			void coordinator.shutdown(RUN_TIMEOUT_EXIT_CODE);
		},
		Math.max(0, Math.ceil(endsAt - performance.now())),
	);
	timer.unref();
	return {
		seconds,
		expired: () => expired,
		settle: () => clearTimeout(timer),
		remainingMs: () => Math.max(0, endsAt - performance.now()),
	};
}

function hasDispatchOnlyOptions(parsed: RunCliArgs): boolean {
	return (
		parsed.record === true ||
		parsed.agentProfile !== undefined ||
		parsed.agentRuntime !== undefined ||
		parsed.toolProfile !== undefined ||
		parsed.required.length > 0
	);
}

/**
 * True when an explicit --target override names a target that is not in
 * effective settings.targets. Include project overlays just as the runtime
 * resolver does (providers.getTarget), so this mirrors its `target-not-found`
 * verdict without booting the providers domain. Unreadable/invalid settings
 * fall through (returns false) so the normal boot path surfaces that error
 * instead of a misleading "target not found".
 */
export function explicitTargetMissing(targetId: string): boolean {
	try {
		return !readStrictLayeredSettings(process.cwd()).settings.targets.some((target) => target.id === targetId);
	} catch {
		return false;
	}
}

/**
 * A home with no saved chat route borrows the one usable credentialed route for this run only (S-74),
 * in memory, so a CI job with one key in its environment runs without a setup step. Null leaves the
 * run to its established path; a number is the exit code for a choice the operator has to make.
 */
export async function borrowHeadlessRoute(
	targetId: string | undefined,
	model: string | undefined,
): Promise<{ settings: ClioSettings; notice: string } | number | null> {
	let settings: ClioSettings;
	let projectTargets: boolean;
	try {
		const layered = readStrictLayeredSettings(process.cwd());
		settings = layered.settings;
		// `targets` replaces wholesale across layers, so a project origin means every saved target is the project's.
		projectTargets = settingsSourceFor(layered.sources, "targets").startsWith("project");
	} catch {
		// The boot path reports unreadable settings with its own diagnostic.
		return null;
	}
	// A project that chose its targets chose the route too; borrowing anything else would override that choice.
	if (projectTargets) return null;
	if (classifyDefaultTarget(settings).kind !== "no-target") return null;
	if (targetId !== undefined && settings.targets.some((target) => target.id === targetId)) return null;
	const { headlessChatRoute } = await import("./detect-chat-routes.js");
	const found = await headlessChatRoute(settings, targetId, {
		...(model !== undefined ? { model } : {}),
		projectTargets,
	});
	if (found.kind === "none") {
		// The memory refusal is the whole answer; booting on would add the generic no-target line after it.
		if (found.reservedForMemory !== undefined && model === undefined) {
			writeRunDiagnostic(
				`clio-coder run: the only usable saved target, ${found.reservedForMemory}, is reserved for memory (context.memory.target); add a chat target or pass --target <id>\n`,
			);
			return 2;
		}
		return null;
	}
	if (found.kind === "several") {
		const list = found.routes.map((route) => `${route.target.id} from ${route.source}`).join(", ");
		writeRunDiagnostic(`clio-coder run: several routes are usable (${list}); choose one with --target <id>\n`);
		return 2;
	}
	if (found.kind === "needs-model") {
		const { route } = found;
		writeRunDiagnostic(
			`clio-coder run: using ${route.target.id} from ${route.source} needs --model <id> (no default model for ${route.runtime.id})\n`,
		);
		return 2;
	}
	const { route } = found;
	return {
		settings: found.settings,
		notice: `no chat route is saved; using ${route.target.id} / ${route.model} from ${route.source} for this run`,
	};
}

/** Exit code for a run interrupted before its first request, by the 128+SIGINT convention. */
const RUN_INTERRUPTED_EXIT = 130;

/**
 * A dispatch without declared intent infers its path scope from the task text,
 * and that inference refuses any absolute path token, so `run --agent ... @file`
 * failed on the attachment's own `<file name="/abs/...">` opener. An attachment
 * inside the workspace is named by its workspace-relative path instead; one
 * outside keeps its absolute name and is refused as before.
 */
function workspaceRelativeFileNames(text: string, referencedPaths: ReadonlyArray<string>, cwd: string): string {
	let named = text;
	for (const absolute of new Set(referencedPaths)) {
		const local = path.relative(cwd, absolute);
		if (local === "" || local === ".." || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) continue;
		named = named.replaceAll(`<file name="${absolute}">`, `<file name="${local.split(path.sep).join("/")}">`);
	}
	return named;
}

async function assemblePrompt(parsed: RunCliArgs): Promise<
	| {
			prompt: string;
			images?: ReadonlyArray<ImageContent>;
			workingContextPaths?: ReadonlyArray<string>;
	  }
	| number
> {
	const messages = parsed.messages.length > 0 ? [parsed.messages.join(" ")] : [];
	if (parsed.stdin === true && process.stdin.isTTY) {
		writeRunDiagnostic("clio-coder run: `-` reads the task from stdin, but stdin is a terminal\n");
		process.stderr.write(USAGE);
		return 2;
	}
	// SPEC 6.2 (maintainer ruling of 2026-11-20): stdin is read only for a bare `-`, never implicitly and with no
	// wait; a --task-file run never reads it for task text, since the envelope carries the task.
	const stdinContent = parsed.taskFile === undefined && parsed.stdin === true ? await readPipedStdin() : undefined;
	// Boot has not armed the termination coordinator yet, so without this listener
	// SIGINT killed the process by default while a PDF extraction ran on.
	const interrupt = new AbortController();
	const onInterrupt = (): void => interrupt.abort();
	process.on("SIGINT", onInterrupt);
	let fileRefs: Awaited<ReturnType<typeof readFileArgsAsync>>;
	try {
		fileRefs = await readFileArgsAsync(parsed.fileArgs, {
			cwd: process.cwd(),
			missing: "error",
			signal: interrupt.signal,
		});
	} catch (err) {
		if (!interrupt.signal.aborted) throw err;
		writeRunDiagnostic("clio-coder run: interrupted while reading file attachments; nothing was sent\n");
		return RUN_INTERRUPTED_EXIT;
	} finally {
		process.off("SIGINT", onInterrupt);
	}
	// A SIGINT that landed after the last read still counts; the operator asked for nothing to be sent.
	if (interrupt.signal.aborted) {
		writeRunDiagnostic("clio-coder run: interrupted while reading file attachments; nothing was sent\n");
		return RUN_INTERRUPTED_EXIT;
	}
	for (const diagnostic of fileRefs.diagnostics) {
		writeRunDiagnostic(`${diagnostic.type}: ${diagnostic.message}\n`);
	}
	if (fileRefs.diagnostics.some((diagnostic) => diagnostic.type === "error")) return 2;
	const fileText =
		parsed.agentId === undefined
			? fileRefs.text
			: workspaceRelativeFileNames(fileRefs.text, fileRefs.referencedPaths, process.cwd());
	const initial = buildInitialMessage({
		messages,
		...(stdinContent !== undefined ? { stdinContent } : {}),
		...(fileText.length > 0 ? { fileText } : {}),
		...(fileRefs.images.length > 0 ? { fileImages: fileRefs.images } : {}),
	});
	if (!initial.initialMessage || initial.initialMessage.trim().length === 0) {
		writeRunDiagnostic('clio-coder run: empty task; give it as text (run "<task>") or pass - to read it from stdin\n');
		process.stderr.write(USAGE);
		return 2;
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
async function explicitSkillPathErrors(skillPaths: ReadonlyArray<string>): Promise<string[]> {
	const errors: string[] = [];
	// The skill loader's graph loads only when a --skill path is given.
	if (skillPaths.length === 0) return errors;
	const { loadSkills } = await import("../domains/resources/index.js");
	for (const skillPath of skillPaths) {
		const list = loadSkills({ disableDiscovery: true, explicitSkillPaths: [skillPath] });
		if (list.items.length > 0) continue;
		const detail = list.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
		errors.push(detail.length > 0 ? detail : `explicit skill path loaded no skills: ${skillPath}`);
	}
	return errors;
}

/**
 * Refuse commands the headless prompt path cannot execute. Skill invocations
 * and prompt templates have production expansion paths; interactive commands
 * do not, so accepting them would send their literal text to the model.
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
 * duplicate the trust rules and put two refusals on one token. A display-only
 * template is the one expansion decided here, because it needs no boot at all.
 *
 * Both modules are imported lazily, so a task that does not start with a slash
 * pays for neither. The laziness is a startup-cost choice and nothing more: for
 * bundle partitioning a dynamic import is worse than a static one, because a
 * dynamically imported module becomes a chunk split point by itself. What keeps
 * this edge safe is the other end. `slash-commands.ts` is a declared CLI seam
 * whose own imports stay off the interactive render graph, so reaching it does
 * not make this file a second reacher of the chunk the instant shell's Stage 0
 * closure sits on. Boundaries rule6 in `tests/boundaries/check-boundaries.ts`
 * holds both halves of that.
 */
type HeadlessSlashPreflight = { refusal: string } | { display: string } | null;

async function headlessSlashPreflight(
	task: string,
	skillOptions: { disableDiscovery: boolean; explicitSkillPaths: ReadonlyArray<string> },
): Promise<HeadlessSlashPreflight> {
	if (!task.trim().startsWith("/")) return null;
	const { parseSlashCommand } = await import("../session-control/slash-commands.js");
	const command = parseSlashCommand(task);
	if (command.kind === "skill-invocation") {
		const { expandPromptTemplateInput, loadPromptTemplates, loadSkills, parsePendingSkillRequests } = await import(
			"../domains/resources/index.js"
		);
		const skillRequest = parsePendingSkillRequests(task, loadSkills({ cwd: process.cwd(), ...skillOptions }), {
			cwd: process.cwd(),
		});
		const expansion = expandPromptTemplateInput(skillRequest.text, loadPromptTemplates({ cwd: process.cwd() }));
		if (expansion.expanded === false && expansion.display) return { display: expansion.display.text };
		return null;
	}
	if (command.kind === "unknown" || command.kind === "empty") return null;
	if (command.kind !== "unknown-command") {
		return {
			refusal:
				"interactive commands are not supported by clio-coder run; use interactive chat or the corresponding CLI command",
		};
	}
	const { expandPromptTemplateInput, loadPromptTemplates } = await import("../domains/resources/index.js");
	const templates = loadPromptTemplates({ cwd: process.cwd() });
	if (!templates.items.some((template) => template.name === command.token)) {
		return { refusal: `/${command.token} is not a command. Type /help for the list.` };
	}
	// A display-only template is for the operator, so it is answered here and
	// costs no boot: no provider, no session, no model. Everything else, the
	// refusals included, stays with the boot path as described above.
	const expansion = expandPromptTemplateInput(task, templates);
	if (expansion.expanded === false && expansion.display) return { display: expansion.display.text };
	return null;
}

export async function runClioRun(
	args: ReadonlyArray<string>,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> } = {},
): Promise<number> {
	const parsed = await parseRunArgsWithTaskFile(args);
	const coordinator = getTerminationCoordinator();
	handleRunStdoutErrors((code) => coordinator.shutdown(code));
	// Nobody attends a headless run, so its commits are autonomous (integrations.git.commitAuthor).
	setAutonomousCommitProcess(true);
	const v2Format =
		parsed.outputFormat === "json" || parsed.outputFormat === "stream-json" ? parsed.outputFormat : undefined;
	if (v2Format !== undefined) {
		// Schema v2 runs the JSON machinery as a full stream and reframes it at the writer (run-failure.ts).
		parsed.json = true;
	} else if (parsed.outputFormat === "text" && parsed.agentId === undefined) {
		requestRunTextSummary();
	}
	const execute = async (): Promise<number> => {
		try {
			return await executeRunCommand(parsed, options);
		} catch (error) {
			if (!(error instanceof FileReferenceError)) throw error;
			writeRunDiagnostic(`${error.message}\n`);
			return 2;
		}
	};
	if (v2Format !== undefined) {
		return withRunResultV2(
			{
				format: v2Format,
				mode: parsed.agentId !== undefined ? "agent" : "main",
				...(parsed.agentId !== undefined ? { agentId: parsed.agentId } : {}),
				verify: parsed.verify,
				...(parsed.outputLastMessage !== undefined ? { outputLastMessage: parsed.outputLastMessage } : {}),
				...(parsed.steerChannel !== undefined ? { steerChannel: parsed.steerChannel } : {}),
				...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
				...(parsed.timeoutSeconds !== undefined ? { timeoutSeconds: parsed.timeoutSeconds } : {}),
				limits: requestedRunLimits(parsed),
			},
			execute,
		);
	}
	// Text output: the v2 writer is the only JSON writer, so this wrapper adds only text mode's `-o`.
	return withRunFailureReporting(
		execute,
		parsed.outputLastMessage !== undefined
			? { path: parsed.outputLastMessage, ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}) }
			: undefined,
	);
}

async function executeRunCommand(
	parsed: RunCliArgs,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> },
): Promise<number> {
	// One-run overrides ride the scoped run-overrides transport (restored on
	// exit) so dispatched worker subprocesses inherit them; see
	// core/run-overrides.ts. The main agent applies its sampling flags per turn
	// (cli/modes/print.ts), so only `--agent` carries them here, where the
	// worker is the only reader.
	return withRunOverrides(
		{
			...(parsed.maxContextTokens !== undefined ? { maxContextTokens: parsed.maxContextTokens } : {}),
			...(parsed.agentId !== undefined && parsed.sampling !== undefined ? { sampling: { ...parsed.sampling } } : {}),
			// Tighten-only; workers inherit it with the rest of the transport.
			...(parsed.sandboxRequired === true ? { sandbox: "required" as const } : {}),
			...(parsed.requirePriced === true ? { requirePriced: true as const } : {}),
		},
		async () => {
			if (parsed.help) {
				(parsed.json ? process.stderr : process.stdout).write(HELP);
				return 0;
			}
			for (const diagnostic of parsed.diagnostics) {
				writeRunDiagnostic(`clio-coder run: ${diagnostic.message}\n`);
			}
			if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
				process.stderr.write(USAGE);
				return 2;
			}
			if (parsed.agentId === undefined && hasDispatchOnlyOptions(parsed)) {
				writeRunDiagnostic("clio-coder run: fleet dispatch flags require --agent <recipe-id>\n");
				process.stderr.write(USAGE);
				return 2;
			}
			if (parsed.sandboxRequired === true) {
				// Decided before boot: a required sandbox the host lacks is a usage error, not a run that refuses every command.
				const { sandboxAvailability } = await import("../core/sandbox/availability.js");
				const refusal = sandboxRequiredRefusal(sandboxAvailability());
				if (refusal !== undefined) {
					writeRunDiagnostic(`clio-coder run: ${refusal}\n`);
					return 2;
				}
			}
			// Without --agent, --read-only is the main agent's enforced ceiling,
			// carried in the task scope so every continuation keeps it.
			if (parsed.readOnly && parsed.agentId === undefined) parsed.constraints = { ...parsed.constraints, readOnly: true };
			// The per-run caps ride the task scope too, so a later turn of the run still counts.
			if ((parsed.maxRequests !== undefined || parsed.maxToolCalls !== undefined) && parsed.agentId === undefined)
				parsed.constraints = {
					...parsed.constraints,
					runCaps: {
						...(parsed.maxRequests !== undefined ? { maxRequests: parsed.maxRequests } : {}),
						...(parsed.maxToolCalls !== undefined ? { maxToolCalls: parsed.maxToolCalls } : {}),
					},
				};
			if (parsed.constraints && parsed.agentId !== undefined) {
				writeRunDiagnostic(
					"clio-coder run: --turn-mode, --allow-tools, --delegate-tools, and --no-delegate apply to the main-agent task\n",
				);
				return 2;
			}
			if (parsed.sessionId !== undefined && parsed.continueSession) {
				writeRunDiagnostic("clio-coder run: --resume and --continue name different sessions; pass one\n");
				process.stderr.write(USAGE);
				return 2;
			}
			// A dispatched agent runs in its own worker with its own transcript,
			// so there is no main-agent session for it to continue.
			if ((parsed.sessionId !== undefined || parsed.continueSession) && parsed.agentId !== undefined) {
				writeRunDiagnostic(
					"clio-coder run: --resume, --continue, --fork and --name apply to the main agent; a worker has its own transcript\n",
				);
				process.stderr.write(USAGE);
				return 2;
			}
			// A worker's run settles inside the dispatch domain, where a
			// failed outcome also feeds retry policy, so the no-op verdict stays a
			// main-agent contract rather than a flag --agent would silently ignore.
			if (parsed.failOnNoop && parsed.agentId !== undefined) {
				writeRunDiagnostic("clio-coder run: --fail-on-noop applies to the main agent, not --agent dispatch\n");
				process.stderr.write(USAGE);
				return 2;
			}
			if (parsed.verify.length > 0 && parsed.agentId !== undefined) {
				writeRunDiagnostic("clio-coder run: --verify applies to the main agent, not --agent dispatch\n");
				process.stderr.write(USAGE);
				return 2;
			}
			if (parsed.answersFile !== undefined && parsed.agentId !== undefined) {
				writeRunDiagnostic("clio-coder run: --answers applies to the main agent, not --agent dispatch\n");
				process.stderr.write(USAGE);
				return 2;
			}
			// Yolo as root outside a container is refused before boot (#407), as is
			// yolo above the autonomy ceiling of the session that started this run.
			if (parsed.autonomy === "yolo") {
				const refusal = yoloRootRefusal() ?? autonomyCeilingRefusal();
				if (refusal !== null) {
					writeRunDiagnostic(`clio-coder run: ${refusal}\n`);
					return 2;
				}
			}
			// Armed before anything that can block (piped stdin, boot, the
			// provider), so the limit covers the whole run. Every return below
			// settles it: the CLI sets process.exitCode and lets the event loop
			// drain, so a timer left armed behind a usage error and any lingering
			// handle would fire shutdown(124) over that error's exit 2.
			const deadline = parsed.timeoutSeconds === undefined ? undefined : armRunTimeout(parsed.timeoutSeconds);
			try {
				if (parsed.cwd !== undefined) {
					const unusable = enterRunCwd(parsed.cwd);
					if (unusable !== null) {
						writeRunDiagnostic(`clio-coder run: --cwd is not a directory this process can enter: ${unusable}\n`);
						return 2;
					}
				}

				const noSkills = options.noSkills === true || parsed.noSkills === true;
				const skillPaths = Array.from(new Set([...(options.skillPaths ?? []), ...parsed.skillPaths]));
				// An explicit --skill path is a contract: a path that is missing or loads
				// no valid skill fails the run before any model invocation instead of
				// silently degrading to whatever skills discovery finds.
				const skillPathErrors = await explicitSkillPathErrors(skillPaths);
				if (skillPathErrors.length > 0) {
					for (const message of skillPathErrors) {
						writeRunDiagnostic(`clio-coder run: --skill ${message}\n`);
					}
					return 2;
				}

				// Read after --cwd, so a relative path names a file in the run's directory, and before any model call.
				const answers = parsed.answersFile === undefined ? undefined : loadScriptedAnswers(parsed.answersFile);
				if (answers !== undefined && "error" in answers) {
					writeRunDiagnostic(`clio-coder run: ${answers.error}\n`);
					return 2;
				}

				// SPEC 6.8: the schema is read after --cwd and checked before any model call; a schema the host cannot
				// enforce is exit 2 schema_unsupported. The module loads only when the flag is given.
				let outputSchema: Record<string, unknown> | undefined;
				const structured =
					parsed.outputSchema === undefined ? undefined : await import("../session-control/chat-loop-messages.js");
				if (structured !== undefined && parsed.outputSchema !== undefined) {
					const loaded = await structured.loadOutputSchema(parsed.outputSchema);
					if (!loaded.ok) {
						const prefix =
							typeof parsed.outputSchema === "string"
								? structured.OUTPUT_SCHEMA_REFUSAL_PREFIX
								: `clio-coder run: task file ${parsed.outputSchema.label}: `;
						writeRunDiagnostic(`${prefix}${loaded.reason}\n`);
						return 2;
					}
					outputSchema = loaded.schema;
					// result.enforcedBy is present for every run given the flag, whatever ends it (SPEC 6.6).
					noteStructuredV2({ enforcedBy: "host" });
				}

				const assembled = await assemblePrompt(parsed);
				if (typeof assembled === "number") return assembled;

				if (parsed.agentId === undefined) {
					// Reject unknown and unsupported interactive commands before boot;
					// neither has a headless handler that could honor the request.
					const preflight = await headlessSlashPreflight(assembled.prompt, {
						disableDiscovery: noSkills,
						explicitSkillPaths: skillPaths,
					});
					if (preflight !== null && "refusal" in preflight) {
						writeRunDiagnostic(`clio-coder run: ${preflight.refusal}\n`);
						return 2;
					}
					if (preflight !== null) {
						(parsed.json ? process.stderr : process.stdout).write(`${preflight.display}\n`);
						return 0;
					}
					// An explicit --target override is a one-run target; a missing id is an
					// operator config error, not an assistant response. Reject it before the
					// headless turn so the resolver diagnostic never streams to stdout as a
					// message_end/agent_end assistant turn.
					const borrowed = await borrowHeadlessRoute(parsed.target, parsed.model);
					if (typeof borrowed === "number") return borrowed;
					if (borrowed !== null) process.stderr.write(`clio-coder run: ${borrowed.notice}\n`);
					// --dry-run (CLI-L4): resolve and print, before any session, model call or --verify command.
					if (parsed.dryRun === true) {
						const { buildRunPlan, dryRunPricingRefusal, writeRunPlan } = await import("./run-plan.js");
						const settings = borrowed?.settings ?? readSettings();
						// CLI-P16: a run the require-priced preflight would refuse is refused here too, not previewed.
						const pricing = await dryRunPricingRefusal(parsed, settings);
						if (pricing !== undefined) {
							writeRunDiagnostic(pricing);
							return 2;
						}
						const plan = buildRunPlan(parsed, settings, parsed.verifyTimeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS);
						// SPEC 6.8: the enforcement the run would use, before any spend.
						const shown: typeof plan & { outputSchema?: { enforcedBy: "host" } } =
							outputSchema !== undefined ? { ...plan, outputSchema: { enforcedBy: "host" } } : plan;
						return writeRunPlan(parsed, shown);
					}
					// No route at all is a configuration refusal before any work: exit 2 under the v2 opt-in. v1 (no
					// --output-format) keeps its boot diagnostic and exit 1 until 0.9.0.
					if (borrowed === null && parsed.target === undefined && parsed.outputFormat !== undefined) {
						let unconfigured = false;
						try {
							unconfigured = classifyDefaultTarget().kind === "no-target";
						} catch {
							// Unreadable settings keep the boot path's own diagnostic.
						}
						if (unconfigured) {
							writeRunDiagnostic(
								"clio-coder run: not configured: no model target is saved; run `clio-coder configure` or pass --target <id>\n",
							);
							return 2;
						}
					}
					if (borrowed === null && parsed.target !== undefined && explicitTargetMissing(parsed.target)) {
						writeRunDiagnostic(`clio-coder run: target '${parsed.target}' not found in settings.targets\n`);
						return 2;
					}
					// The boot path's graph loads here, after every pre-boot refusal above has had its say.
					const { runClioCommand } = await import("./clio.js");
					takeOverStdout();
					try {
						const code = await runClioCommand({
							...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
							...(options.noContextFiles ? { noContextFiles: true } : {}),
							...(noSkills ? { noSkills: true } : {}),
							...(skillPaths.length > 0 ? { skillPaths } : {}),
							...(borrowed !== null ? { startupSettings: borrowed.settings } : {}),
							headless: {
								// SPEC 6.8 step 1: the schema and one line ride the task text; no tool or system fragment varies.
								prompt:
									structured !== undefined && outputSchema !== undefined
										? `${assembled.prompt}\n\n${structured.outputSchemaInstruction(outputSchema)}`
										: assembled.prompt,
								...(outputSchema !== undefined ? { outputSchema } : {}),
								...(borrowed !== null && parsed.json ? { routeNotice: borrowed.notice } : {}),
								...(parsed.constraints ? { constraints: parsed.constraints } : {}),
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
								...(parsed.autonomy !== undefined ? { autonomy: parsed.autonomy } : {}),
								...(parsed.systemOne !== undefined ? { systemOne: parsed.systemOne } : {}),
								...(parsed.sampling !== undefined ? { sampling: parsed.sampling } : {}),
								...(parsed.steerChannel !== undefined ? { steerChannel: parsed.steerChannel } : {}),
								...(parsed.failOnNoop ? { failOnNoop: true } : {}),
								...(parsed.failOnVerify === true ? { failOnVerify: true } : {}),
								...(parsed.onPermission === "fail" ? { onPermission: "fail" as const } : {}),
								...(parsed.maxCostUsd !== undefined ? { maxCostUsd: parsed.maxCostUsd } : {}),
								...(parsed.verify.length > 0
									? {
											verify: {
												checks: runVerifyChecks(parsed.verify),
												timeoutMs: (parsed.verifyTimeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS) * 1000,
											},
										}
									: {}),
								...(deadline !== undefined ? { deadline } : {}),
								...(answers !== undefined ? { answers } : {}),
								...(parsed.sessionId !== undefined
									? {
											resumeSession: {
												kind: "id" as const,
												id: parsed.sessionId,
												...(parsed.forkSession ? { fork: true } : {}),
											},
										}
									: parsed.continueSession
										? { resumeSession: { kind: "latest" as const, ...(parsed.forkSession ? { fork: true } : {}) } }
										: {}),
								...(parsed.sessionName !== undefined ? { sessionName: parsed.sessionName } : {}),
							},
						});
						await flushRawStdout();
						return code;
					} finally {
						restoreStdout();
					}
				}

				if (parsed.json) takeOverStdout();
				try {
					// The worker is told the shape in its task text; its request never carries the caller's schema (6.8).
					const task =
						structured !== undefined && outputSchema !== undefined
							? `${assembled.prompt}\n\n${structured.outputSchemaInstruction(outputSchema)}`
							: assembled.prompt;
					const code = await runDispatch(parsed as RunCliArgs & { agentId: string }, task, {
						...options,
						noSkills,
						skillPaths,
						...(structured !== undefined && outputSchema !== undefined
							? { outputSchema: { schema: outputSchema, finish: structured } }
							: {}),
					});
					if (parsed.json) await flushRawStdout();
					return code;
				} finally {
					if (parsed.json) restoreStdout();
				}
			} finally {
				deadline?.settle();
			}
		},
	);
}

const DEFAULT_VERIFY_TIMEOUT_SECONDS = 300;

/** `--verify` commands as this run's checks: run-acceptance, then run-acceptance-2 and on. */
function runVerifyChecks(commands: ReadonlyArray<string>): Array<{ id: string; command: string }> {
	return commands.map((command, index) => ({
		id: index === 0 ? "run-acceptance" : `run-acceptance-${index + 1}`,
		command,
	}));
}

async function runDispatch(
	parsed: RunCliArgs & { agentId: string },
	task: string,
	options: {
		apiKey?: string;
		noContextFiles?: boolean;
		noSkills?: boolean;
		skillPaths?: ReadonlyArray<string>;
		/** `--output-schema` (SPEC 6.8): validate the sealed final answer once; no repair, no schema on the request. */
		outputSchema?: {
			schema: Record<string, unknown>;
			finish: typeof import("../session-control/chat-loop-messages.js");
		};
	},
): Promise<number> {
	if (parsed.toolProfile !== undefined && !isToolProfileName(parsed.toolProfile)) {
		writeRunDiagnostic("clio-coder run: --tool-profile must be one of: minimal-local|science-local|full-agent\n");
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

	// The dispatch graph loads after the usage checks above, in the order these were once static imports.
	const { readDispatchScopeNotice } = await import("../core/dispatch-scope-notice.js");
	const { AgentsDomainModule } = await import("../domains/agents/index.js");
	const { audienceRefusalStandIn } = await import("../domains/agents/spec.js");
	const { ConfigDomainModule } = await import("../domains/config/index.js");
	const { createContextDomainModule } = await import("../domains/context/runtime.js");
	const { agentRoleFactsResolver, requestExecutionRole } = await import("../domains/dispatch/execution-role.js");
	const { createDispatchDomainModule } = await import("../domains/dispatch/index.js");
	const { configureRunEventJournal } = await import("../domains/dispatch/run-event-journal.js");
	const { WORKER_PROCESS_CLEANUP_BOUND_MS } = await import("../domains/dispatch/worker-spawn.js");
	const { ExtensionsDomainModule } = await import("../domains/extensions/index.js");
	const { ensureClioState } = await import("../domains/lifecycle/index.js");
	const { buildDispatchMemorySection } = await import("../domains/memory/index.js");
	const { createPromptsDomainModule } = await import("../domains/prompts/index.js");
	const { prepareListedModelCapabilities } = await import("../domains/providers/background-model-metadata.js");
	const { resolveEffectivePricing } = await import("../domains/providers/catalog.js");
	const { ProvidersDomainModule } = await import("../domains/providers/index.js");
	const { ResourcesDomainModule } = await import("../domains/resources/index.js");
	const { SafetyDomainModule } = await import("../domains/safety/index.js");
	const { SchedulingDomainModule } = await import("../domains/scheduling/index.js");
	const { SessionDomainModule } = await import("../domains/session/index.js");
	const { TelemetryDomainModule } = await import("../domains/telemetry/index.js");
	const { assistantTextFromEvent } = await import("../tools/dispatch-event-text.js");
	const { createJsonCredentialScrub, projectDispatchJsonEvent } = await import("./modes/json-stream.js");
	const { formatDispatchHumanOutput, verifierVerdict } = await import("./run-output.js");
	const { createCliWorkerHooks } = await import("./worker-extension-hooks.js");

	ensureClioState();
	let effectiveSettings: Readonly<ClioSettings> | undefined;
	const workerHooks = createCliWorkerHooks("run");
	const loaded = await loadDomains([
		ConfigDomainModule,
		ExtensionsDomainModule,
		ResourcesDomainModule,
		createContextDomainModule({
			noContextFiles: options.noContextFiles === true,
			startupHintHost: {
				initCommand: "clio-coder context init",
				suggest: !parsed.json && process.stderr.isTTY === true,
				sink: (hint) => process.stderr.write(`${hint.text}\n`),
			},
		}),
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: options.noContextFiles === true }),
		AgentsDomainModule,
		workerHooks.middlewareModule,
		SessionDomainModule,
		// Telemetry subscribes to the dispatch terminal events so a headless
		// run auto-builds its forensic evidence bundle and sidecar index, the same
		// as an interactive session. It depends only on providers + session, both
		// loaded above.
		TelemetryDomainModule,
		SchedulingDomainModule,
		createDispatchDomainModule({
			getSettings: () => effectiveSettings,
			// This path iterates `handle.events` itself and builds no dispatch
			// event registry, so the domain is the only thing that can write the
			// run's durable transcript.
			journalRunEvents: true,
			workerSteering: parsed.steerChannel !== undefined,
			workerHooks: workerHooks.workerHooks,
		}),
	]);
	// The process journal records the status this command returns, which no shutdown coordinator sets here (#434).
	const stopDomains = async (code: number): Promise<number> => {
		loaded.getContract("telemetry")?.setExitStatus?.(code);
		await loaded.stop();
		return code;
	};
	const config = loaded.getContract("config");
	const baseSettings = config?.get() ?? readSettings();
	// Install `fleet.history.journal` the same way the interactive composition root
	// does. The journal never reads settings.yaml itself: it sits on the
	// dispatch event path, where a settings read would be both a cost and a
	// throw site.
	configureRunEventJournal(baseSettings.fleet.history.journal);
	effectiveSettings = structuredClone(baseSettings);
	// D1: headless takes yolo only from --autonomy on the command line, and the
	// parser rejects --autonomy with --agent, so this path never takes it. Pin
	// the clone to default so a settings-file yolo cannot reach it either.
	effectiveSettings.safety.autonomy = "default";
	const dispatch = loaded.getContract("dispatch");
	if (!dispatch) {
		writeRunDiagnostic("dispatch domain unavailable\n");
		return await stopDomains(1);
	}

	if (options.apiKey) {
		const providers = loaded.getContract("providers");
		if (!providers) {
			writeRunDiagnostic("clio-coder run: --api-key supplied but providers domain unavailable\n");
			return await stopDomains(1);
		}
		const settings = effectiveSettings;
		const profileTargetId = parsed.agentProfile ? settings.fleet?.profiles?.[parsed.agentProfile]?.target : undefined;
		const runtimeByTarget = new Map(settings.targets.map((target) => [target.id, target.runtime] as const));
		const runtimeTargetId = parsed.agentRuntime
			? [settings.fleet?.default, ...Object.values(settings.fleet?.profiles ?? {})].find(
					(profile) => profile?.target && runtimeByTarget.get(profile.target) === parsed.agentRuntime,
				)?.target
			: undefined;
		const targetId =
			parsed.target ?? profileTargetId ?? runtimeTargetId ?? settings.fleet?.default?.target ?? settings.chat?.target;
		if (!targetId) {
			writeRunDiagnostic("clio-coder run: --api-key supplied but no target resolved; pass --target <id>\n");
			return await stopDomains(2);
		}
		const target = providers.getTarget(targetId);
		if (!target) {
			writeRunDiagnostic(`clio-coder run: --api-key supplied but target '${targetId}' not found\n`);
			return await stopDomains(2);
		}
		// Dispatch refuses this target the same way, with exit 1, when no key is supplied.
		const runtime = providers.getRuntime(target.runtime);
		if (!runtime) {
			writeRunDiagnostic(`clio-coder run: cannot use target '${target.id}': ${runtimeNotRegistered(target.runtime)}\n`);
			return await stopDomains(1);
		}
		providers.auth.setRuntimeOverrideForTarget(target, runtime, options.apiKey);
	}

	const noSkills = options.noSkills === true || parsed.noSkills === true;
	const skillPaths = Array.from(new Set([...(options.skillPaths ?? []), ...parsed.skillPaths]));

	const runAgents = loaded.getContract("agents");
	const dispatchReq: DispatchRequest = {
		agentId: parsed.agentId,
		executionRole: requestExecutionRole({
			agentId: parsed.agentId,
			...(runAgents ? { resolveFacts: agentRoleFactsResolver((id: string) => runAgents.getSpec(id)) } : {}),
		}),
		task,
		requestOrigin: "user",
	};
	if (parsed.readOnly) dispatchReq.readOnly = true;
	if (parsed.record === true) dispatchReq.record = true;
	if (parsed.agentProfile) dispatchReq.workerProfile = parsed.agentProfile;
	if (parsed.agentRuntime) dispatchReq.workerRuntime = parsed.agentRuntime;
	if (parsed.target) dispatchReq.target = parsed.target;
	if (parsed.model) dispatchReq.model = parsed.model;
	if (parsed.thinking) dispatchReq.thinkingLevel = parsed.thinking;
	if (parsed.toolProfile) dispatchReq.toolProfile = parsed.toolProfile;
	if (parsed.required.length > 0) dispatchReq.requiredCapabilities = parsed.required;
	if (noSkills) dispatchReq.noSkills = true;
	if (skillPaths.length > 0) dispatchReq.skillPaths = skillPaths;
	// As `/run --worktree`: an isolated task worktree, kept for review rather than merged.
	if (parsed.worktree) Object.assign(dispatchReq, { worktree: true as const, apply: "preserve" as const });
	// The one worker run's spend bound, checked at route admission against the route's conservative estimate.
	if (parsed.maxCostUsd !== undefined)
		dispatchReq.routingIntent = { ...defaultRoutingIntent(dispatchReq), maxCostUsd: parsed.maxCostUsd };
	try {
		const settings = effectiveSettings;
		if (settings.integrations.projectResources?.trustProjectImports) {
			dispatchReq.trustProjectCompatRoots = true;
		}
	} catch {
		// Ignore configuration read errors
	}

	let memorySection = "";
	try {
		memorySection = buildDispatchMemorySection({
			dataDir: clioDataDir(),
			cwd: process.cwd(),
			settings: effectiveSettings,
			route: {
				agentId: parsed.agentId,
				...(parsed.target !== undefined ? { target: parsed.target } : {}),
				...(parsed.agentProfile !== undefined ? { workerProfile: parsed.agentProfile } : {}),
				...(parsed.agentRuntime !== undefined ? { workerRuntime: parsed.agentRuntime } : {}),
			},
		});
	} catch (err) {
		process.stderr.write(
			`clio-coder run: memory load failed: ${err instanceof Error ? err.message : String(err)}; continuing without memory\n`,
		);
	}
	if (memorySection.length > 0) dispatchReq.memorySection = memorySection;

	// A worker resolves its model's thinking levels and budgets from the provider
	// status, which a fresh process builds from the listing cache. A runtime that
	// lists per-model capabilities lists live first when that cache has none.
	const runProviders = loaded.getContract("providers");
	if (runProviders) {
		let workerTargetId = dispatchReq.target;
		try {
			const preview = dispatch.preview?.(dispatchReq);
			workerTargetId = preview?.targetId ?? workerTargetId;
			// --require-priced (SPEC 6.9): the one previewed route; admission rechecks the route it resolves.
			const target = preview !== undefined ? runProviders.getTarget(preview.targetId) : null;
			const runtime = target ? runProviders.getRuntime(target.runtime) : null;
			const refusal =
				preview !== undefined && target && runtime
					? requirePricedRefusal(
							resolveEffectivePricing(target, runtime, preview.wireModelId).pricedBy,
							`${preview.targetId}/${preview.wireModelId}`,
						)
					: undefined;
			if (refusal !== undefined) {
				writeRunDiagnostic(`clio-coder run: ${refusal}\n`);
				return stopDomains(2);
			}
		} catch {
			// Admission reports the refusal itself when the run starts.
		}
		if (workerTargetId !== undefined) await prepareListedModelCapabilities(runProviders, workerTargetId);
	}

	// Narrower than the writer's parameter so a frame built here is checked
	// against the agent-mode stream, not the main-agent one.
	const writeAgentFrame = (frame: RunJsonAgentFrame): void => writeFrame(frame);
	// The header is the stream's first line. A scope notice can fire during
	// admission, before the run id exists, so the header goes out with whichever
	// comes first and carries the run id only when it is known.
	let jsonHeaderWritten = false;
	const writeJsonHeader = (runId?: string): void => {
		if (!parsed.json || jsonHeaderWritten) return;
		jsonHeaderWritten = true;
		writeAgentFrame({
			type: "session",
			schemaVersion: RUN_JSON_SCHEMA_VERSION,
			mode: "agent",
			agentId: dispatchReq.agentId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			clioCoderVersion: readClioVersion(),
			...(runId !== undefined ? { runId } : {}),
		});
	};

	let cleanupSteer: (() => void) | undefined;
	// A dispatch's scope entry can change what the worker may touch without saying
	// so in the request, so the headless run reports it where an operator would see
	// it: stderr in text mode, a `dispatch_scope_notice` line in the JSON stream.
	const unsubscribeScopeNotices = telemetryHub().subscribe("run.scope_notice_raised", (payload) => {
		const notice = readDispatchScopeNotice(payload);
		if (notice === null) return;
		if (parsed.json) {
			writeJsonHeader();
			writeAgentFrame({ type: "dispatch_scope_notice", ...notice });
		} else process.stderr.write(`clio-coder run: ${notice.message}\n`);
	});
	try {
		// Started after every early exit, so a refused run never starts a runtime it
		// would have to stop, and refused like fleet run when a blocking hook cannot run.
		const hookRefusal = await workerHooks.start(loaded);
		if (hookRefusal !== null) {
			unsubscribeScopeNotices();
			await workerHooks.dispose();
			writeRunDiagnostic(`clio-coder run: ${hookRefusal}\n`);
			return await stopDomains(1);
		}
		const handle = await dispatch.dispatch(dispatchReq);
		startRunOutput();
		writeJsonHeader(handle.runId);
		if (parsed.steerChannel) {
			cleanupSteer = setupSteerChannel(parsed.steerChannel, (line) => {
				try {
					dispatch.steer(handle.runId, line);
				} catch {
					// Ignore delivery errors (e.g., run already finished)
				}
			});
		}
		// Every terminating signal aborts the worker and lets the run settle, so the result frame is always written;
		// the process then exits 128 plus the signal number, as a main-agent run does.
		let signalExit: number | null = null;
		const onSignal = (signal: NodeJS.Signals): void => {
			signalExit ??= signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143;
			dispatch.abort(handle.runId);
		};
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		process.on("SIGHUP", onSignal);
		// Any coordinated shutdown (--timeout expiry, EPIPE on stdout) aborts the
		// worker and lets it settle so the run is recorded as "canceled" before exit.
		// The budget covers the worker's own abort bound.
		getTerminationCoordinator().onDrain(
			async () => {
				try {
					dispatch.abort(handle.runId);
				} catch {
					// The run already finished.
				}
				await handle.finalPromise.catch(() => undefined);
			},
			{ timeoutMs: WORKER_PROCESS_CLEANUP_BOUND_MS + 1000 },
		);

		// Human output is the worker's final answer, settled limits, and result line. Native
		// workers carry the answer in the last assistant message_end event;
		// acp-delegation runs stream it as text_delta increments instead, so the
		// accumulated deltas serve as the fallback. Raw event names are noise for
		// a human reader and stay --json-only.
		let accumulatedText = "";
		let lastAssistantText = "";
		const credentials = createJsonCredentialScrub();
		for await (const event of handle.events) {
			if (parsed.json) {
				for (const frame of credentials.scrub(projectDispatchJsonEvent(event))) writeAgentFrame(frame);
				continue;
			}
			const e = event as { type?: string; text?: string };
			// A failover hop supersedes the previous attempt: its text is not the
			// assignment's answer, and the terminal result describes the last one.
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
		unsubscribeScopeNotices();
		if (cleanupSteer) {
			cleanupSteer();
			cleanupSteer = undefined;
		}
		const recording = parsed.record === true ? dispatch.getRun(receipt.runId)?.recording : undefined;
		// SPEC 6.8 (review H02): the host validates the sealed receipt's final answer once. A worker that already failed
		// keeps its own cause; a mismatch is exit 1 schema_mismatch and the receipt stays the one attempt.
		const schemaCheck = options.outputSchema;
		const structuredVerdict =
			schemaCheck === undefined || receipt.exitCode !== 0
				? null
				: await schemaCheck.finish.validateStructuredAnswer(
						schemaCheck.schema,
						redactUrlCredentials(receipt.output?.state === "final" ? receipt.output.text : ""),
					);
		const schemaMismatch = structuredVerdict !== null && !structuredVerdict.ok;
		if (schemaCheck !== undefined) {
			noteStructuredV2({
				enforcedBy: "host",
				...(structuredVerdict?.ok === true ? { structured: structuredVerdict.value, json: structuredVerdict.json } : {}),
				...(structuredVerdict !== null && !structuredVerdict.ok ? { errors: structuredVerdict.errors } : {}),
			});
		}
		if (parsed.json) {
			for (const frame of credentials.finish<RunJsonAgentFrame>(receipt.exitCode === 0)) writeAgentFrame(frame);
			const verifier = verifierVerdict(receipt);
			for (const frame of credentials.scrub<RunJsonAgentFrame>({
				type: "result",
				result: receipt,
				...(verifier !== null ? { verdict: verifier.verdict, failedChecks: verifier.failedChecks } : {}),
				...(recording !== undefined ? { recording } : {}),
			}))
				writeAgentFrame(frame);
		} else {
			const answer = lastAssistantText.length > 0 ? lastAssistantText : accumulatedText.trim();
			// CLI-P22: `-o` holds the validated JSON or the worker's redacted answer, as it does under v2.
			noteTextAnswer(structuredVerdict?.ok === true ? structuredVerdict.json : redactUrlCredentials(answer));
			if (structuredVerdict?.ok === true) process.stdout.write(`${structuredVerdict.json}\n`);
			else if (schemaCheck !== undefined && structuredVerdict !== null && !structuredVerdict.ok)
				process.stderr.write(`${schemaCheck.finish.schemaMismatchMessage(structuredVerdict.errors)}\n`);
			else process.stdout.write(formatDispatchHumanOutput(answer, receipt));
			if (recording) process.stderr.write(`Recording manifest (relative to Clio state): ${recording.manifestPath}\n`);
		}

		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		process.off("SIGHUP", onSignal);

		await dispatch.drain();
		await workerHooks.drain();
		await workerHooks.dispose();
		return await stopDomains(signalExit ?? (schemaMismatch ? 1 : await mapExitCode(receipt)));
	} catch (err) {
		unsubscribeScopeNotices();
		if (cleanupSteer) {
			cleanupSteer();
		}
		// A disposed host declares no hooks, so a retry admitted after dispose would run unhooked; drain first.
		await dispatch.drain();
		await workerHooks.drain();
		await workerHooks.dispose();
		const msg = err instanceof Error ? err.message : String(err);
		writeRunDiagnostic(`clio-coder run failed: ${msg}\n`);
		const failedSpec = runAgents?.getSpec(parsed.agentId);
		// Name the stand-in only when dispatch's admission check named it for this route.
		const standIn = failedSpec?.audience === "shadow" ? audienceRefusalStandIn(msg) : null;
		if (standIn !== null) {
			process.stderr.write(`clio-coder run: instead run: ${shadowStandInCommand(parsed, standIn)}\n`);
		}
		const refused =
			// Asking for an agent reserved for internal orchestration is an admission
			// refusal like any other, and no model was called. Matched against the
			// refusal the spec's own audience produces, not against failure text at large.
			await isAdmissionRefusal(msg, failedSpec);
		const exitCode = err instanceof SessionCostCeilingError ? SESSION_COST_CEILING_EXIT_CODE : refused ? 2 : 1;
		const refusedFrame = admissionRefusedFrame(parsed, msg, refused, exitCode);
		if (refusedFrame !== null) {
			writeJsonHeader();
			writeAgentFrame(refusedFrame);
		}
		return await stopDomains(exitCode);
	}
}

/** Whether a dispatch failure is an admission refusal: no worker started and no model was called. */
async function isAdmissionRefusal(
	msg: string,
	failedSpec: Parameters<typeof isUserOriginAudienceRefusal>[0] | null | undefined,
): Promise<boolean> {
	const spec = await import("../domains/agents/spec.js");
	return (
		(failedSpec ? spec.isUserOriginAudienceRefusal(failedSpec, msg) : false) ||
		/target '.+' not found/.test(msg) ||
		msg.includes("unknown agent recipe") ||
		msg.includes("admission") ||
		msg.includes("capability") ||
		msg.includes("budget")
	);
}

/** The structured frame a `run --agent --json` stream carries for a refused admission; null otherwise. */
export function admissionRefusedFrame(
	parsed: Pick<RunCliArgs, "json" | "agentId">,
	message: string,
	refused: boolean,
	exitCode: number,
): RunJsonAdmissionRefusedFrame | null {
	if (!parsed.json || !refused) return null;
	return {
		type: "admission_refused",
		agentId: parsed.agentId ?? "",
		message: redactUrlCredentials(message),
		exitCode,
	};
}

/** The refused shadow run as the user-facing command that covers it, keeping the route flags (DF-3). */
function shadowStandInCommand(parsed: RunCliArgs, standIn: string): string {
	const quote = (value: string): string => (/^[\w./@:=+-]+$/u.test(value) ? value : JSON.stringify(value));
	const parts = ["clio-coder run", "--agent", standIn, "--read-only"];
	if (parsed.cwd !== undefined) parts.push("--cwd", quote(parsed.cwd));
	if (parsed.target !== undefined) parts.push("--target", quote(parsed.target));
	if (parsed.model !== undefined) parts.push("--model", quote(parsed.model));
	if (parsed.thinking !== undefined) parts.push("--thinking", parsed.thinking);
	parts.push('"<task>"');
	return parts.join(" ");
}

/**
 * A dispatched run's exit status. Exit codes the result passes to the shell unchanged are 0, 2, the worker's
 * permission-required code and the session cost ceiling; every other failure is 1. Async because the verifier
 * reader and the worker contract load only once a dispatched run has settled.
 */
export async function mapExitCode(r: RunResult): Promise<number> {
	const { verifierVerdict } = await import("./run-output.js");
	const { WORKER_EXIT_PERMISSION_REQUIRED } = await import("../worker/spec-contract.js");
	// A verifier that reported a failed verdict makes `run --agent verifier ... && deploy` stop, though its run succeeded.
	if (r.exitCode === 0 && verifierVerdict(r)?.verdict === "fail") return 1;
	// So does a check the run saw fail after its last edit, which seals quality `fail` (bt-27); a baseline red from
	// before any edit seals no failure (x1-5).
	if (r.exitCode === 0 && r.quality.resultContract?.quality === "fail") return 1;
	const passThrough = new Set([0, 2, WORKER_EXIT_PERMISSION_REQUIRED, SESSION_COST_CEILING_EXIT_CODE]);
	return passThrough.has(r.exitCode) ? r.exitCode : 1;
}
