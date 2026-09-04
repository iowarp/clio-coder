import { existsSync, readFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	bindAgentProfileInSettings,
	type ClioSettings,
	readSettings,
	removeTargetFromSettings,
	settingsPath,
	updateSettings,
} from "../core/config.js";
import {
	type AutonomyLevel,
	type OutputVerbosity,
	type PanesSettings,
	type SmoothStreaming,
	THINKING_LEVELS,
	type ThinkingLevel,
	type TuiMode,
	type WorkerPermissionMode,
} from "../core/defaults.js";
import { initializeClioHome } from "../core/init.js";
import { resolveClioDirs } from "../core/xdg.js";
import { getVersionInfo } from "../domains/lifecycle/version.js";
import { openAuthStorage, targetRequiresAuth } from "../domains/providers/auth/index.js";
import {
	buildProviderSupportEntry,
	configuredTargetsForRuntime,
	describeRuntimeModels,
	isOrchestratorEligibleRuntime,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	recordTargetModelSnapshot,
	resolveRuntimeAuthTarget,
	supportGroupLabel,
} from "../domains/providers/index.js";
import { fingerprintNativeRuntime } from "../domains/providers/probe/fingerprint.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import { greetLmStudio } from "../domains/providers/runtimes/common/lmstudio-http.js";
import type { ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { registerClioOAuthProviders } from "../engine/oauth.js";
import { ask, askYesNo } from "./ask.js";
import { runInteropReview } from "./configure-interop.js";
import {
	type ConfigureCategory,
	formatCategoryMenu,
	formatRuntimeList,
	formatRuntimeMenu,
	matchCategoryChoice,
	type RuntimeListRow,
} from "./configure-layout.js";
import { loginOAuthRuntime } from "./configure-oauth.js";
import { canRunOnboarding, runOnboardingWizard } from "./configure-onboarding.js";
import {
	applyTarget,
	assertOrchestratorReplacementEligible,
	buildDescriptor,
	defaultUrlFor,
	deriveTargetId,
	describeAuthStatus,
	normalizeUrl,
	PROTOCOL_COMPAT_RUNTIME_IDS,
	probeLines,
	railPrefix,
	resolveSupportedWireModels,
	runtimeProbe,
	runtimesForCategory,
	setBackgroundPointer,
	setOrchestratorPointer,
	setWorkerDefaultPointer,
	setWorkerProfilePointer,
	validateContextWindowOverride,
	validateResolvedModel,
	type WireModelInventory,
	warnUndiscoveredContextWindow,
} from "./configure-target.js";
import { createLifecyclePresenter, type LifecyclePresenter, shortenPath } from "./lifecycle-presenter.js";
import { canSelect, promptSelect } from "./select.js";
import { credentialWriteFailed, printError, printOk, printPlaintextCredentialWarning } from "./shared.js";
import { terminalColumns, wrapPlain } from "./text-layout.js";

const HELP = `clio-coder configure

Configure model targets and runtime settings for chat and fleet dispatch.

Usage:
  clio-coder configure                   interactive configuration wizard
  clio-coder configure --section <name>  open one section directly:
                                         targets, models, chat, fleet,
                                         permissions, panes, skills, diagnostics
                                         Without a terminal this prints the
                                         section's values and exits.
  clio-coder configure --json            emit the effective settings as JSON
  clio-coder configure --interop         review detected coding agents as delegation peers
  clio-coder configure --list            list target runtimes (user-facing only)
  clio-coder configure --list --all      list every registered runtime including aliases
  clio-coder configure --id <targetId> [flags] --runtime <runtimeId>
  clio-coder configure --help, -h        show this message

In the interactive menus: arrow keys move, enter opens, escape goes back, q
quits. Where the terminal cannot support that, the same menus are numbered and
answered by typing a number, b for back, or q to quit.

Non-interactive flags:
  --id <targetId>                  target id to register (required when non-interactive)
  --runtime <runtimeId>            runtime to use when registering non-interactively
  --url <host>                     target base URL (http(s):// or ws://)
  --model <wireModelId>            default model id for this target
  --orchestrator-model <id>        model to use when setting chat default
  --background-model <id>          model to use for proactive task memory
  --fleet-model <id>               model to use when setting fleet default
                                   (mutually exclusive with --agent-profile)
  --agent-profile <name>           save this target as a named fleet profile
  --agent-profile-model <id>       model to use for --agent-profile
  --bind-agent <agentId>           bind this --agent-profile to an agent
  --api-key-env <VAR>              read API key from this env var at call time
  --api-key <literal>              store API key in credentials.yaml
  --force                          save a model outside the runtime catalog, or one the
                                   target does not advertise, without refusing
  --gateway                        mark the target as a gateway
  --lifecycle <user-managed|clio-coder-managed>
                                  resident model lifecycle policy
  --set-orchestrator               use this target for chat
  --set-background                 use this target for proactive task memory
  --set-fleet-default              use this target for the fleet default
  --context-window <N>             capability override
  --max-tokens <N>                 output token capability override
  --reasoning <true|false>         capability override
`;

interface ParsedArgs {
	positional: string[];
	help: boolean;
	list: boolean;
	all: boolean;
	interop: boolean;
	json: boolean;
	section?: string;
	remove?: string;
	renameOld?: string;
	renameNew?: string;
	id?: string;
	runtime?: string;
	url?: string;
	model?: string;
	orchestratorModel?: string;
	backgroundModel?: string;
	workerModel?: string;
	workerProfile?: string;
	workerProfileModel?: string;
	bindAgent?: string;
	apiKeyEnv?: string;
	apiKey?: string;
	force: boolean;
	gateway: boolean;
	lifecycle?: TargetDescriptor["lifecycle"];
	setOrchestrator: boolean;
	setBackground: boolean;
	setWorkerDefault: boolean;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

function parseSetupArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = {
		positional: [],
		help: false,
		list: false,
		all: false,
		interop: false,
		json: false,
		force: false,
		gateway: false,
		setOrchestrator: false,
		setBackground: false,
		setWorkerDefault: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		const need = (): string => {
			const v = argv[i + 1];
			if (v === undefined) throw new Error(`${a} requires a value`);
			i += 1;
			return v;
		};
		switch (a) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--json":
				out.json = true;
				break;
			case "--section":
				out.section = need();
				break;
			case "--list":
				out.list = true;
				break;
			case "--all":
				out.all = true;
				break;
			case "--interop":
				out.interop = true;
				break;
			case "--remove":
				out.remove = need();
				break;
			case "--rename":
				out.renameOld = need();
				out.renameNew = need();
				break;
			case "--id":
				out.id = need();
				break;
			case "--runtime":
				out.runtime = need();
				break;
			case "--url":
				out.url = need();
				break;
			case "--model":
				out.model = need();
				break;
			case "--orchestrator-model":
				out.orchestratorModel = need();
				break;
			case "--background-model":
				out.backgroundModel = need();
				break;
			case "--fleet-model":
				out.workerModel = need();
				break;
			case "--agent-profile":
				out.workerProfile = need();
				break;
			case "--agent-profile-model":
				out.workerProfileModel = need();
				break;
			case "--bind-agent":
				out.bindAgent = need();
				break;
			case "--api-key-env":
				out.apiKeyEnv = need();
				break;
			case "--api-key":
				out.apiKey = need();
				break;
			case "--force":
				out.force = true;
				break;
			case "--gateway":
				out.gateway = true;
				break;
			case "--lifecycle": {
				const v = need();
				if (v !== "user-managed" && v !== "clio-coder-managed") {
					throw new Error("--lifecycle must be user-managed or clio-coder-managed");
				}
				out.lifecycle = v;
				break;
			}
			case "--set-orchestrator":
				out.setOrchestrator = true;
				break;
			case "--set-background":
				out.setBackground = true;
				break;
			case "--set-fleet-default":
				out.setWorkerDefault = true;
				break;
			case "--context-window": {
				const n = Number(need());
				if (!Number.isFinite(n) || n <= 0) throw new Error("--context-window must be a positive number");
				out.contextWindow = Math.floor(n);
				break;
			}
			case "--max-tokens": {
				const n = Number(need());
				if (!Number.isFinite(n) || n <= 0) throw new Error("--max-tokens must be a positive number");
				out.maxTokens = Math.floor(n);
				break;
			}
			case "--reasoning": {
				const v = need().toLowerCase();
				if (v !== "true" && v !== "false") throw new Error("--reasoning must be true or false");
				out.reasoning = v === "true";
				break;
			}
			default:
				if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
				out.positional.push(a);
		}
	}
	return out;
}

function ensureRegistryPopulated(): void {
	registerClioOAuthProviders();
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
}

const RUNTIME_LIST_CAPTION =
	"every registered runtime. run `clio-coder auth list` for the ones clio authenticates itself; the rest authenticate through their own tool (claude-cli, aws-sdk) or need no credential.";

function printRuntimeList(includeHidden: boolean): void {
	const settings = readSettings();
	const auth = openAuthStorage();
	const rows: RuntimeListRow[] = [];
	for (const entry of listProviderSupportEntries(getRuntimeRegistry().list(), { includeHidden })) {
		const runtime = getRuntimeRegistry().get(entry.runtimeId);
		const status =
			runtime && entry.connectable
				? auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false })
				: null;
		const authLabel =
			runtime?.auth === "oauth"
				? status?.available
					? "connected"
					: "login"
				: runtime?.auth === "api-key"
					? status?.available
						? "credential"
						: targetRequiresAuth({ id: entry.runtimeId, runtime: entry.runtimeId }, runtime)
							? "needs-key"
							: "key-optional"
					: (runtime?.auth ?? "none");
		rows.push({
			group: supportGroupLabel(entry.group),
			runtimeId: entry.runtimeId,
			label: entry.label,
			auth: authLabel,
			targets: configuredTargetsForRuntime(settings, entry.runtimeId).length,
			models: describeRuntimeModels(entry, 2),
		});
	}
	const width = terminalColumns();
	for (const line of formatRuntimeList(rows, width)) {
		process.stdout.write(`${line}\n`);
	}
	// The other half of the pair `clio-coder auth list` names. This table is every
	// registered runtime; that one is the subset Clio holds a credential for,
	// and a user who found a name here and could not find it there was reading
	// two screens that each claimed to be the list of what you can connect.
	for (const line of wrapPlain(RUNTIME_LIST_CAPTION, width)) {
		process.stdout.write(`${line}\n`);
	}
}

function printSummary(settings: ClioSettings, descriptor: TargetDescriptor, probe: ProbeResult | null): void {
	process.stdout.write(`\nsaved target ${descriptor.id} (runtime=${descriptor.runtime})\n`);
	if (descriptor.url) process.stdout.write(`  url        ${descriptor.url}\n`);
	if (descriptor.defaultModel) process.stdout.write(`  model      ${descriptor.defaultModel}\n`);
	if (descriptor.auth?.apiKeyEnvVar) process.stdout.write(`  apiKeyEnv  ${descriptor.auth.apiKeyEnvVar}\n`);
	if (descriptor.gateway) process.stdout.write("  gateway    true\n");
	if (descriptor.lifecycle) process.stdout.write(`  lifecycle  ${descriptor.lifecycle}\n`);
	if (probe) {
		for (const line of probeLines(descriptor, probe)) process.stdout.write(`  ${line}\n`);
	}
	warnUndiscoveredContextWindow(descriptor, probe);
	if (settings.chat.target === descriptor.id) process.stdout.write("  orchestrator target\n");
	if (settings.context.memory.target === descriptor.id) process.stdout.write("  background memory target\n");
	if (settings.fleet.default.target === descriptor.id) process.stdout.write("  fleet default\n");
	for (const [name, profile] of Object.entries(settings.fleet.profiles)) {
		if (profile.target === descriptor.id) process.stdout.write(`  fleet profile ${name}\n`);
	}
	process.stdout.write(`\nsettings written to ${settingsPath()}\n`);
}

function resolveModelChoice(
	answer: string,
	wireModels: ReadonlyArray<string>,
	defaultValue: string | undefined,
): string | undefined {
	if (answer.length === 0) return defaultValue;
	const numeric = Number(answer);
	if (Number.isInteger(numeric) && numeric >= 1 && numeric <= wireModels.length) {
		return wireModels[numeric - 1];
	}
	return answer;
}

async function askModelChoice(
	rl: ReturnType<typeof createInterface>,
	label: string,
	wireModels: ReadonlyArray<string>,
	defaultValue: string | undefined,
): Promise<string | null> {
	const answer = await ask(rl, `${label} (number or id)`, defaultValue ?? "");
	if (answer === null) return null;
	return resolveModelChoice(answer, wireModels, defaultValue) ?? "";
}

/**
 * A catalog-ordered list has no head worth persisting: openai's first of 38 ids
 * is `gpt-4` because g sorts early, and a target configured without --model
 * used to carry it as the model the operator chose.
 */
function refuseCatalogSeededModel(runtime: RuntimeDescriptor, support: ProviderSupportEntry): void {
	printError(
		`--model is required for ${runtime.id}: its ${support.modelHints.length} model ids come from the provider catalog in name order, which recommends none of them`,
	);
	process.stderr.write(
		`  run \`clio-coder configure --runtime ${runtime.id}\` with no other flags to choose from the full list\n`,
	);
}

async function runNonInteractive(runtime: RuntimeDescriptor, args: ParsedArgs): Promise<number> {
	if (!args.id) {
		printError("--id is required when passing flags non-interactively");
		return 2;
	}
	if (args.workerProfileModel !== undefined && args.workerProfile === undefined) {
		printError("--agent-profile-model requires --agent-profile");
		return 2;
	}
	if (args.bindAgent !== undefined && args.workerProfile === undefined) {
		printError("--bind-agent requires --agent-profile");
		return 2;
	}
	if (args.workerProfile !== undefined && args.workerProfile.trim().length === 0) {
		printError("--agent-profile must be non-empty");
		return 2;
	}
	if (args.workerProfile !== undefined && args.workerModel !== undefined) {
		printError(
			"--fleet-model and --agent-profile conflict; use --agent-profile-model for the profile, or drop --agent-profile to set the fleet default",
		);
		return 2;
	}
	const settings = readSettings();
	const auth = openAuthStorage();
	const support = buildProviderSupportEntry(runtime);
	const existing = settings.targets.find((e) => e.id === args.id);
	if (existing && (getRuntimeRegistry().get(existing.runtime)?.id ?? existing.runtime) !== runtime.id) {
		printError(`target ${args.id} already exists with runtime ${existing.runtime}`);
		return 2;
	}
	let url: string | undefined = args.url ? normalizeUrl(args.url, runtime.id) : existing?.url;
	if (!url && support.supportsCustomUrl) {
		url = defaultUrlFor(runtime.id);
	}
	if (url && runtime.id === "lmstudio") {
		const greeting = await greetLmStudio(
			{ id: args.id, runtime: runtime.id, url },
			{ credentialsPresent: new Set(), httpTimeoutMs: 750 },
		);
		if (!greeting.ok) {
			printError(`refusing to save LM Studio target '${args.id}': ${url} did not return the LM Studio greeting`);
			return 2;
		}
	}
	if (url && (runtime.id === "openai-compat" || runtime.id === "anthropic-compat")) {
		const fingerprint = await fingerprintNativeRuntime(url);
		if (fingerprint) {
			process.stdout.write(
				`note: detected ${fingerprint.displayName} at ${url}; consider \`clio-coder targets convert ${args.id} --runtime ${fingerprint.runtimeId}\` for proper resident-model lifecycle\n`,
			);
		}
	}
	const authStatus = auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	const apiKeyEnv = args.apiKeyEnv ?? existing?.auth?.apiKeyEnvVar;
	const apiKeyRef =
		runtime.auth === "api-key" && (args.apiKey || existing?.auth?.apiKeyRef || authStatus.source === "stored-api-key")
			? runtime.id
			: undefined;
	const oauthProfile =
		runtime.auth === "oauth" ? (existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id) : undefined;
	const seed = buildDescriptor(runtime, args.id, {
		...(url !== undefined ? { url } : {}),
		...(args.model !== undefined
			? { model: args.model }
			: existing?.defaultModel
				? { model: existing.defaultModel }
				: support.defaultModel
					? { model: support.defaultModel }
					: {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: args.gateway || existing?.gateway === true,
		...(args.lifecycle !== undefined
			? { lifecycle: args.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
		...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
		...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
		...(existing?.lmstudio ? { lmstudio: existing.lmstudio } : {}),
		...(existing?.litellm ? { litellm: existing.litellm } : {}),
	});
	const inventory = await resolveSupportedWireModels(runtime, seed, existing, args.apiKey);
	const wireModels = inventory.models;
	const model =
		args.model ??
		existing?.defaultModel ??
		(inventory.source === "probe" ? wireModels[0] : support.defaultModel) ??
		(support.modelSource === "catalog" ? undefined : wireModels[0]);
	if (model === undefined && support.modelSource === "catalog") {
		refuseCatalogSeededModel(runtime, support);
		return 2;
	}
	if (!validateResolvedModel(runtime, seed, model, args.force, inventory)) return 2;
	if (!validateContextWindowOverride(runtime, model, args.contextWindow, args.force)) return 2;
	const descriptor = buildDescriptor(runtime, args.id, {
		...(url !== undefined ? { url } : {}),
		...(model ? { model } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: args.gateway || existing?.gateway === true,
		...(args.lifecycle !== undefined
			? { lifecycle: args.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
		...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
		...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
		...(existing?.lmstudio ? { lmstudio: existing.lmstudio } : {}),
		...(existing?.litellm ? { litellm: existing.litellm } : {}),
	});
	const setOrchestrator = args.setOrchestrator || args.orchestratorModel !== undefined;
	const setBackground = args.setBackground || args.backgroundModel !== undefined;
	if ((setOrchestrator || setBackground) && !isOrchestratorEligibleRuntime(runtime)) {
		printError(
			`cannot use target '${descriptor.id}' as a chat or background target because runtime '${runtime.id}' is not an HTTP/native runtime`,
		);
		return 1;
	}
	try {
		assertOrchestratorReplacementEligible(settings, descriptor);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (args.apiKey) {
		auth.setApiKey(runtime.id, args.apiKey);
		// Bailing here leaves nothing half-done: settings are not touched until
		// applyConfiguration below, so a refused credential write means the whole
		// command changed nothing, which is what the non-zero exit now claims.
		if (credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; target '${descriptor.id}' not saved`))
			return 1;
		printPlaintextCredentialWarning();
	}
	const setWorkerDefault = args.setWorkerDefault || (args.workerProfile === undefined && args.workerModel !== undefined);
	const applyConfiguration = (target: ClioSettings): void => {
		applyTarget(target, descriptor);
		if (setOrchestrator)
			setOrchestratorPointer(target, descriptor, args.orchestratorModel ?? descriptor.defaultModel ?? null);
		if (setBackground) setBackgroundPointer(target, descriptor, args.backgroundModel ?? descriptor.defaultModel ?? null);
		if (setWorkerDefault)
			setWorkerDefaultPointer(target, descriptor, args.workerModel ?? descriptor.defaultModel ?? null);
		if (args.workerProfile !== undefined) {
			setWorkerProfilePointer(
				target,
				args.workerProfile,
				descriptor,
				args.workerProfileModel ?? descriptor.defaultModel ?? null,
			);
			if (args.bindAgent !== undefined) bindAgentProfileInSettings(target, args.bindAgent, args.workerProfile);
		}
	};
	// Apply to the local snapshot for the summary below, then persist the same
	// mutation against the freshest on-disk state under the settings lock so a
	// concurrent session's field-level write-through is never lost.
	applyConfiguration(settings);
	updateSettings(applyConfiguration);
	const probe = await runtimeProbe(runtime, descriptor);
	if (probe?.ok && probe.models) {
		recordTargetModelSnapshot(descriptor, probe.models, probe.modelLabels ? { modelLabels: probe.modelLabels } : {});
	}
	printSummary(settings, descriptor, probe);
	if (
		runtime.auth === "oauth" &&
		!auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false }).available
	) {
		process.stdout.write(
			`note: authenticate ${runtime.id} with \`clio-coder auth login ${runtime.id}\` before using this target\n`,
		);
	}
	printOk(`target ${args.id} saved`);
	return 0;
}

async function pickRuntime(rl: ReturnType<typeof createInterface>): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	const entries = listProviderSupportEntries(registry.list());
	return pickRuntimeFromEntries(rl, entries, "\nSupported runtimes:");
}

async function pickRuntimeFromEntries(
	rl: ReturnType<typeof createInterface>,
	entries: ReadonlyArray<ProviderSupportEntry>,
	heading: string,
): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	if (entries.length === 0) {
		process.stderr.write("no runtimes available in this category\n");
		return null;
	}
	process.stdout.write(`${heading}\n`);
	const menu = formatRuntimeMenu(
		entries.map((entry) => ({
			group: supportGroupLabel(entry.group),
			runtimeId: entry.runtimeId,
			summary: entry.summary,
		})),
		terminalColumns(),
	);
	for (const line of menu) process.stdout.write(`${line}\n`);
	const allowedIds = new Set(entries.map((entry) => entry.runtimeId));
	// A default here reads as a recommendation, and the only basis this list has
	// for one is the featured flag. Falling back to the first entry made the
	// default whatever sorted first by label, so the bucket that advertises
	// llama.cpp, vLLM, and SGLang offered Antigravity CLI to anyone who pressed
	// Enter. With no featured entry there is no recommendation to make, and Enter
	// asks again rather than choosing on the user's behalf.
	const defaultRuntimeId = entries.find((entry) => entry.featured)?.runtimeId ?? "";
	for (;;) {
		const answer = await ask(rl, "\nSelection (number or runtime id)", defaultRuntimeId);
		if (answer === null) return null;
		if (answer.length === 0) {
			process.stderr.write(`pick a number from 1 to ${entries.length}, or type a runtime id\n`);
			continue;
		}
		const numeric = Number(answer);
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) {
			const picked = entries[numeric - 1];
			if (picked) {
				const runtime = registry.get(picked.runtimeId);
				if (runtime) return runtime;
			}
		}
		if (allowedIds.has(answer)) {
			const match = registry.get(answer);
			if (match) return match;
		}
		process.stderr.write(`unknown runtime id for this category: ${answer}\n`);
	}
}

async function pickCategory(rl: ReturnType<typeof createInterface>): Promise<ConfigureCategory | null> {
	process.stdout.write("\nHow will you connect Clio to a model?\n\n");
	for (const line of formatCategoryMenu(terminalColumns())) process.stdout.write(`${line}\n`);
	for (;;) {
		const answer = await ask(rl, "\nSelection", "1");
		if (answer === null) return null;
		if (answer.length === 0) continue;
		const category = matchCategoryChoice(answer);
		if (category) return category;
		process.stderr.write(`invalid choice: ${answer}\n`);
	}
}

async function pickRuntimeViaCategory(rl: ReturnType<typeof createInterface>): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	const allEntries = listProviderSupportEntries(registry.list());
	const category = await pickCategory(rl);
	if (category === null) return null;
	if (category === "all") return pickRuntime(rl);
	const filtered = runtimesForCategory(allEntries, category);
	if (filtered.length === 0) {
		process.stderr.write("no runtimes available for that category; falling back to full list\n");
		return pickRuntime(rl);
	}
	if (category === "chatgpt") {
		const only = filtered[0];
		if (only) {
			const runtime = registry.get(only.runtimeId);
			if (runtime) {
				process.stdout.write(`\nUsing ${runtime.id} (${only.summary}).\n`);
				return runtime;
			}
		}
		return pickRuntime(rl);
	}
	if (filtered.length === 1) {
		const only = filtered[0];
		if (only) {
			const runtime = registry.get(only.runtimeId);
			if (runtime) {
				process.stdout.write(`\nUsing ${runtime.id} (${only.summary}).\n`);
				return runtime;
			}
		}
	}
	const heading =
		category === "local-app" ? "\nLocal apps:" : category === "local-http" ? "\nLocal HTTP servers:" : "\nCloud APIs:";
	return pickRuntimeFromEntries(rl, filtered, heading);
}

async function maybeSteerToNativeRuntime(
	rl: ReturnType<typeof createInterface>,
	currentRuntime: RuntimeDescriptor,
	url: string,
): Promise<RuntimeDescriptor> {
	if (currentRuntime.id !== "openai-compat" && currentRuntime.id !== "anthropic-compat") return currentRuntime;
	const fingerprint = await fingerprintNativeRuntime(url);
	if (!fingerprint) return currentRuntime;
	const native = getRuntimeRegistry().get(fingerprint.runtimeId);
	if (!native) return currentRuntime;
	process.stdout.write(`\nDetected ${fingerprint.displayName} at ${url}.\n`);
	const switchIt = await askYesNo(rl, `Use ${fingerprint.runtimeId} runtime instead of ${currentRuntime.id}?`, true);
	if (!switchIt) return currentRuntime;
	process.stdout.write(`Using ${fingerprint.runtimeId} runtime.\n`);
	return native;
}

async function runTargetSetupInteractive(
	rl: ReturnType<typeof createInterface>,
	runtime: RuntimeDescriptor,
	defaults: ParsedArgs,
): Promise<number> {
	const auth = openAuthStorage();
	const settings = readSettings();
	let support = buildProviderSupportEntry(runtime);
	const initialRuntimeId = runtime.id;
	const existingForRuntime = configuredTargetsForRuntime(settings, initialRuntimeId);
	const existing =
		(defaults.id
			? settings.targets.find((entry) => entry.id === defaults.id && entry.runtime === initialRuntimeId)
			: null) ??
		existingForRuntime[0] ??
		null;
	if (existingForRuntime.length > 0) {
		process.stdout.write(`\nExisting targets for ${runtime.id}:\n`);
		for (const target of existingForRuntime) {
			process.stdout.write(`  - ${target.id}${target.defaultModel ? ` (${target.defaultModel})` : ""}\n`);
		}
	}
	process.stdout.write(`\nSelected runtime: ${runtime.id} (${support.summary})\n`);
	process.stdout.write(`Credentials: ${describeAuthStatus(runtime)}\n`);
	if (support.modelHints.length > 0) {
		process.stdout.write(`Known models: ${describeRuntimeModels(support, 4)}\n`);
	}
	const suggestedId = defaults.id ?? existing?.id ?? deriveTargetId(runtime.id, settings.targets);
	const idInput = await ask(rl, "Target id", suggestedId);
	if (idInput === null || idInput.length === 0) {
		printError("target id is required");
		return 2;
	}
	const targetId = idInput;

	let url: string | undefined = existing?.url;
	if (support.supportsCustomUrl) {
		const urlDefault = defaults.url ?? existing?.url ?? defaultUrlFor(runtime.id);
		const urlInput = await ask(
			rl,
			support.group === "local-http" ? "Target URL" : "Base URL override (blank for runtime default)",
			urlDefault,
		);
		if (urlInput === null) return 0;
		if (urlInput.length > 0) url = normalizeUrl(urlInput, runtime.id);
	} else if (defaults.url) {
		url = normalizeUrl(defaults.url, runtime.id);
	}

	if (url) {
		const steered = await maybeSteerToNativeRuntime(rl, runtime, url);
		if (steered.id !== runtime.id) {
			runtime = steered;
			support = buildProviderSupportEntry(runtime);
		}
		if (runtime.id === "lmstudio") {
			const greeting = await greetLmStudio(
				{ id: targetId, runtime: runtime.id, url },
				{ credentialsPresent: new Set(), httpTimeoutMs: 750 },
			);
			if (!greeting.ok) {
				printError(`refusing to save LM Studio target '${targetId}': ${url} did not return the LM Studio greeting`);
				return 2;
			}
		}
	}

	let apiKeyEnv: string | undefined;
	let apiKeyLiteral: string | undefined;
	let apiKeyRef: string | undefined = existing?.auth?.apiKeyRef;
	let oauthProfile: string | undefined =
		runtime.auth === "oauth" ? (existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id) : undefined;
	const authStatus = auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	if (runtime.auth === "api-key") {
		// Default to the env-var path, which keeps the key off disk. A target that
		// needs no key at all defaults to skip instead: a local llama.cpp server
		// wants no credential, and offering `env` sent the user to an unexplained
		// `Env var name:` with nothing correct to type into it.
		const needsCredential = targetRequiresAuth({ id: targetId, runtime: runtime.id }, runtime);
		const defaultSource =
			authStatus.source === "stored-api-key"
				? "keep"
				: authStatus.source === "environment" || existing?.auth?.apiKeyEnvVar || needsCredential
					? "env"
					: "skip";
		process.stdout.write(
			"\nCredential source: env reads a key from an environment variable, stored writes one to\n" +
				"credentials.yaml, keep leaves the current one alone, skip uses no key at all.\n",
		);
		const choice = await ask(rl, "Credential source [env|stored|keep|skip]", defaultSource);
		if (choice === null) return 0;
		const normalized = choice.trim().toLowerCase();
		if (normalized === "stored") {
			const literal = await ask(rl, "API key literal (stored in credentials.yaml, mode 0600)");
			if (literal !== null && literal.length > 0) {
				apiKeyLiteral = literal;
				apiKeyRef = runtime.id;
			}
		} else if (normalized === "env") {
			const envDefault = defaults.apiKeyEnv ?? existing?.auth?.apiKeyEnvVar ?? runtime.credentialsEnvVar ?? "";
			const envAnswer = await ask(rl, "Env var name (blank for no key)", envDefault);
			if (envAnswer === null) return 0;
			if (envAnswer.length > 0) apiKeyEnv = envAnswer;
			apiKeyRef = undefined;
		} else if (normalized === "keep") {
			apiKeyEnv =
				existing?.auth?.apiKeyEnvVar ?? (authStatus.source === "environment" ? runtime.credentialsEnvVar : undefined);
			apiKeyRef = existing?.auth?.apiKeyRef ?? (authStatus.source === "stored-api-key" ? runtime.id : undefined);
		} else {
			apiKeyEnv = undefined;
			apiKeyRef = undefined;
		}
	}
	if (runtime.auth === "oauth") {
		const connectNow = authStatus.available
			? await askYesNo(rl, `Reconnect ${runtime.displayName}?`, false)
			: await askYesNo(rl, `Connect ${runtime.displayName} now?`, true);
		if (connectNow) {
			const connected = await loginOAuthRuntime(rl, runtime);
			if (!connected) return 1;
		}
		oauthProfile = runtime.oauthProviderId ?? runtime.id;
	}

	let model: string | undefined = defaults.model;
	let inventory: WireModelInventory = { models: [], source: "none" };
	const tentative = buildDescriptor(runtime, targetId, {
		...(url !== undefined ? { url } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: defaults.gateway,
		...(defaults.lifecycle !== undefined
			? { lifecycle: defaults.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(defaults.contextWindow !== undefined ? { contextWindow: defaults.contextWindow } : {}),
		...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
		...(defaults.reasoning !== undefined ? { reasoning: defaults.reasoning } : {}),
		...(existing?.lmstudio ? { lmstudio: existing.lmstudio } : {}),
		...(existing?.litellm ? { litellm: existing.litellm } : {}),
	});

	if (runtime.kind === "http" || runtime.externalAgentLoop?.modelCatalog === "live-authoritative") {
		inventory = await resolveSupportedWireModels(runtime, tentative, existing ?? undefined);
	}
	const wireModels = inventory.models;
	// The wizard shows the whole list, so a catalog-ordered runtime does not need
	// --model here the way the non-interactive path does. It does need to stop
	// offering the alphabetically first id as though it were the recommended one.
	const catalogOrdered = support.modelSource === "catalog";
	model =
		model ??
		existing?.defaultModel ??
		(inventory.source === "probe" ? wireModels[0] : support.defaultModel) ??
		(catalogOrdered ? undefined : wireModels[0]);
	if (wireModels.length > 0) {
		process.stdout.write("\nSelectable models:\n");
		for (const [index, wireModel] of wireModels.entries()) {
			const label = inventory.labels?.[wireModel];
			process.stdout.write(
				`  ${index + 1}. ${wireModel}${label && label !== wireModel ? ` — ${label}` : ""}${wireModel === model ? "  [default]" : ""}\n`,
			);
		}
		if (inventory.source === "cache") process.stdout.write("  cached model snapshot (not verified in this run)\n");
		if (inventory.probeError) process.stdout.write(`  live probe unavailable: ${inventory.probeError}\n`);
		if (!model && catalogOrdered) {
			process.stdout.write(`  listed in provider catalog order, which recommends none of them; pick one.\n`);
		}
		for (;;) {
			const pickedModel = await askModelChoice(rl, "Default target model", wireModels, model);
			if (pickedModel === null) return 0;
			if (pickedModel.length > 0) model = pickedModel;
			if (!model) {
				process.stdout.write("  a model is required: enter a number from the list or a model id.\n");
				continue;
			}
			if (validateResolvedModel(runtime, tentative, model, defaults.force, inventory)) break;
		}
	} else {
		for (;;) {
			if (model && validateResolvedModel(runtime, tentative, model, defaults.force, inventory)) break;
			const manual = await ask(rl, "Default model id (blank to leave empty)", model ?? "");
			if (manual === null) return 0;
			model = manual.length > 0 ? manual : undefined;
			if (!model) break;
		}
	}
	let contextWindowChoice = defaults.contextWindow;
	let reasoningChoice = defaults.reasoning;
	// Generic OpenAI/Anthropic-compatible endpoints have no cloud catalog and
	// their /v1/models rarely reports a context window or reasoning support, so
	// ask for the two capabilities that cannot be probed reliably. Output budget
	// is intentionally not asked: defaults.maxTokens applies globally and is
	// clamped down to the model at request time.
	if (PROTOCOL_COMPAT_RUNTIME_IDS.has(runtime.id)) {
		if (contextWindowChoice === undefined) {
			const cwDefault = existing?.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow;
			const cwAnswer = await ask(
				rl,
				"Context window in tokens (blank for runtime default)",
				cwDefault > 0 ? String(cwDefault) : "",
			);
			if (cwAnswer === null) return 0;
			if (cwAnswer.length > 0) {
				const parsed = Number(cwAnswer);
				if (Number.isInteger(parsed) && parsed > 0) contextWindowChoice = parsed;
				else process.stderr.write(`ignoring invalid context window: ${cwAnswer}\n`);
			}
		}
		if (reasoningChoice === undefined) {
			const reasoningDefault = existing?.capabilities?.reasoning ?? runtime.defaultCapabilities.reasoning === true;
			reasoningChoice = await askYesNo(rl, "Does this model support reasoning / thinking?", reasoningDefault);
		}
	}
	if (!validateContextWindowOverride(runtime, model, contextWindowChoice, defaults.force)) return 2;

	const gatewayDefault = defaults.gateway || existing?.gateway === true;
	const gatewayAnswer = gatewayDefault ? true : await askYesNo(rl, "Mark as gateway?", false);

	const descriptor = buildDescriptor(runtime, targetId, {
		...(url !== undefined ? { url } : {}),
		...(model !== undefined ? { model } : {}),
		...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(oauthProfile !== undefined ? { oauthProfile } : {}),
		gateway: gatewayAnswer,
		...(defaults.lifecycle !== undefined
			? { lifecycle: defaults.lifecycle }
			: existing?.lifecycle !== undefined
				? { lifecycle: existing.lifecycle }
				: {}),
		...(contextWindowChoice !== undefined ? { contextWindow: contextWindowChoice } : {}),
		...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
		...(reasoningChoice !== undefined ? { reasoning: reasoningChoice } : {}),
		...(existing?.lmstudio ? { lmstudio: existing.lmstudio } : {}),
		...(existing?.litellm ? { litellm: existing.litellm } : {}),
	});
	try {
		assertOrchestratorReplacementEligible(settings, descriptor);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (apiKeyLiteral) {
		auth.setApiKey(runtime.id, apiKeyLiteral);
		// As in the non-interactive path: the settings write is still ahead of us,
		// so refusing here leaves the whole wizard run without an effect.
		if (credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; target '${descriptor.id}' not saved`))
			return 1;
		printPlaintextCredentialWarning();
	}

	const probe = await runtimeProbe(runtime, descriptor);
	if (probe?.ok && probe.models) recordTargetModelSnapshot(descriptor, probe.models);
	if (probe) {
		process.stdout.write("\n");
		for (const line of probeLines(descriptor, probe)) process.stdout.write(`${line}\n`);
		if (!probe.ok) {
			const keepAnyway = await askYesNo(rl, "save this target anyway, without a reply from it?", true);
			if (!keepAnyway) {
				printError("aborted; settings not changed");
				return 0;
			}
		}
	}

	const setOrchestrator = !isOrchestratorEligibleRuntime(runtime)
		? false
		: defaults.setOrchestrator
			? true
			: await askYesNo(rl, "use as orchestrator (chat) target?", !settings.chat.target);
	const setWorkerDefault = defaults.setWorkerDefault
		? true
		: await askYesNo(rl, "use as fleet default?", !settings.fleet.default.target);
	const setBackground = !isOrchestratorEligibleRuntime(runtime)
		? false
		: defaults.setBackground
			? true
			: await askYesNo(rl, "use as background memory target?", false);
	const orchestratorModel = setOrchestrator
		? (defaults.orchestratorModel ??
			(await askModelChoice(
				rl,
				"Orchestrator model",
				wireModels,
				settings.chat.target === targetId ? (settings.chat.model ?? model) : model,
			)))
		: undefined;
	if (orchestratorModel === null) return 0;
	const workerModel = setWorkerDefault
		? (defaults.workerModel ??
			(await askModelChoice(
				rl,
				"Fleet model",
				wireModels,
				settings.fleet.default.target === targetId ? (settings.fleet.default.model ?? model) : model,
			)))
		: undefined;
	if (workerModel === null) return 0;
	const backgroundModel = setBackground
		? (defaults.backgroundModel ??
			(await askModelChoice(
				rl,
				"Background memory model",
				wireModels,
				settings.context.memory.target === targetId ? (settings.context.memory.model ?? model) : model,
			)))
		: undefined;
	if (backgroundModel === null) return 0;

	const applyWizardChoice = (target: ClioSettings): void => {
		applyTarget(target, descriptor);
		if (setOrchestrator) setOrchestratorPointer(target, descriptor, orchestratorModel);
		if (setBackground) setBackgroundPointer(target, descriptor, backgroundModel);
		if (setWorkerDefault) setWorkerDefaultPointer(target, descriptor, workerModel);
	};
	applyWizardChoice(settings);
	updateSettings(applyWizardChoice);

	printSummary(settings, descriptor, probe);
	printOk(`target ${targetId} saved`);
	await runInteropReview({ rl });
	return 0;
}

export function runTargetRemove(id: string): number {
	if (!readSettings().targets.some((e) => e.id === id)) {
		printError(`no target with id ${id}`);
		return 1;
	}
	updateSettings((settings) => {
		removeTargetFromSettings(settings, id);
	});
	printOk(`removed target ${id}`);
	return 0;
}

export function runTargetRename(oldId: string, newId: string): number {
	if (oldId === newId) {
		printError("old and new id are identical");
		return 2;
	}
	const current = readSettings();
	if (current.targets.some((e) => e.id === newId)) {
		printError(`target id already exists: ${newId}`);
		return 2;
	}
	if (!current.targets.some((e) => e.id === oldId)) {
		printError(`no target with id ${oldId}`);
		return 1;
	}
	updateSettings((settings) => {
		const target = settings.targets.find((e) => e.id === oldId);
		if (!target) return;
		target.id = newId;
		if (settings.chat.target === oldId) settings.chat.target = newId;
		if (settings.context.memory.target === oldId) settings.context.memory.target = newId;
		if (settings.fleet.default.target === oldId) settings.fleet.default.target = newId;
		for (const profile of Object.values(settings.fleet.profiles)) {
			if (profile.target === oldId) profile.target = newId;
		}
		settings.chat.modelPicker.cycleSet = settings.chat.modelPicker.cycleSet.map((entry) => {
			const [head, ...rest] = entry.split("/");
			if (head !== oldId) return entry;
			return rest.length === 0 ? newId : `${newId}/${rest.join("/")}`;
		});
	});
	printOk(`renamed ${oldId} to ${newId}`);
	return 0;
}

/**
 * The runtime configuration screens.
 *
 * Every screen is one `SectionSpec`: a title, the values it shows, and the
 * actions that change them. Rendering goes through the lifecycle presenter, so
 * `configure` degrades on a pipe and under NO_COLOR exactly as `reset`,
 * `upgrade`, and `uninstall` do. Navigation goes through `pickEntry`, which
 * uses the arrow-key selector on a terminal and the numbered readline prompt
 * everywhere else, so Escape leaves a screen without the screen having to teach
 * a token for it, and a scripted run still has a way to answer.
 */

interface SectionIo {
	rl: ReturnType<typeof createInterface>;
	out: NodeJS.WritableStream;
	/** Both ends of this run, for an action that opens a picker of its own. */
	streams: ConfigureStreams;
	/** Confirm one change on the transcript, in the presenter's voice. */
	ok: (text: string) => void;
}

interface SectionAction {
	label: string;
	hint?: string;
	run: (io: SectionIo) => Promise<void>;
}

interface SectionSpec {
	/** Canonical `--section` name. */
	id: string;
	title: string;
	/** What the main menu says this screen covers. */
	summary: string;
	/** Other spellings `--section` accepts. */
	aliases?: ReadonlyArray<string>;
	fields: () => Array<readonly [string, string]>;
	actions: ReadonlyArray<SectionAction>;
}

const NONE = "(none)";
const onOff = (value: boolean): string => (value ? "enabled" : "disabled");
const listOr = (values: ReadonlyArray<string>, fallback = NONE): string =>
	values.length > 0 ? values.join(", ") : fallback;

/** Read a bounded integer, leaving the setting alone when the answer is not one. */
async function askInteger(
	io: SectionIo,
	label: string,
	current: number,
	apply: (value: number) => void,
	min = 0,
): Promise<void> {
	const answer = await ask(io.rl, label, String(current));
	if (answer === null) return;
	const parsed = Number(answer);
	if (!Number.isFinite(parsed) || parsed < min) {
		io.out.write(`  ${label} must be a number of at least ${min}; left at ${current}\n`);
		return;
	}
	const value = Math.floor(parsed);
	apply(value);
	io.ok(`${label} set to ${value}`);
}

/** Read one of a fixed set of words, leaving the setting alone otherwise. */
async function askChoice(
	io: SectionIo,
	label: string,
	allowed: ReadonlyArray<string>,
	current: string,
	apply: (value: string) => void,
): Promise<void> {
	const answer = await ask(io.rl, `${label} [${allowed.join("|")}]`, current);
	if (answer === null) return;
	const value = answer.trim().toLowerCase();
	if (!allowed.includes(value)) {
		io.out.write(`  ${label} must be one of ${allowed.join(", ")}; left at ${current}\n`);
		return;
	}
	apply(value);
	io.ok(`${label} set to ${value}`);
}

const SECTIONS: ReadonlyArray<SectionSpec> = [
	{
		id: "targets",
		title: "Targets & Auth",
		summary: "providers, endpoints, credentials, models",
		aliases: ["auth", "target", "providers"],
		fields: () => {
			const settings = readSettings();
			const rows: Array<readonly [string, string]> = [
				["Chat target", `${settings.chat.target ?? NONE} (model: ${settings.chat.model ?? "target default"})`],
				[
					"Fleet target",
					`${settings.fleet.default.target ?? NONE} (model: ${settings.fleet.default.model ?? "target default"})`,
				],
			];
			if (settings.targets.length === 0) rows.push(["Registered", "(no targets registered)"]);
			else
				for (const target of settings.targets) {
					rows.push([
						`  ${target.id}`,
						`${target.runtime}, model ${target.defaultModel ?? "unset"}${
							settings.chat.target === target.id ? " [chat]" : ""
						}${settings.fleet.default.target === target.id ? " [fleet]" : ""}`,
					]);
				}
			return rows;
		},
		actions: [
			{
				label: "Add a target",
				hint: "register a provider endpoint",
				run: async (io) => {
					const runtime = await pickRuntimeViaCategory(io.rl);
					if (runtime) await runTargetSetupInteractive(io.rl, runtime, emptyArgs());
				},
			},
			{
				label: "Set the chat target",
				hint: "which target answers in chat",
				run: async (io) => {
					await assignTarget(io, "chat");
				},
			},
			{
				label: "Set the fleet default target",
				hint: "which target dispatched workers use",
				run: async (io) => {
					await assignTarget(io, "fleet");
				},
			},
			{
				label: "Remove a target",
				run: async (io) => {
					const settings = readSettings();
					const ids = settings.targets.map((target) => target.id);
					if (ids.length === 0) {
						io.out.write("  No targets to remove.\n");
						return;
					}
					io.out.write(`  Registered: ${ids.join(", ")}\n`);
					const chosen = await ask(io.rl, "Target id to remove");
					if (chosen === null || !ids.includes(chosen)) return;
					if (await askYesNo(io.rl, `Remove target '${chosen}'?`, false)) {
						runTargetRemove(chosen);
					}
				},
			},
		],
	},
	{
		id: "models",
		title: "Models & Thinking",
		summary: "default model, thinking level, favorites",
		aliases: ["model", "thinking"],
		fields: () => {
			const settings = readSettings();
			return [
				["Chat model", settings.chat.model ?? "(target default)"],
				["Chat thinking", settings.chat.thinkingLevel],
				["Fleet thinking", settings.fleet.default.thinkingLevel],
				["Favorites", listOr(settings.chat.modelPicker.favorites)],
				["Cycle set (Alt+J/K)", listOr(settings.chat.modelPicker.cycleSet)],
			];
		},
		actions: [
			{
				label: "Chat thinking level",
				hint: THINKING_LEVELS.join(" | "),
				run: async (io) => {
					await askChoice(io, "Chat thinking level", THINKING_LEVELS, readSettings().chat.thinkingLevel, (value) => {
						updateSettings((draft) => {
							draft.chat.thinkingLevel = value as ThinkingLevel;
						});
					});
				},
			},
			{
				label: "Fleet thinking level",
				hint: THINKING_LEVELS.join(" | "),
				run: async (io) => {
					await askChoice(
						io,
						"Fleet thinking level",
						THINKING_LEVELS,
						readSettings().fleet.default.thinkingLevel,
						(value) => {
							updateSettings((draft) => {
								draft.fleet.default.thinkingLevel = value as ThinkingLevel;
							});
						},
					);
				},
			},
			{
				label: "Chat default model",
				hint: "blank clears the override",
				run: async (io) => {
					const model = await ask(
						io.rl,
						"Chat default model (blank for the target default)",
						readSettings().chat.model ?? "",
					);
					if (model === null) return;
					updateSettings((draft) => {
						draft.chat.model = model.length > 0 ? model : null;
					});
					io.ok(model.length > 0 ? `Chat default model set to ${model}` : "Chat default model cleared");
				},
			},
			{
				label: "Model favorites",
				hint: "comma-separated",
				run: async (io) => {
					await askList(io, "Model favorites", readSettings().chat.modelPicker.favorites, (values) => {
						updateSettings((draft) => {
							draft.chat.modelPicker.favorites = values;
						});
					});
				},
			},
			{
				label: "Cycle set",
				hint: "comma-separated, Alt+J/K walks it",
				run: async (io) => {
					await askList(io, "Cycle set", readSettings().chat.modelPicker.cycleSet, (values) => {
						updateSettings((draft) => {
							draft.chat.modelPicker.cycleSet = values;
						});
					});
				},
			},
		],
	},
	{
		id: "chat",
		title: "Chat Defaults",
		summary: "streaming, progress, compaction",
		fields: () => {
			const settings = readSettings();
			return [
				["Smooth streaming", settings.interface.smoothStreaming],
				["Terminal progress", onOff(settings.interface.terminalProgress)],
				[
					"Max output tokens",
					settings.chat.maxOutputTokens > 0 ? String(settings.chat.maxOutputTokens) : "(runtime default)",
				],
				["Prompt prewarm", onOff(settings.chat.prewarm)],
				[
					"Auto-compaction",
					settings.context.compaction.auto
						? `enabled at ${Math.round(settings.context.compaction.threshold * 100)}%`
						: "disabled",
				],
				[
					"Working-set eviction",
					settings.context.workingSet.enabled ? `enabled (${settings.context.workingSet.policy})` : "disabled",
				],
			];
		},
		actions: [
			{
				label: "Smooth streaming",
				hint: "off | auto | on",
				run: async (io) => {
					await askChoice(
						io,
						"Smooth streaming",
						["off", "auto", "on"],
						readSettings().interface.smoothStreaming,
						(value) => {
							updateSettings((draft) => {
								draft.interface.smoothStreaming = value as SmoothStreaming;
							});
						},
					);
				},
			},
			{
				label: "Terminal progress indicator",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.interface.terminalProgress = !draft.interface.terminalProgress;
						next = draft.interface.terminalProgress;
					});
					io.ok(`Terminal progress ${onOff(next)}`);
				},
			},
			{
				label: "Max output tokens",
				hint: "0 for the runtime default",
				run: async (io) => {
					await askInteger(io, "Max output tokens", readSettings().chat.maxOutputTokens, (value) => {
						updateSettings((draft) => {
							draft.chat.maxOutputTokens = value;
						});
					});
				},
			},
			{
				label: "Prompt prewarm",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.chat.prewarm = !draft.chat.prewarm;
						next = draft.chat.prewarm;
					});
					io.ok(`Prompt prewarm ${onOff(next)}`);
				},
			},
			{
				label: "Auto-compaction",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.context.compaction.auto = !draft.context.compaction.auto;
						next = draft.context.compaction.auto;
					});
					io.ok(`Auto-compaction ${onOff(next)}`);
				},
			},
		],
	},
	{
		id: "fleet",
		title: "Fleet",
		summary: "concurrency, retries, worker timeouts",
		fields: () => {
			const settings = readSettings();
			return [
				["Concurrency limit", String(settings.fleet.concurrency)],
				["Max retries", String(settings.fleet.retry.maxRetries)],
				["Tool calls per run", String(settings.fleet.limits.toolCallsPerRun)],
				["Run timeout", `${settings.fleet.limits.internalRunTimeoutMs / 1000}s`],
				["Worker profiles", listOr(Object.keys(settings.fleet.profiles))],
				[
					"Subagent pins",
					listOr(Object.entries(settings.fleet.agentProfiles).map(([agent, profile]) => `${agent} -> ${profile}`)),
				],
				["Remote nodes", listOr(settings.fleet.nodes.map((node) => node.id))],
			];
		},
		actions: [
			{
				label: "Concurrency limit",
				hint: "auto, or a positive integer",
				run: async (io) => {
					const current = String(readSettings().fleet.concurrency);
					const answer = await ask(io.rl, "Concurrency limit [auto or a number]", current);
					if (answer === null) return;
					if (answer.trim().toLowerCase() === "auto") {
						updateSettings((draft) => {
							draft.fleet.concurrency = "auto";
						});
						io.ok("Concurrency limit set to auto");
						return;
					}
					const parsed = Number(answer);
					if (!Number.isFinite(parsed) || parsed < 1) {
						io.out.write(`  Concurrency limit must be auto or at least 1; left at ${current}\n`);
						return;
					}
					updateSettings((draft) => {
						draft.fleet.concurrency = Math.floor(parsed);
					});
					io.ok(`Concurrency limit set to ${Math.floor(parsed)}`);
				},
			},
			{
				label: "Max retries",
				run: async (io) => {
					await askInteger(io, "Max retries", readSettings().fleet.retry.maxRetries, (value) => {
						updateSettings((draft) => {
							draft.fleet.retry.maxRetries = value;
						});
					});
				},
			},
			{
				label: "Tool calls per run",
				run: async (io) => {
					await askInteger(
						io,
						"Tool calls per run",
						readSettings().fleet.limits.toolCallsPerRun,
						(value) => {
							updateSettings((draft) => {
								draft.fleet.limits.toolCallsPerRun = value;
							});
						},
						1,
					);
				},
			},
			{
				label: "Run timeout",
				hint: "seconds",
				run: async (io) => {
					const current = readSettings().fleet.limits.internalRunTimeoutMs / 1000;
					const answer = await ask(io.rl, "Run timeout in seconds", String(current));
					if (answer === null) return;
					const parsed = Number(answer);
					if (!Number.isFinite(parsed) || parsed < 1) {
						io.out.write(`  Run timeout must be at least 1 second; left at ${current}s\n`);
						return;
					}
					updateSettings((draft) => {
						draft.fleet.limits.internalRunTimeoutMs = Math.floor(parsed * 1000);
					});
					io.ok(`Run timeout set to ${Math.floor(parsed)}s`);
				},
			},
		],
	},
	{
		id: "permissions",
		title: "Permissions & Autonomy",
		summary: "autonomy level, worker permissions, cost limits",
		aliases: ["autonomy", "safety"],
		fields: () => {
			const settings = readSettings();
			return [
				["Autonomy level", settings.safety.autonomy],
				["Worker permissions", settings.fleet.permissions.mode],
				["Session cost limit", `$${settings.safety.limits.sessionCostUsd} USD`],
				["Turn tool budget", String(settings.safety.limits.chatToolCallsPerTurn)],
				["Review watchdog", onOff(settings.safety.review.enabled)],
			];
		},
		actions: [
			{
				label: "Autonomy level",
				hint: "interactive | assisted | auto-edit | full",
				run: async (io) => {
					io.out.write(
						"  interactive prompts for everything, assisted auto-reads and confirms writes,\n  auto-edit confirms only bash, full runs unattended.\n",
					);
					await askChoice(
						io,
						"Autonomy level",
						["interactive", "assisted", "auto-edit", "full"],
						readSettings().safety.autonomy,
						(value) => {
							updateSettings((draft) => {
								draft.safety.autonomy = value as AutonomyLevel;
							});
						},
					);
				},
			},
			{
				label: "Worker permission mode",
				hint: "deny | fail | escalate",
				run: async (io) => {
					await askChoice(
						io,
						"Worker permission mode",
						["deny", "fail", "escalate"],
						readSettings().fleet.permissions.mode,
						(value) => {
							updateSettings((draft) => {
								draft.fleet.permissions.mode = value as WorkerPermissionMode;
							});
						},
					);
				},
			},
			{
				label: "Session cost limit",
				hint: "USD",
				run: async (io) => {
					const current = readSettings().safety.limits.sessionCostUsd;
					const answer = await ask(io.rl, "Session cost limit in USD", String(current));
					if (answer === null) return;
					const parsed = Number(answer);
					if (!Number.isFinite(parsed) || parsed <= 0) {
						io.out.write(`  Session cost limit must be greater than 0; left at $${current}\n`);
						return;
					}
					updateSettings((draft) => {
						draft.safety.limits.sessionCostUsd = parsed;
					});
					io.ok(`Session cost limit set to $${parsed} USD`);
				},
			},
			{
				label: "Turn tool budget",
				run: async (io) => {
					await askInteger(
						io,
						"Turn tool budget",
						readSettings().safety.limits.chatToolCallsPerTurn,
						(value) => {
							updateSettings((draft) => {
								draft.safety.limits.chatToolCallsPerTurn = value;
							});
						},
						1,
					);
				},
			},
			{
				label: "Turn-end review watchdog",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.safety.review.enabled = !draft.safety.review.enabled;
						next = draft.safety.review.enabled;
					});
					io.ok(`Review watchdog ${onOff(next)}`);
				},
			},
		],
	},
	{
		id: "panes",
		title: "Panes & Layout",
		summary: "terminal panes, startup layout, display mode",
		aliases: ["layout", "interface", "pane"],
		fields: () => {
			const settings = readSettings();
			return [
				["Panes capability", settings.interface.panes.enabled],
				["Startup layout", settings.interface.panes.layout],
				["TUI mode", settings.interface.mode],
				["Output detail", settings.interface.outputDetail],
				["Desktop notifications", onOff(settings.interface.desktopNotifications)],
				["Git commit attribution", onOff(settings.integrations.git.commitAttribution)],
			];
		},
		actions: [
			{
				label: "Panes capability",
				hint: "off | auto | embedded",
				run: async (io) => {
					await askChoice(
						io,
						"Panes capability",
						["off", "auto", "embedded"],
						readSettings().interface.panes.enabled,
						(value) => {
							updateSettings((draft) => {
								draft.interface.panes.enabled = value as PanesSettings["enabled"];
							});
						},
					);
				},
			},
			{
				label: "Startup layout",
				hint: "off | workers | cockpit",
				run: async (io) => {
					await askChoice(
						io,
						"Startup layout",
						["off", "workers", "cockpit"],
						readSettings().interface.panes.layout,
						(value) => {
							updateSettings((draft) => {
								draft.interface.panes.layout = value as PanesSettings["layout"];
							});
						},
					);
				},
			},
			{
				label: "TUI mode",
				hint: "regular | fullscreen",
				run: async (io) => {
					await askChoice(io, "TUI mode", ["regular", "fullscreen"], readSettings().interface.mode, (value) => {
						updateSettings((draft) => {
							draft.interface.mode = value as TuiMode;
						});
					});
				},
			},
			{
				label: "Output detail",
				hint: "minimal | default | verbose",
				run: async (io) => {
					await askChoice(
						io,
						"Output detail",
						["minimal", "default", "verbose"],
						readSettings().interface.outputDetail,
						(value) => {
							updateSettings((draft) => {
								draft.interface.outputDetail = value as OutputVerbosity;
							});
						},
					);
				},
			},
			{
				label: "Desktop notifications",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.interface.desktopNotifications = !draft.interface.desktopNotifications;
						next = draft.interface.desktopNotifications;
					});
					io.ok(`Desktop notifications ${onOff(next)}`);
				},
			},
			{
				label: "Git commit attribution",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.integrations.git.commitAttribution = !draft.integrations.git.commitAttribution;
						next = draft.integrations.git.commitAttribution;
					});
					io.ok(`Git commit attribution ${onOff(next)}`);
				},
			},
		],
	},
	{
		id: "skills",
		title: "Skills & Extensions",
		summary: "project imports, ACP peers, plugins",
		aliases: ["extensions", "skill", "interop"],
		fields: () => {
			const settings = readSettings();
			const rows: Array<readonly [string, string]> = [
				["Trust project imports", settings.integrations.projectResources.trustProjectImports ? "trusted" : "untrusted"],
				["External ACP agents", String(settings.integrations.externalAgents.entries.length)],
			];
			for (const agent of settings.integrations.externalAgents.entries) {
				rows.push([`  ${agent.id}`, `${agent.command} (governance: ${agent.toolGovernance ?? "default"})`]);
			}
			rows.push(
				["Runtime plugins", listOr(settings.integrations.runtimePlugins)],
				["Library remote sync", onOff(settings.integrations.library.sync)],
			);
			return rows;
		},
		actions: [
			{
				label: "Trust project imports",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.integrations.projectResources.trustProjectImports =
							!draft.integrations.projectResources.trustProjectImports;
						next = draft.integrations.projectResources.trustProjectImports;
					});
					io.ok(`Project imports ${next ? "trusted" : "untrusted"}`);
				},
			},
			{
				label: "Review external ACP agents",
				hint: "runs the interop review",
				run: async (io) => {
					await runInteropReview({ rl: io.rl, streams: io.streams });
				},
			},
			{
				label: "Library remote sync",
				hint: "toggle",
				run: async (io) => {
					let next = false;
					updateSettings((draft) => {
						draft.integrations.library.sync = !draft.integrations.library.sync;
						next = draft.integrations.library.sync;
					});
					io.ok(`Library remote sync ${onOff(next)}`);
				},
			},
		],
	},
	{
		id: "diagnostics",
		title: "Diagnostics",
		summary: "version, directories, doctor, raw settings",
		aliases: ["doctor", "diag"],
		fields: () => {
			const dirs = resolveClioDirs();
			const info = getVersionInfo();
			return [
				["Clio Coder", info.clio],
				["Node.js", info.node],
				["Platform", info.platform],
				["Config dir", shortenPath(dirs.config)],
				["Data dir", shortenPath(dirs.data)],
				["State dir", shortenPath(dirs.state)],
				["Cache dir", shortenPath(dirs.cache)],
			];
		},
		actions: [
			{
				label: "Run doctor",
				hint: "read-only health check",
				run: async () => {
					const { runDoctorCommand } = await import("./doctor.js");
					await runDoctorCommand([]);
				},
			},
			{
				label: "Show raw settings.yaml",
				run: async (io) => {
					const file = settingsPath();
					if (!existsSync(file)) {
						io.out.write("  settings.yaml does not exist yet.\n");
						return;
					}
					io.out.write(`\n--- ${shortenPath(file)} ---\n${readFileSync(file, "utf8")}--- end ---\n`);
				},
			},
		],
	},
];

/** A `ParsedArgs` with nothing set, for the target wizard called from a section. */
function emptyArgs(): ParsedArgs {
	return {
		positional: [],
		help: false,
		list: false,
		all: false,
		interop: false,
		json: false,
		force: false,
		gateway: false,
		setOrchestrator: false,
		setBackground: false,
		setWorkerDefault: false,
	};
}

async function askList(
	io: SectionIo,
	label: string,
	current: ReadonlyArray<string>,
	apply: (values: string[]) => void,
): Promise<void> {
	const answer = await ask(io.rl, `${label} (comma-separated, blank clears)`, current.join(", "));
	if (answer === null) return;
	const values = answer
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	apply(values);
	io.ok(values.length === 0 ? `${label} cleared` : `${label} set to ${values.join(", ")}`);
}

async function assignTarget(io: SectionIo, role: "chat" | "fleet"): Promise<void> {
	const settings = readSettings();
	const ids = settings.targets.map((target) => target.id);
	if (ids.length === 0) {
		io.out.write("  No targets registered yet. Add one first.\n");
		return;
	}
	io.out.write(`  Registered: ${ids.join(", ")}\n`);
	const currentTarget = role === "chat" ? settings.chat.target : settings.fleet.default.target;
	const chosen = await ask(io.rl, `${role === "chat" ? "Chat" : "Fleet"} target id`, currentTarget ?? ids[0] ?? "");
	if (chosen === null) return;
	if (!ids.includes(chosen)) {
		io.out.write(`  ${chosen} is not a registered target; nothing changed.\n`);
		return;
	}
	const target = settings.targets.find((entry) => entry.id === chosen);
	const model = await ask(io.rl, "Model (blank for the target default)", target?.defaultModel ?? "");
	if (model === null) return;
	updateSettings((draft) => {
		if (role === "chat") {
			draft.chat.target = chosen;
			draft.chat.model = model.length > 0 ? model : null;
		} else {
			draft.fleet.default.target = chosen;
			draft.fleet.default.model = model.length > 0 ? model : null;
		}
	});
	io.ok(`${role === "chat" ? "Chat" : "Fleet"} target set to ${chosen}`);
}

interface MenuEntry {
	label: string;
	hint?: string;
}

type MenuChoice = { kind: "index"; index: number } | { kind: "back" } | { kind: "quit" };

/**
 * Pick one entry, by arrow keys on a terminal and by number everywhere else.
 * The numbered fallback is not a lesser path: it is what a recorded session, a
 * pipe, and a dumb terminal get, and it accepts the same `b`/`q` tokens the rest
 * of this CLI uses.
 */
async function pickEntry(
	rl: ReturnType<typeof createInterface>,
	io: ConfigureStreams,
	entries: ReadonlyArray<MenuEntry>,
	backLabel: string,
	plain: boolean,
): Promise<MenuChoice> {
	const out = io.out;
	if (canSelect(io.in as NodeJS.ReadStream, out as NodeJS.WriteStream)) {
		const result = await promptSelect({
			choices: entries.map((entry, index) => ({
				value: index,
				label: entry.label,
				...(entry.hint === undefined ? {} : { hint: entry.hint }),
			})),
			railPrefix: railPrefix(plain),
			backLabel,
			input: io.in as NodeJS.ReadStream,
			output: out as NodeJS.WriteStream,
		});
		if (result.kind === "selected") return { kind: "index", index: result.value };
		return result.kind === "quit" ? { kind: "quit" } : { kind: "back" };
	}

	const rail = railPrefix(plain);
	entries.forEach((entry, index) => {
		out.write(`${rail}${index + 1}. ${entry.label}${entry.hint === undefined ? "" : `  (${entry.hint})`}\n`);
	});
	out.write(`${rail}b. ${backLabel}\n${rail}q. Quit\n`);
	const answer = await ask(rl, "\nSelection", "b");
	if (answer === null) return { kind: "quit" };
	const trimmed = answer.trim().toLowerCase();
	if (trimmed === "b" || trimmed === "back" || trimmed.length === 0) return { kind: "back" };
	if (trimmed === "q" || trimmed === "quit") return { kind: "quit" };
	const index = Number.parseInt(trimmed, 10) - 1;
	if (Number.isInteger(index) && index >= 0 && index < entries.length) return { kind: "index", index };
	out.write(`${rail}Not one of the choices: ${answer}\n`);
	return { kind: "back" };
}

/** Header, source file, and current values for one screen. */
function renderSection(spec: SectionSpec, out: NodeJS.WritableStream): LifecyclePresenter {
	const presenter = createLifecyclePresenter({ stream: out });
	presenter.header(spec.title, "configure");
	presenter.note(`Source: ${shortenPath(settingsPath())}`);
	presenter.fields(spec.fields());
	return presenter;
}

/** Show one screen and stay on it until the operator leaves or quits. */
async function runSection(
	rl: ReturnType<typeof createInterface>,
	streams: ConfigureStreams,
	spec: SectionSpec,
	backLabel: string,
): Promise<"back" | "quit"> {
	for (;;) {
		const presenter = renderSection(spec, streams.out);
		const io: SectionIo = {
			rl,
			out: streams.out,
			streams,
			ok: (text) => {
				presenter.completedStep(text);
			},
		};
		presenter.blank();
		const choice = await pickEntry(rl, streams, spec.actions, backLabel, presenter.isPlain());
		if (choice.kind !== "index") return choice.kind;
		const action = spec.actions[choice.index];
		if (action !== undefined) await action.run(io);
	}
}

/** The top-level screen. Leaving it is an ordinary exit, not a cancellation. */
async function runConfigSectionsMenu(
	rl: ReturnType<typeof createInterface>,
	streams: ConfigureStreams,
): Promise<number> {
	for (;;) {
		const presenter = createLifecyclePresenter({ stream: streams.out });
		presenter.header("Clio Coder Configuration", "configure");
		presenter.note(`Source: ${shortenPath(settingsPath())}`);
		presenter.blank();
		const choice = await pickEntry(
			rl,
			streams,
			SECTIONS.map((section) => ({ label: section.title, hint: section.summary })),
			"quit",
			presenter.isPlain(),
		);
		// Escape and q both leave the top screen, and leaving a settings menu you
		// only looked at is not a failure: this used to exit 130 and print
		// "error: configuration cancelled" over a run that did exactly what was
		// asked. The first-run wizard still exits 130, because there a cancel
		// really does leave Clio unconfigured.
		if (choice.kind !== "index") return 0;
		const spec = SECTIONS[choice.index];
		if (spec === undefined) continue;
		if ((await runSection(rl, streams, spec, "back")) === "quit") return 0;
	}
}

/** Resolve a `--section` value to exactly one screen, by id or listed alias. */
function findSection(name: string): SectionSpec | undefined {
	const wanted = name.trim().toLowerCase();
	return SECTIONS.find((section) => section.id === wanted || (section.aliases ?? []).includes(wanted));
}

const SECTION_IDS: ReadonlyArray<string> = SECTIONS.map((section) => section.id);

/** The streams this run reads from and writes to, which the tests replace. */
interface ConfigureStreams {
	in: NodeJS.ReadableStream;
	out: NodeJS.WritableStream;
}

async function runInteractive(
	rl: ReturnType<typeof createInterface>,
	preselectedRuntime: RuntimeDescriptor | null,
	defaults: ParsedArgs,
	streams: ConfigureStreams,
): Promise<number> {
	if (preselectedRuntime) {
		return await runTargetSetupInteractive(rl, preselectedRuntime, defaults);
	}

	if (defaults.section !== undefined) {
		const spec = findSection(defaults.section);
		if (spec === undefined) {
			printError(`unknown section: ${defaults.section}. Sections: ${SECTION_IDS.join(", ")}`);
			return 2;
		}
		// Without a terminal there is nobody to answer, and printing a prompt into
		// a pipe is a dead end that reads as a hang. The screen is still worth
		// showing, so a scripted `configure --section fleet` is a read of that
		// section rather than a refusal.
		if ((streams.in as { isTTY?: boolean }).isTTY !== true) {
			renderSection(spec, streams.out).done("Done");
			return 0;
		}
		await runSection(rl, streams, spec, "quit");
		return 0;
	}

	if (readSettings().targets.length === 0) {
		// The first run is its own screen flow. It only exists where a keypress can
		// be read; a pipe, a recorded session, and a dumb terminal keep the
		// numbered readline path below, which is still the only way to answer them.
		//
		// The readline interface is closed first. Left open it stays subscribed to
		// stdin's keypresses and echoes each one, which puts a stray line under
		// every menu the wizard draws and breaks the erase that replaces the menu
		// with its answer. The wizard opens its own where a browser sign-in needs
		// one.
		if (canRunOnboarding(streams)) {
			rl.close();
			return await runOnboardingWizard(streams);
		}
		const runtime = await pickRuntimeViaCategory(rl);
		if (!runtime) {
			printError("configuration cancelled");
			return 130;
		}
		return await runTargetSetupInteractive(rl, runtime, defaults);
	}

	return await runConfigSectionsMenu(rl, streams);
}

export async function runConfigureCommand(
	argv: ReadonlyArray<string>,
	inStream: NodeJS.ReadableStream = input,
	outStream: NodeJS.WritableStream = output,
): Promise<number> {
	let args: ParsedArgs;
	try {
		args = parseSetupArgs(argv);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		process.stdout.write(HELP);
		return 2;
	}
	if (args.help) {
		process.stdout.write(HELP);
		return 0;
	}
	initializeClioHome();
	ensureRegistryPopulated();

	if (args.json) {
		const settings = readSettings();
		outStream.write(`${JSON.stringify(settings, null, 2)}\n`);
		return 0;
	}

	if (args.list) {
		printRuntimeList(args.all);
		return 0;
	}
	if (args.interop) {
		if (!input.isTTY) return runInteropReview({ rl: null });
		const rl = createInterface({ input, output });
		try {
			return await runInteropReview({ rl, streams: { in: input, out: output } });
		} finally {
			rl.close();
		}
	}
	if (args.remove) return runTargetRemove(args.remove);
	if (args.renameOld && args.renameNew) return runTargetRename(args.renameOld, args.renameNew);

	if (args.positional.length > 0) {
		printError(
			"`clio-coder configure` accepts flags, not positional runtimes. Use `clio-coder auth login <runtime>` first when authentication is needed, then `clio-coder configure --runtime <runtimeId> ...`.",
		);
		return 2;
	}

	const runtimeId = args.runtime;
	let runtime: RuntimeDescriptor | null = null;
	if (runtimeId) {
		runtime = getRuntimeRegistry().get(runtimeId);
		if (!runtime) {
			printError(`unknown runtime id: ${runtimeId}`);
			process.stdout.write("run `clio-coder configure --list` to see registered runtimes\n");
			return 2;
		}
		if (runtimeId === "lmstudio-native" && runtime.id === "lmstudio") {
			process.stderr.write("warning: runtime 'lmstudio-native' is deprecated; using 'lmstudio'\n");
		}
	}
	const hasTargetSetupFlag =
		args.id !== undefined ||
		args.url !== undefined ||
		args.model !== undefined ||
		args.workerProfile !== undefined ||
		args.workerProfileModel !== undefined ||
		args.apiKey !== undefined ||
		args.apiKeyEnv !== undefined ||
		args.gateway ||
		args.lifecycle !== undefined ||
		args.setOrchestrator ||
		args.setWorkerDefault ||
		args.contextWindow !== undefined ||
		args.maxTokens !== undefined ||
		args.reasoning !== undefined;
	const nonInteractive = runtime !== null && hasTargetSetupFlag;

	if (nonInteractive && runtime) return runNonInteractive(runtime, args);

	// Setup flags were supplied but the non-interactive spec is incomplete
	// (missing --runtime, or a --runtime with no target flags). On a
	// non-interactive stdin the wizard below would read EOF, take the default
	// answers, write the initial settings template, and exit 0 without
	// configuring the requested target. Reject with the missing half instead.
	if ((runtimeId !== undefined || hasTargetSetupFlag) && !input.isTTY) {
		printError(
			runtime === null
				? "--runtime is required when configuring a target non-interactively"
				: "--id is required when passing flags non-interactively",
		);
		return 2;
	}

	const rl = createInterface({ input: inStream, output: outStream });
	try {
		return await runInteractive(rl, runtime, args, { in: inStream, out: outStream });
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 1;
	} finally {
		rl.close();
	}
}
