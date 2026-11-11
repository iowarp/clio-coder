/**
 * The first screen a new user sees.
 *
 * `clio-coder configure` on an unconfigured home used to be a column of
 * readline questions: a numbered category menu, a numbered runtime menu, four
 * typed values, a paragraph explaining four credential words before asking for
 * one of them, and a run of `[y/N]` questions with no way back. The settings
 * menus had already moved to the arrow-key picker and the lifecycle rail; this
 * is the same treatment for the path that comes before them.
 *
 * The flow is a list of steps with a cursor. Each step draws its prompt, erases
 * it once answered, and leaves one row on the rail saying what was chosen, so
 * the screen is the answers so far plus the question at hand. Escape moves the
 * cursor back one step and rewinds the rail to that step's row, which is what
 * keeps target edits in a draft until Save. Browser sign-in stores credentials
 * when it succeeds; optional peer review has its own save after target setup.
 *
 * Steps that do not apply are stepped over in whichever direction the cursor is
 * moving, so a runtime with no URL and no credential is three questions and a
 * model, and backing out of the model step lands on the runtime rather than on
 * a prompt that was never shown.
 */

import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { ClioSettings } from "../core/config.js";
import {
	readSettings,
	SettingsValidationError,
	settingsPath,
	updateSettings,
	validateSettings,
} from "../core/config.js";
import type { ThinkingLevel } from "../core/defaults.js";
import { THINKING_LEVELS } from "../core/defaults.js";
import { initializeClioHome } from "../core/init.js";
import { ensureClaudeAgentSdk } from "../domains/lifecycle/claude-sdk-install.js";
import type { Candidate } from "../domains/lifecycle/setup-status.js";
import { authStoragePath, openAuthStorage, targetRequiresAuth } from "../domains/providers/auth/index.js";
import { prepareCopilotSdk } from "../domains/providers/copilot-setup.js";
import type { ProviderSupportEntry } from "../domains/providers/index.js";
import {
	buildProviderSupportEntry,
	isOrchestratorEligibleRuntime,
	listProviderSupportEntries,
	recordTargetCheck,
	recordTargetModelSnapshot,
	resolveRuntimeAuthTarget,
	runtimeListsModelsLive,
} from "../domains/providers/index.js";
import { fingerprintNativeRuntime } from "../domains/providers/probe/fingerprint.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { greetLmStudio } from "../domains/providers/runtimes/common/lmstudio-http.js";
import type { ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { observeHostCapacityFacts, resolveLocalConcurrency } from "../domains/scheduling/local-capacity.js";
import type { ChatTestOutcome, SendChatTest } from "./chat-test.js";
import { chatTestFix, sendChatTest } from "./chat-test.js";
import type { ConfigureWizardHost } from "./configure-host.js";
import { commitImport, describeImport, importChangesNothing, prepareImport } from "./configure-import.js";
import type { ConfigureCategory } from "./configure-layout.js";
import { CONFIGURE_CATEGORY_CHOICES } from "./configure-layout.js";
import { loginOAuthRuntime } from "./configure-oauth.js";
import type { WireModelInventory } from "./configure-target.js";
import {
	applyTarget,
	assertOrchestratorReplacementEligible,
	buildDescriptor,
	chatPickerModels,
	contextWindowUndiscovered,
	deriveTargetId,
	describeAuthStatus,
	gatewayUrlGuidance,
	inventoryGap,
	inventoryNote,
	isUntrustedCertificate,
	LOCAL_APP_RUNTIME_IDS,
	modelChoiceRefusal,
	modelSupportsThinking,
	normalizeUrl,
	offeredUrlFor,
	PROTOCOL_COMPAT_RUNTIME_IDS,
	plainConnectionProblem,
	preferredModelFor,
	probeReadings,
	railPrefix,
	resolveSupportedWireModels,
	runtimeProbe,
	runtimesForCategory,
	setOrchestratorPointer,
	setWorkerDefaultPointer,
	targetApiKeyRef,
	targetUrlProblem,
} from "./configure-target.js";
import { offerCopilotSignIn } from "./copilot-sign-in.js";
import type { DetectedChatRoute } from "./detect-chat-routes.js";
import { inferKeyProvider } from "./key-prefix.js";
import type { LifecyclePresenter } from "./lifecycle-presenter.js";
import { createLifecyclePresenter, shortenPath } from "./lifecycle-presenter.js";
import { canSelect, promptSelect, promptText } from "./select.js";
import { credentialWriteFailed } from "./shared.js";
import { truncate } from "./text-layout.js";

export interface OnboardingStreams {
	in: NodeJS.ReadableStream;
	out: NodeJS.WritableStream;
}

/**
 * Whether the wizard can run at all. Without a terminal on both ends there is
 * nothing to read a keypress from, and the caller keeps the numbered readline
 * flow, exactly as the settings menus do.
 */
export function canRunOnboarding(streams: OnboardingStreams): boolean {
	return canSelect(streams.in as NodeJS.ReadStream, streams.out as NodeJS.WriteStream);
}

/** Every answer row uses this label column, so the values line up down the rail. */
const LABEL_WIDTH = 11;

type CredentialSource = "env" | "stored" | "keep" | "skip" | "oauth-connect" | "oauth-skip";

// Every field is `| undefined` on purpose, not decoratively: the repo compiles
// with exactOptionalPropertyTypes, and going back a step clears the answers
// that depended on the one being changed by assigning undefined to them.
interface Answers {
	mode: "first" | "add" | "edit";
	/** Routes Clio found before the first question, best first; only the first-run flow offers them. */
	offered: ReadonlyArray<OfferedRoute>;
	detectedChatRoute?: DetectedChatRoute | undefined;
	/** The first-run flow's "What do you have?" answer. */
	have?: Have | undefined;
	/** The key screen supplied the credential, so the credential screens are not asked. */
	keyGiven?: boolean | undefined;
	/** The provider the key itself named, by its prefix or its variable, so the provider list is not asked. */
	keyProvider?: string | undefined;
	/** The setup file's path or address, kept so Back from its review shows it again. */
	setupSource?: string | undefined;
	/** The review's "Choose a different model" asked for the list the flow otherwise skips. */
	chooseModel?: boolean | undefined;
	fixedRuntime?: boolean;
	existing?: TargetDescriptor | undefined;
	contextWindow?: number | undefined;
	category?: ConfigureCategory | undefined;
	runtime?: RuntimeDescriptor | undefined;
	targetId?: string | undefined;
	url?: string | undefined;
	/** Native runtime the URL turned out to be serving, when it is not the chosen one. */
	detected?: { runtimeId: string; displayName: string } | undefined;
	credential?: CredentialSource | undefined;
	/** A local server answered 401 or 403, so the credential question it skipped is now asked. */
	keyRequested?: boolean | undefined;
	/** The address step sent the operator to the credential step; its address is checked again, not asked again. */
	recheckUrl?: boolean | undefined;
	apiKeyEnv?: string | undefined;
	apiKeyLiteral?: string | undefined;
	inventory?: WireModelInventory | undefined;
	/** The inputs the cached inventory was read for, so a changed URL re-reads it. */
	inventoryKey?: string | undefined;
	model?: string | undefined;
	thinking?: ThinkingLevel | undefined;
	probe?: ProbeResult | null | undefined;
	/** The address step's failure, when it already told the operator why the model list will not come. */
	unreachable?: string | undefined;
	/** The sign-in was put off or failed, so the wizard ends with nothing saved and names the login command. */
	signInLater?: string | undefined;
	/** The test request before Save: how long the model took to answer, or "skipped" when saved anyway. */
	tested?: { latencyMs: number } | "skipped" | undefined;
}

type StepOutcome = "next" | "back" | "quit" | "cancel" | "credential" | "detected" | "model" | "imported" | "fix";

type Have = "key" | "subscription" | "server" | "file";

/** A route `collectSetupCandidates` found, with the runtime it runs on. */
interface OfferedRoute extends DetectedChatRoute {
	kind: Candidate<TargetDescriptor>["source"];
	owner?: string;
}

/** `configure` with no runtime on a home with no target: the flow that asks what the user has. */
function firstRunFlow(answers: Answers): boolean {
	return answers.mode === "first" && !answers.fixedRuntime;
}

interface Wizard {
	/** The loop is stepping back, so a step that would answer itself hands the cursor on instead. */
	goingBack: boolean;
	select: ConfigureWizardHost["select"];
	text: ConfigureWizardHost["text"];
	host?: ConfigureWizardHost;
	streams: OnboardingStreams;
	presenter: LifecyclePresenter;
	rail: string;
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	/** The caller starts the chat session as soon as this returns, so the wizard does not tell the user how to. */
	startsChat: boolean;
	/** Row on the rail, at the wizard's shared label column. */
	answer: (label: string, value: string) => void;
	/** Save first sends one short test request; null when this run saves without one. */
	sendTest: SendChatTest | null;
}

interface Step {
	id: string;
	applies: (answers: Answers) => boolean;
	run: (wizard: Wizard, answers: Answers) => Promise<StepOutcome>;
}

/**
 * The presenter's stream, counting the lines that went through it.
 *
 * Going back a step has to erase the row the step left behind, and the only
 * honest way to know how many lines that is, is to count what was written. The
 * pickers are not counted because they erase their own frame before returning.
 */
interface RailWriter {
	stream: NodeJS.WritableStream;
	mark: () => number;
	rewindTo: (mark: number) => void;
}

function railWriter(out: NodeJS.WritableStream): RailWriter {
	let lines = 0;
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			for (const char of text) if (char === "\n") lines += 1;
			return out.write(chunk);
		},
		isTTY: (out as { isTTY?: boolean }).isTTY,
		columns: (out as { columns?: number }).columns,
	} as unknown as NodeJS.WritableStream;
	return {
		stream,
		mark: () => lines,
		rewindTo(mark) {
			const back = lines - mark;
			if (back > 0) out.write(`\u001B[${back}A\u001B[0J`);
			lines = mark;
		},
	};
}

function supportFor(runtime: RuntimeDescriptor): ProviderSupportEntry {
	return buildProviderSupportEntry(runtime);
}

function allEntries(): ProviderSupportEntry[] {
	return listProviderSupportEntries(getRuntimeRegistry().list());
}

/** The descriptor as it stands mid-wizard, for a probe or a model read. */
function draftDescriptor(answers: Answers, runtime: RuntimeDescriptor, withModel: boolean): TargetDescriptor {
	if (answers.detectedChatRoute) {
		const target = structuredClone(answers.detectedChatRoute.target);
		if (withModel && answers.model) target.defaultModel = answers.model;
		else delete target.defaultModel;
		return target;
	}
	const apiKeyRef =
		answers.credential === "stored"
			? targetApiKeyRef(answers.targetId ?? runtime.id, readSettings().targets)
			: answers.credential === "keep"
				? (answers.existing?.auth?.apiKeyRef ?? runtime.id)
				: undefined;
	const configured = buildDescriptor(runtime, answers.targetId ?? runtime.id, {
		...(answers.url !== undefined ? { url: answers.url } : {}),
		...(withModel && answers.model !== undefined ? { model: answers.model } : {}),
		...(answers.apiKeyEnv !== undefined ? { apiKeyEnv: answers.apiKeyEnv } : {}),
		...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
		...(runtime.auth === "oauth"
			? { oauthProfile: answers.existing?.auth?.oauthProfile ?? runtime.oauthProviderId ?? runtime.id }
			: {}),
	});
	const sameRuntime = answers.existing?.runtime === runtime.id;
	const descriptor = { ...(sameRuntime ? answers.existing : {}), ...configured };
	if (!supportFor(runtime).supportsCustomUrl) delete descriptor.url;
	if (!withModel) delete descriptor.defaultModel;
	if ((sameRuntime && answers.existing?.auth) || configured.auth) {
		descriptor.auth = { ...(sameRuntime ? answers.existing?.auth : {}), ...configured.auth };
		if (runtime.auth === "api-key") {
			if (answers.credential !== "env") delete descriptor.auth.apiKeyEnvVar;
			if (answers.credential !== "stored" && answers.credential !== "keep") delete descriptor.auth.apiKeyRef;
		}
		if (Object.keys(descriptor.auth).length === 0) delete descriptor.auth;
	}
	return descriptor;
}

/** Rows of the first-run list, saying where each route came from in the user's words. */
function offeredRow(route: OfferedRoute): { label: string; hint: string } {
	const name = route.runtime.displayName;
	const label =
		route.kind === "env-key"
			? `${name}, with the key in ${route.source}`
			: route.kind === "stored-login"
				? `${name}, ${route.runtime.auth === "oauth" ? "signed in" : "stored key"}`
				: route.kind === "configured-target"
					? `${name}, saved in your settings`
					: route.kind === "project"
						? `${name}, from this project's settings`
						: `A model server at ${route.target.url ?? route.source} (${name})`;
	const model =
		route.model === undefined
			? "choose a model next"
			: route.model === supportFor(route.runtime).defaultModel
				? `model ${route.model} (recommended)`
				: `model ${route.model}`;
	return { label, hint: route.owner ? `${model}, run by user ${route.owner}` : model };
}

/** Forget every connection answer, for a first-run choice that starts a different path. */
function clearConnection(answers: Answers): void {
	answers.detectedChatRoute = undefined;
	answers.category = undefined;
	answers.runtime = undefined;
	answers.targetId = undefined;
	answers.url = undefined;
	answers.detected = undefined;
	answers.credential = undefined;
	answers.keyRequested = undefined;
	answers.keyGiven = undefined;
	answers.keyProvider = undefined;
	answers.apiKeyEnv = undefined;
	answers.apiKeyLiteral = undefined;
	answers.model = undefined;
	answers.chooseModel = undefined;
	answers.thinking = undefined;
	answers.contextWindow = undefined;
	answers.probe = undefined;
	answers.inventory = undefined;
	answers.inventoryKey = undefined;
	answers.unreachable = undefined;
}

/** Screen 1 when Clio found something: each route it found, best first, and a way out to the rest. */
const OFFERED_STEP: Step = {
	id: "offered",
	applies: (answers) => firstRunFlow(answers) && answers.offered.length > 0,
	run: async (wizard, answers) => {
		const chosen = answers.detectedChatRoute;
		const previous = chosen ? answers.offered.findIndex((route) => route.target === chosen.target) : -1;
		const result = await wizard.select<OfferedRoute | "other">({
			heading: ["", chalk.bold("Clio found a way to reach a model:")],
			choices: [
				...answers.offered.map((route) => ({ value: route, ...offeredRow(route) })),
				{ value: "other" as const, label: "Set up something else", hint: "an API key, a subscription, or a server" },
			],
			// The row says where the route came from in full; the hint is only the model.
			maxLabelWidth: 56,
			initialIndex: previous >= 0 ? previous : answers.detectedChatRoute || answers.have ? answers.offered.length : 0,
			railPrefix: wizard.rail,
			backLabel: "cancel",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (result.value === "other") {
			if (answers.detectedChatRoute) clearConnection(answers);
			return "next";
		}
		const route = result.value;
		clearConnection(answers);
		answers.have = undefined;
		answers.detectedChatRoute = route;
		answers.runtime = route.runtime;
		answers.targetId = route.target.id;
		answers.url = route.target.url;
		answers.model = route.model;
		answers.apiKeyEnv = route.target.auth?.apiKeyEnvVar;
		answers.credential = answers.apiKeyEnv ? "env" : route.target.auth?.apiKeyRef ? "keep" : undefined;
		answers.contextWindow = route.target.capabilities?.contextWindow;
		answers.probe = route.kind === "local-server" ? { ok: true, models: route.model ? [route.model] : [] } : undefined;
		answers.inventory = { models: route.model ? [route.model] : [], source: answers.probe ? "probe" : "catalog" };
		wizard.answer("Using", offeredRow(route).label);
		// A detected Copilot login is re-read here, so the line naming the account it uses is shown.
		if (route.runtime.id === "copilot-sdk") {
			const ready = await COPILOT_STEP.run(wizard, answers);
			if (ready !== "next") return ready;
		}
		return "detected";
	},
};

const HAVE_CHOICES: ReadonlyArray<{ value: Have; label: string; hint: string }> = [
	{
		value: "key",
		label: "An API key",
		hint: "Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, and others",
	},
	{ value: "subscription", label: "A subscription", hint: "ChatGPT Plus or Pro, Claude Pro or Max, GitHub Copilot" },
	{
		value: "server",
		label: "A model server or gateway",
		hint: "Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, or any OpenAI-compatible address",
	},
	{ value: "file", label: "A setup file from my lab or team", hint: "a path or https address someone gave you" },
];

/** Screen 1 when Clio found nothing, or the user wants something else: what they have, in their words. */
const HAVE_STEP: Step = {
	id: "have",
	applies: (answers) => firstRunFlow(answers) && answers.detectedChatRoute === undefined,
	run: async (wizard, answers) => {
		const previous = HAVE_CHOICES.findIndex((choice) => choice.value === answers.have);
		const result = await wizard.select<Have>({
			heading: ["", chalk.bold("What do you have?")],
			choices: HAVE_CHOICES.map((choice) => ({ ...choice })),
			initialIndex: Math.max(0, previous),
			railPrefix: wizard.rail,
			backLabel: answers.offered.length > 0 ? "back" : "cancel",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (answers.have !== result.value) {
			clearConnection(answers);
			answers.have = result.value;
		}
		const registry = getRuntimeRegistry();
		if (result.value === "subscription") answers.category = "subscription";
		if (result.value === "server") {
			const runtime = registry.get("openai-compat") ?? undefined;
			if (runtime && answers.runtime === undefined) {
				answers.runtime = runtime;
				answers.targetId = deriveTargetId(runtime.id, readSettings().targets);
			}
		}
		wizard.answer("You have", HAVE_CHOICES.find((choice) => choice.value === result.value)?.label ?? result.value);
		return "next";
	},
};

const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u;

/** The API-key path: one masked field; a known prefix names the provider, `$NAME` reads an environment variable. */
const KEY_STEP: Step = {
	id: "key",
	applies: (answers) => firstRunFlow(answers) && answers.have === "key",
	run: async (wizard, answers) => {
		const result = await wizard.text({
			heading: [
				"",
				chalk.bold("Paste your API key"),
				chalk.dim(`Saved to ${shortenPath(authStoragePath())} (mode 0600, not encrypted) when you save.`),
			],
			initial: answers.apiKeyEnv !== undefined ? `$${answers.apiKeyEnv}` : "",
			hint: "or type $NAME to read the key from that environment variable instead",
			mask: true,
			validate: (value) =>
				value.trim().length === 0
					? "Paste a key, or type $NAME to use an environment variable."
					: value.startsWith("$") && !ENV_REFERENCE.test(value.trim())
						? "After $, an environment variable name holds only letters, digits and underscores."
						: null,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const value = result.value.trim();
		const variable = ENV_REFERENCE.exec(value)?.[1];
		const registry = getRuntimeRegistry();
		let provider: string | undefined;
		if (variable !== undefined) {
			answers.credential = "env";
			answers.apiKeyEnv = variable;
			answers.apiKeyLiteral = undefined;
			provider =
				inferKeyProvider(process.env[variable] ?? "") ??
				registry.list().find((runtime) => runtime.auth === "api-key" && runtime.credentialsEnvVar === variable)?.id;
			wizard.answer("Key", `$${variable}${process.env[variable] ? "" : chalk.dim("  (not set in this shell)")}`);
		} else {
			answers.credential = "stored";
			answers.apiKeyEnv = undefined;
			answers.apiKeyLiteral = value;
			provider = inferKeyProvider(value);
			wizard.answer("Key", "pasted, written on Save");
		}
		answers.keyGiven = true;
		answers.inventoryKey = undefined;
		const runtime = provider !== undefined ? (registry.get(provider) ?? undefined) : undefined;
		if (runtime && answers.runtime?.id !== runtime.id) {
			answers.model = undefined;
			answers.probe = undefined;
			answers.inventory = undefined;
		}
		answers.runtime = runtime;
		answers.keyProvider = runtime?.id;
		answers.targetId = runtime ? deriveTargetId(runtime.id, readSettings().targets) : undefined;
		if (runtime) wizard.answer("Provider", `${runtime.displayName}  ${chalk.dim("(from the key)")}`);
		return "next";
	},
};

/** The setup-file path: the same import as `configure --import`, shown and confirmed on the rail. */
const FILE_STEP: Step = {
	id: "setup-file",
	applies: (answers) => firstRunFlow(answers) && answers.have === "file",
	run: async (wizard, answers) => {
		let problem: string | undefined;
		for (;;) {
			const result = await wizard.text({
				heading: [
					"",
					chalk.bold("Where is the setup file?"),
					...(problem ? problem.split("\n").map((line) => chalk.red(line)) : []),
				],
				initial: answers.setupSource ?? "",
				hint: "a path on this machine or an https:// address",
				validate: (value) => (value.trim().length === 0 ? "Type a path or an https:// address." : null),
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind === "quit") return "quit";
			if (result.kind === "back") return "back";
			const source = result.value.trim();
			answers.setupSource = source;
			const prepared = await prepareImport(source, false);
			if (!prepared.ok) {
				problem = prepared.error;
				continue;
			}
			problem = undefined;
			if (importChangesNothing(prepared.plan)) {
				wizard.answer("Setup file", `${source}  ${chalk.dim("(already imported)")}`);
				return "imported";
			}
			const confirm = await wizard.select<"apply" | "back">({
				heading: ["", chalk.bold("This setup file will:"), ...describeImport(prepared)],
				choices: [
					{ value: "apply", label: "Apply", hint: "save these targets to your Clio settings" },
					{ value: "back", label: "Back", hint: "choose another file" },
				],
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (confirm.kind === "quit") return "quit";
			if (confirm.kind === "back" || confirm.value === "back") continue;
			try {
				const status = commitImport(prepared.file);
				wizard.answer("Setup file", source);
				for (const line of status) wizard.presenter.note(line.trim());
			} catch (err) {
				problem = err instanceof Error ? err.message : String(err);
				continue;
			}
			return "imported";
		}
	},
};

/** `configure --add` without a runtime: the source categories, then the providers in the one chosen. */
const CATEGORY_STEP: Step = {
	id: "category",
	applies: (answers) => answers.mode === "add" && !answers.fixedRuntime,
	run: async (wizard, answers) => {
		const available = CONFIGURE_CATEGORY_CHOICES.filter(
			(choice) => runtimesForCategory(allEntries(), choice.category).length > 0,
		);
		const current = available.findIndex((choice) => choice.category === answers.category);
		const result = await wizard.select<ConfigureCategory>({
			heading: [
				"",
				chalk.bold("Where does your model come from?"),
				chalk.dim("Choose the description you recognize; Clio shows the exact providers next."),
			],
			choices: available.map((choice) => ({
				value: choice.category,
				label: choice.label,
				hint: choice.summary,
			})),
			initialIndex: Math.max(0, current),
			railPrefix: wizard.rail,
			backLabel: "cancel",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (answers.category !== result.value) {
			answers.runtime = undefined;
			answers.detected = undefined;
		}
		answers.category = result.value;
		const choice = available.find((entry) => entry.category === result.value);
		wizard.answer("Source", choice?.label ?? result.value);
		return "next";
	},
};

const RUNTIME_STEP: Step = {
	id: "runtime",
	applies: (answers) =>
		!answers.fixedRuntime &&
		!(
			firstRunFlow(answers) &&
			(answers.have === "server" || (answers.have === "key" && answers.keyProvider !== undefined))
		),
	run: async (wizard, answers) => {
		const registry = getRuntimeRegistry();
		const chatEntries = allEntries().filter((entry) => {
			const runtime = registry.get(entry.runtimeId);
			return runtime !== null && (answers.mode !== "first" || isOrchestratorEligibleRuntime(runtime));
		});
		// A key the prefix table did not place: the providers that take one.
		const entries =
			firstRunFlow(answers) && answers.have === "key"
				? runtimesForCategory(chatEntries, "cloud-api").filter((entry) => registry.get(entry.runtimeId)?.auth === "api-key")
				: answers.category
					? runtimesForCategory(chatEntries, answers.category)
					: chatEntries;
		const usable = entries.length > 0 ? entries : chatEntries;
		const previous = usable.findIndex((entry) => entry.runtimeId === answers.runtime?.id);
		const featured = usable.findIndex((entry) => entry.featured);
		const result = await wizard.select<string>({
			heading: ["", chalk.bold("Which provider or app do you use?")],
			choices: usable.map((entry) => ({
				value: entry.runtimeId,
				label: entry.label,
				// A summary that only repeats the label says nothing the row does not already say, and the runtime's
				// internal id is a name for settings.yaml, not for this choice.
				...(entry.summary === entry.label ? {} : { hint: entry.summary }),
			})),
			initialIndex: previous >= 0 ? previous : featured >= 0 ? featured : 0,
			searchable: usable.length > 8,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const runtime = registry.get(result.value);
		if (!runtime) return "back";
		if (answers.runtime?.id !== runtime.id) {
			answers.targetId =
				answers.mode === "edit" ? answers.existing?.id : deriveTargetId(runtime.id, readSettings().targets);
			answers.url = undefined;
			answers.detected = undefined;
			// A key pasted on the first-run key screen belongs to whichever provider is picked for it.
			if (!answers.keyGiven) {
				answers.credential = undefined;
				answers.keyRequested = undefined;
				answers.apiKeyEnv = undefined;
				answers.apiKeyLiteral = undefined;
			}
			answers.model = undefined;
			answers.thinking = undefined;
			answers.contextWindow = undefined;
			answers.probe = undefined;
			answers.inventory = undefined;
			answers.inventoryKey = undefined;
		}
		answers.runtime = runtime;
		answers.targetId ??= deriveTargetId(runtime.id, readSettings().targets);
		wizard.answer("Provider", `${runtime.displayName}  ${chalk.dim(`(${runtime.id})`)}`);
		return "next";
	},
};

const SDK_STEP: Step = {
	id: "claude-sdk",
	applies: (answers) => answers.runtime?.id === "claude-sdk",
	run: async (wizard) => {
		try {
			await ensureClaudeAgentSdk({
				confirm: async (question) => {
					const result = await wizard.select<boolean>({
						heading: ["", question],
						choices: [
							{ value: true, label: "Install now" },
							{ value: false, label: "Not now" },
						],
						initialIndex: 1,
						railPrefix: wizard.rail,
						backLabel: "back",
						clearOnExit: true,
						input: wizard.input,
						output: wizard.output,
					});
					return result.kind === "selected" && result.value;
				},
			});
			return "next";
		} catch (error) {
			wizard.presenter.fail(error instanceof Error ? error.message : String(error));
			return "cancel";
		}
	},
};

/** Copilot: the SDK component and the `copilot login` check; the signed-in account is the authorization. */
const COPILOT_STEP: Step = {
	id: "copilot-sdk",
	applies: (answers) => answers.runtime?.id === "copilot-sdk",
	run: async (wizard) => {
		const ask = async (question: string, yes = false) => {
			const result = await wizard.select<boolean>({
				heading: ["", question],
				choices: [
					{ value: true, label: "Yes" },
					{ value: false, label: "No" },
				],
				initialIndex: yes ? 0 : 1,
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			return result.kind === "selected" && result.value;
		};
		const print = (text: string) => wizard.output.write(`${text}\n`);
		const ready = await prepareCopilotSdk({
			confirm: (question) => ask(question),
			// A terminal can run the official sign-in in place; a hosted wizard (the GUI) has no terminal for it.
			...(!wizard.host && wizard.input.isTTY
				? { signIn: () => offerCopilotSignIn({ confirm: (q) => ask(q, true), print }) }
				: {}),
			print,
		});
		if (ready.ok) return "next";
		wizard.presenter.fail(ready.message);
		return "cancel";
	},
};

const URL_STEP: Step = {
	id: "url",
	applies: (answers) => answers.runtime !== undefined && supportFor(answers.runtime).supportsCustomUrl,
	run: async (wizard, answers) => {
		const serverPath = firstRunFlow(answers) && answers.have === "server";
		// The first-run server path asks on the generic runtime and moves to the native one the address turns out to be.
		if (serverPath && answers.runtime?.id !== "openai-compat") {
			answers.runtime = getRuntimeRegistry().get("openai-compat") ?? answers.runtime;
			answers.detected = undefined;
		}
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const local = supportFor(runtime).group === "local-http";
		const gateway = runtime.gatewayUrl;
		const offered = serverPath ? undefined : offeredUrlFor(runtime);
		const found = serverPath ? answers.offered.filter((route) => route.kind === "local-server") : [];
		const recheck = answers.recheckUrl === true && !wizard.goingBack && answers.url !== undefined;
		answers.recheckUrl = undefined;
		const result: Awaited<ReturnType<Wizard["text"]>> = recheck
			? { kind: "value", value: answers.url ?? "" }
			: await wizard.text({
					heading: [
						"",
						chalk.bold(
							serverPath ? "What is the server's address?" : (gateway?.label ?? (local ? "Where is the server?" : "Base URL")),
						),
						...(serverPath ? [] : gatewayUrlGuidance(runtime).map((line) => chalk.dim(line))),
						...found.map((route) => chalk.dim(`found: ${route.target.url ?? route.source} (${route.runtime.displayName})`)),
					],
					// An offered address is a placeholder, so a typed one replaces it instead of being appended to it.
					...(answers.url !== undefined
						? { initial: answers.url }
						: offered !== undefined
							? wizard.host
								? { initial: offered }
								: { placeholder: offered }
							: {}),
					hint: gateway
						? "paste the whole URL, scheme and path included"
						: "host:port is enough; Clio fills in the scheme and the port it knows",
					railPrefix: wizard.rail,
					backLabel: "back",
					clearOnExit: true,
					validate: (value) =>
						value.length === 0
							? gateway
								? `the ${gateway.label} is required`
								: "a URL is required for this runtime"
							: targetUrlProblem(value),
					input: wizard.input,
					output: wizard.output,
				});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const url = normalizeUrl(result.value, runtime.id);
		const bareHost = !/^[a-z][a-z0-9+.-]*:\/\//iu.test(result.value.trim());
		if (answers.url !== url) {
			answers.inventoryKey = undefined;
			answers.detected = undefined;
		}
		answers.url = url;
		if (!recheck) wizard.answer("URL", url);
		const authenticated = await reportReachability(wizard, answers, runtime, url, bareHost);
		if (!authenticated && runtime.auth === "api-key") {
			answers.keyRequested = true;
			answers.recheckUrl = true;
			answers.inventoryKey = undefined;
			if (answers.credential === "skip") answers.credential = undefined;
			return "credential";
		}
		return "next";
	},
};

/**
 * Keep offline setup possible, but repair rejected authentication before discovery.
 *
 * The readline wizard treated an unreachable endpoint as a question ("save this
 * target anyway?") and an LM Studio URL that did not greet back as a hard
 * refusal. Neither belongs in a first run: the server is frequently not started
 * yet, and the fix is one `clio-coder configure --url` away.
 */
async function reportReachability(
	wizard: Wizard,
	answers: Answers,
	runtime: RuntimeDescriptor,
	url: string,
	bareHost = false,
): Promise<boolean> {
	wizard.host?.waiting?.(`Checking ${url}…`);
	const draft = draftDescriptor(answers, runtime, false);
	// A freshly typed "store the key" answer is not on disk yet (that write
	// happens at the end of the wizard), so it has to ride along as an explicit
	// token the same way the model step already does; env and stored-from-before
	// credentials resolve on their own through the descriptor's auth fields.
	let probe = await runtimeProbe(runtime, draft, answers.apiKeyLiteral);
	answers.unreachable = undefined;
	// A bare host was read as http only because normalizeUrl had to pick. An https-only host must not read as down.
	if (probe !== null && !probe.ok && !refusedCredential(probe) && bareHost && url.startsWith("http://")) {
		const secure = url.replace(/^http:/u, "https:");
		wizard.host?.waiting?.(`Checking ${secure}…`);
		const retried = await runtimeProbe(runtime, { ...draft, url: secure }, answers.apiKeyLiteral);
		if (retried !== null && (retried.ok || refusedCredential(retried) || isUntrustedCertificate(retried.error))) {
			probe = retried;
			answers.url = secure;
			answers.inventoryKey = undefined;
			wizard.presenter.step(`${url} did not answer and https did, so Clio uses ${secure}`);
		}
	}
	if (probe !== null) {
		if (probe.ok) {
			const readings = probeReadings(probe);
			wizard.presenter.step(
				`${runtime.id === "alcf" ? "ALCF catalog reachable; inference URL not checked" : "reachable"}, ${readings.length > 0 ? readings.join(", ") : "no model list offered"}`,
			);
		} else if (refusedCredential(probe)) {
			wizard.presenter.warn(refusedCredentialLine(answers));
			return false;
		} else if (isUntrustedCertificate(probe.error)) {
			wizard.presenter.warn(
				`The server answered, but Clio does not trust its certificate: ${probe.error}. Point NODE_EXTRA_CA_CERTS at its CA, or change the address.`,
			);
			answers.unreachable = probe.error;
		} else {
			const problem = plainConnectionProblem(probe.error ?? "no reply");
			wizard.presenter.warn(`not reachable: ${problem}`);
			answers.unreachable = probe.error ?? "no reply";
		}
	}
	if (probe?.ok && runtime.id === "lmstudio") {
		const greeting = await greetLmStudio(draft, { credentialsPresent: new Set(), httpTimeoutMs: 750 });
		if (!greeting.ok) wizard.presenter.warn(`${url} answered, but not with the LM Studio greeting`);
	}
	if (PROTOCOL_COMPAT_RUNTIME_IDS.has(runtime.id)) {
		const fingerprint = await fingerprintNativeRuntime(url);
		if (fingerprint && getRuntimeRegistry().get(fingerprint.runtimeId)) {
			answers.detected = { runtimeId: fingerprint.runtimeId, displayName: fingerprint.displayName };
		}
	}
	return true;
}

const DETECTED_RUNTIME_STEP: Step = {
	id: "detected-runtime",
	applies: (answers) => answers.mode !== "edit" && answers.detected !== undefined && answers.runtime !== undefined,
	run: async (wizard, answers) => {
		const detected = answers.detected;
		const runtime = answers.runtime;
		if (!detected || !runtime) return "next";
		const native = getRuntimeRegistry().get(detected.runtimeId);
		if (!native) return "next";
		// The first-run server path takes what the address is serving; the generic runtime stays a configure choice.
		if (firstRunFlow(answers)) {
			if (wizard.goingBack) return "back";
			answers.runtime = native;
			answers.inventoryKey = undefined;
			wizard.answer("Server", detected.displayName);
			return "next";
		}
		const result = await wizard.select<boolean>({
			heading: ["", chalk.bold(`That URL is serving ${detected.displayName}.`)],
			choices: [
				{
					value: true,
					label: `Use ${native.id}`,
					hint: "its own runtime, with resident-model lifecycle and its real capabilities",
				},
				{ value: false, label: `Keep ${runtime.id}`, hint: "the generic protocol runtime you picked" },
			],
			initialIndex: 0,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (result.value) {
			answers.runtime = native;
			answers.inventoryKey = undefined;
			wizard.answer("Detected", `${detected.displayName}, using runtime ${native.id}`);
		} else {
			wizard.answer("Detected", `${detected.displayName}, keeping runtime ${runtime.id}`);
		}
		return "next";
	},
};

/** The credential source the screen opens on, which is the one that is usually right. */
function defaultCredentialSource(runtime: RuntimeDescriptor, targetId: string): CredentialSource {
	const status = openAuthStorage().statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false });
	if (status.source === "stored-api-key") return "keep";
	if (status.source === "environment") return "env";
	if (runtime.id === "litellm") return "stored";
	// New users can paste the credential they were given without first learning
	// shell environment variables. The screen states the storage properties and
	// keeps the environment-variable option available for managed deployments.
	// A local server that needs no key still opens on No key.
	return targetRequiresAuth({ id: targetId, runtime: runtime.id }, runtime) ? "stored" : "skip";
}

/**
 * Run the browser sign-in on a readline interface that exists only for it.
 *
 * A readline interface left open across the wizard echoes every keypress the
 * pickers read, which puts a stray line under each menu and throws off the
 * erase that replaces it with the answer row. So the wizard owns no readline,
 * and the one flow that needs one opens and closes it around the call.
 */
async function connectOAuth(wizard: Wizard, runtime: RuntimeDescriptor): Promise<"connected" | "failed" | "stopped"> {
	if (wizard.host) {
		const outcome = { stopped: false };
		const connected = await loginOAuthRuntime(null, runtime, wizard.host, outcome);
		return connected ? "connected" : outcome.stopped ? "stopped" : "failed";
	}
	const rl = createInterface({ input: wizard.streams.in, output: wizard.streams.out });
	try {
		return (await loginOAuthRuntime(rl, runtime)) ? "connected" : "failed";
	} finally {
		rl.close();
	}
}

/** Only some runtimes flag a refused credential; the rest report the bare status of the shared HTTP probe. */
const REFUSED_CREDENTIAL = /\bHTTP (?:401|403)\b/u;

function refusedCredential(probe: ProbeResult): boolean {
	return probe.authFailed === true || REFUSED_CREDENTIAL.test(probe.error ?? "");
}

/** Says which credential the server turned down, because the screen after it asks for one again. */
function refusedCredentialLine(answers: Answers): string {
	const line = (why: string): string => `Authentication failed: ${why}. Choose a credential before selecting a model.`;
	if (answers.credential === "env") {
		const name = answers.apiKeyEnv ?? "";
		return line(
			process.env[name] ? `the server refused the key in $${name}` : `$${name} is not set here, so the server saw no key`,
		);
	}
	if (answers.credential === "stored") return line("the server refused that key");
	if (answers.credential === "keep") return line("the server refused the saved key");
	return line("this server wants a key");
}

/**
 * An app on this computer (LM Studio, Lemonade) takes no key unless its owner turned one on, and asking
 * before the address reads as a question about something the user never set up. The address step routes
 * back to the credential step when the app refuses the request, and the missing-list screen offers it, so
 * the question waits for either. A server or gateway stays asked first: those are often shared and keyed.
 */
function keyWaitsForRefusal(answers: Answers, runtime: RuntimeDescriptor): boolean {
	return (
		answers.mode !== "edit" &&
		runtime.auth === "api-key" &&
		(LOCAL_APP_RUNTIME_IDS.has(runtime.id) || (firstRunFlow(answers) && answers.have === "server")) &&
		answers.keyRequested !== true
	);
}

const CREDENTIAL_STEP: Step = {
	id: "credential",
	applies: (answers) =>
		(answers.runtime?.auth === "api-key" && !answers.keyGiven && !keyWaitsForRefusal(answers, answers.runtime)) ||
		answers.runtime?.auth === "oauth",
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const stored = describeAuthStatus(runtime, answers.existing);
		// A sign-in the operator stops with Esc asks this question again, so the loop.
		while (runtime.auth === "oauth") {
			const result = await wizard.select<CredentialSource>({
				heading: [
					"",
					chalk.bold(`Sign in to ${runtime.displayName}`),
					chalk.dim(`credential: ${stored}`),
					"Sign-in stores credentials immediately; target settings wait for Save.",
				],
				choices: [
					{ value: "oauth-connect", label: "Connect now", hint: "opens your browser and waits for the sign-in" },
					{
						value: "oauth-skip",
						label: "Later",
						hint: wizard.host
							? "connect it from Settings → Connections before the first turn"
							: `ends setup with nothing saved; run \`clio-coder auth login ${runtime.id}\` later`,
					},
				],
				initialIndex: answers.credential === "oauth-skip" ? 1 : 0,
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind === "quit") return "quit";
			if (result.kind === "back") return "back";
			answers.credential = result.value;
			if (result.value === "oauth-connect") {
				const connected = await connectOAuth(wizard, runtime);
				if (connected === "stopped") continue;
				if (connected === "failed") {
					wizard.presenter.warn(
						wizard.host
							? "sign-in did not complete; connect it from Settings → Connections when ready"
							: "sign-in did not complete",
					);
				} else {
					wizard.answer("Credential", `connected to ${runtime.id}`);
					return "next";
				}
			}
			// A target saved without its credential opens as a home that looks configured and fails its first turn.
			if (!wizard.host) {
				answers.signInLater = runtime.id;
				return "cancel";
			}
			wizard.answer("Credential", "not connected yet");
			return "next";
		}

		const hasStored = answers.existing?.auth?.apiKeyRef !== undefined || stored !== "none stored";
		const choices = [
			{
				value: "env" as CredentialSource,
				label: "Environment variable",
				hint: "read at call time; nothing is written to disk",
			},
			{
				value: "stored" as CredentialSource,
				label: "Store the key",
				hint: "written to credentials.yaml, mode 0600, not encrypted",
			},
			...(hasStored ? [{ value: "keep" as CredentialSource, label: "Keep what is there", hint: stored }] : []),
			{
				value: "skip" as CredentialSource,
				label: "No key",
				hint: "only for servers that accept unauthenticated requests",
			},
		];
		const fallback = defaultCredentialSource(runtime, answers.targetId ?? runtime.id);
		// The server just refused a request without a key, so No key is the one answer known to be wrong.
		const current = answers.credential ?? (answers.keyRequested && fallback === "skip" ? "stored" : fallback);
		const initial = Math.max(
			0,
			choices.findIndex((choice) => choice.value === current),
		);
		const result = await wizard.select<CredentialSource>({
			heading: ["", chalk.bold("How should Clio get the API key?"), chalk.dim(`currently: ${stored}`)],
			choices,
			initialIndex: initial,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		answers.credential = result.value;
		if (result.value !== "env") answers.apiKeyEnv = undefined;
		answers.inventoryKey = undefined;
		if (result.value !== "stored") answers.apiKeyLiteral = undefined;
		if (result.value === "keep") wizard.answer("Credential", stored);
		if (result.value === "skip") wizard.answer("Credential", "none");
		return "next";
	},
};

const CREDENTIAL_VALUE_STEP: Step = {
	id: "credential-value",
	applies: (answers) => !answers.keyGiven && (answers.credential === "env" || answers.credential === "stored"),
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const wantsEnv = answers.credential === "env";
		const result = await wizard.text({
			heading: ["", chalk.bold(wantsEnv ? "Which environment variable?" : "Paste the API key")],
			initial: wantsEnv ? (answers.apiKeyEnv ?? runtime.credentialsEnvVar ?? "") : "",
			hint: wantsEnv
				? "Clio reads it every time it calls the provider, so the key never lands on disk"
				: `stored at ${shortenPath(authStoragePath())}`,
			...(wantsEnv ? {} : { mask: true }),
			validate: (value) =>
				value.length === 0
					? `Enter ${wantsEnv ? "an environment variable" : "a key"}, or press Escape to choose No key.`
					: wantsEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
						? "A variable name holds only letters, digits and underscores. Paste a key under Store the key instead."
						: null,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (wantsEnv) {
			answers.apiKeyEnv = result.value.length > 0 ? result.value : undefined;
			answers.inventoryKey = undefined;
			wizard.answer("Credential", result.value.length > 0 ? `$${result.value}` : "none");
			return "next";
		}
		answers.apiKeyLiteral = result.value.length > 0 ? result.value : undefined;
		answers.inventoryKey = undefined;
		// Nothing is on disk until Save, and a cancelled wizard must not read as having stored a key.
		wizard.answer("Credential", result.value.length > 0 ? "key, written to credentials.yaml on Save" : "none");
		return "next";
	},
};

/** Read the model list once per distinct set of connection answers. */
async function modelInventory(
	wizard: Wizard,
	answers: Answers,
	runtime: RuntimeDescriptor,
): Promise<WireModelInventory> {
	const key = [
		runtime.id,
		answers.targetId,
		answers.url,
		answers.apiKeyEnv,
		answers.apiKeyLiteral ? "literal" : "",
	].join("|");
	if (answers.inventoryKey === key && answers.inventory) return answers.inventory;
	wizard.host?.waiting?.("Reading the model list…");
	const inventory = await resolveSupportedWireModels(
		runtime,
		draftDescriptor(answers, runtime, false),
		undefined,
		answers.apiKeyLiteral,
	);
	answers.inventory = inventory;
	answers.inventoryKey = key;
	return inventory;
}

const MODEL_STEP: Step = {
	id: "model",
	applies: () => true,
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const support = supportFor(runtime);
		const inventory = await modelInventory(wizard, answers, runtime);
		// A catalog-ordered list has no head worth recommending: openai's first of
		// 38 ids is `gpt-4` because g sorts early.
		const preferred = answers.model ?? preferredModelFor(inventory, support);

		if (
			inventory.models.length === 0 &&
			keyWaitsForRefusal(answers, runtime) &&
			REFUSED_CREDENTIAL.test(inventory.probeError ?? "")
		) {
			// A keyed llama.cpp or vLLM answers its health check and refuses only the model list.
			answers.keyRequested = true;
			answers.inventoryKey = undefined;
			wizard.presenter.warn(refusedCredentialLine(answers));
			return "credential";
		}
		if (inventory.models.length === 0) {
			// The address step just said why, in these words; the list failing for the same reason adds nothing.
			if (answers.unreachable === undefined || answers.unreachable !== inventory.probeError)
				wizard.presenter.warn(inventoryGap(runtime, { url: answers.url }, inventory.probeError));
			answers.unreachable = undefined;
			const canDetect = runtimeListsModelsLive(runtime);
			const result = await wizard.select<"retry" | "back" | "manual" | "key">({
				heading: [
					"",
					chalk.bold("Clio could not read a model list"),
					chalk.dim(
						canDetect
							? "Start the app or server and load a model, then retry. No generation request is sent."
							: "This provider has no discovery API Clio can use.",
					),
				],
				choices: [
					...(canDetect
						? [{ value: "retry" as const, label: "Check again", hint: "probe the endpoint and read its model list" }]
						: []),
					// A keyed server answers its health check and refuses only the list, which no probe can tell from an
					// empty one, so the key question the setup skipped stays one choice away.
					...(keyWaitsForRefusal(answers, runtime)
						? [
								{
									value: "key" as const,
									label: "This server needs an API key",
									hint: "choose a credential, then read the model list again",
								},
							]
						: []),
					{ value: "back", label: "Change the connection", hint: "go back without saving" },
					{
						value: "manual",
						label: "Enter an unverified model ID",
						hint: "advanced: Clio cannot verify it before saving",
					},
				],
				initialIndex: 0,
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind === "quit") return "quit";
			if (result.kind === "back" || result.value === "back") return "back";
			if (result.value === "key") {
				answers.keyRequested = true;
				answers.inventoryKey = undefined;
				return "credential";
			}
			if (result.value === "retry") {
				answers.inventoryKey = undefined;
				wizard.presenter.step("checking the endpoint and model list again");
				return MODEL_STEP.run(wizard, answers);
			}
			const manual = await wizard.text({
				heading: [
					"",
					chalk.bold("Unverified model id"),
					chalk.dim("Clio will send this exact text. The endpoint and capabilities remain unverified."),
				],
				initial: preferred ?? "",
				hint: "use only the exact wire id from the provider or server documentation",
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				validate: (value) => (value.length === 0 ? "a model id is required" : null),
				input: wizard.input,
				output: wizard.output,
			});
			if (manual.kind !== "value") return manual.kind;
			answers.model = manual.value;
			wizard.answer("Model", `${manual.value}  ${chalk.dim("(unverified)")}`);
			await readModelCapabilities(answers, runtime);
			return "next";
		}

		// The curated default leads the list, marked, so a long catalog does not rest on whatever sorts first.
		const offered = chatPickerModels(inventory);
		const recommended =
			support.defaultModel !== undefined && offered.includes(support.defaultModel) ? support.defaultModel : undefined;
		const models =
			recommended !== undefined ? [recommended, ...offered.filter((model) => model !== recommended)] : offered;
		// The first run takes the recommended model, or the only one a server lists; the review offers the list.
		const automatic =
			firstRunFlow(answers) && !answers.chooseModel
				? (recommended ?? (offered.length === 1 ? offered[0] : undefined))
				: undefined;
		if (
			automatic !== undefined &&
			modelChoiceRefusal(runtime, { id: answers.targetId ?? runtime.id, url: answers.url }, automatic, inventory) === null
		) {
			if (wizard.goingBack) return "back";
			answers.model = automatic;
			wizard.answer(
				"Model",
				`${automatic}  ${chalk.dim(automatic === recommended ? "(recommended)" : "(the only one listed)")}`,
			);
			await readModelCapabilities(answers, runtime);
			return "next";
		}
		const selected = models.indexOf(preferred ?? "");
		const result = await wizard.select<string>({
			heading: [
				"",
				chalk.bold("Which model?"),
				chalk.dim(inventoryNote(runtime, inventory) ?? "read live from the target just now"),
			],
			choices: models.map((model) => {
				const state = inventory.modelStates?.[model]?.state;
				const hint =
					model === preferred && model !== recommended
						? "default"
						: state !== undefined && state !== "unknown"
							? state
							: undefined;
				const label = inventory.labels?.[model];
				const named = label && label !== model ? `${model} — ${label}` : model;
				return {
					value: model,
					label: model === recommended ? `${named} (recommended)` : named,
					...(hint === undefined ? {} : { hint }),
				};
			}),
			initialIndex: selected >= 0 ? selected : 0,
			searchable: models.length > 8,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const refusal = modelChoiceRefusal(
			runtime,
			{ id: answers.targetId ?? runtime.id, url: answers.url },
			result.value,
			inventory,
		);
		if (refusal !== null) {
			wizard.presenter.warn(refusal);
			return "back";
		}
		answers.model = result.value;
		wizard.answer("Model", result.value);
		await readModelCapabilities(answers, runtime);
		return "next";
	},
};

/**
 * Probe once more with the chosen model set, because a model's context window
 * and whether it reasons are per-model facts and the earlier probe ran before
 * there was a model to ask about.
 */
async function readModelCapabilities(answers: Answers, runtime: RuntimeDescriptor): Promise<void> {
	const descriptor = draftDescriptor(answers, runtime, true);
	const probe = await runtimeProbe(runtime, descriptor, answers.apiKeyLiteral);
	answers.probe = probe;
	if (probe?.ok && probe.models) {
		recordTargetModelSnapshot(descriptor, probe.models, probe.modelLabels ? { modelLabels: probe.modelLabels } : {});
	}
}

const THINKING_HINTS: Readonly<Record<ThinkingLevel, string>> = {
	off: "never ask this model to think before answering",
	minimal: "a sentence of reasoning",
	low: "short reasoning, the usual choice",
	medium: "more reasoning on hard turns",
	high: "long reasoning, slower and more expensive",
	xhigh: "longer still, where the model offers it",
	max: "everything the model will spend",
};

const THINKING_STEP: Step = {
	id: "thinking",
	applies: (answers) => {
		if (answers.mode !== "edit") return false;
		const runtime = answers.runtime;
		if (!runtime || answers.model === undefined) return false;
		return modelSupportsThinking(runtime, draftDescriptor(answers, runtime, true), answers.probe ?? null);
	},
	run: async (wizard, answers) => {
		const current = THINKING_LEVELS.indexOf(answers.thinking ?? "low");
		const result = await wizard.select<ThinkingLevel>({
			heading: [
				"",
				chalk.bold("How hard should it think?"),
				chalk.dim(
					answers.mode === "first"
						? "changeable any time in `clio-coder configure`"
						: "off disables reasoning for this target; chat and fleet thinking defaults stay unchanged",
				),
			],
			choices: THINKING_LEVELS.map((level) => ({ value: level, label: level, hint: THINKING_HINTS[level] })),
			initialIndex: current >= 0 ? current : 0,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		answers.thinking = result.value;
		wizard.answer("Thinking", result.value);
		return "next";
	},
};

const CONTEXT_STEP: Step = {
	id: "context-window",
	applies: (answers) => answers.mode === "edit",
	run: async (wizard, answers) => {
		const result = await wizard.text({
			heading: ["", chalk.bold("Context window in tokens")],
			initial: answers.contextWindow === undefined ? "" : String(answers.contextWindow),
			hint: "optional override; blank uses detected capabilities or the runtime default",
			validate: (value) =>
				value === "" || (Number.isSafeInteger(Number(value)) && Number(value) > 0)
					? null
					: "enter a positive whole number, or leave blank",
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind !== "value") return result.kind;
		answers.contextWindow = result.value ? Number(result.value) : undefined;
		wizard.answer("Context", result.value || "detected / runtime default");
		return "next";
	},
};

function verificationSummary(answers: Answers): string[] {
	const probe = answers.probe;
	const endpoint = !probe
		? "Endpoint: no passive check available"
		: probe.ok
			? answers.runtime?.id === "alcf"
				? "ALCF catalog reachable; URL untested"
				: "Endpoint: reachable (metadata only)"
			: "Endpoint: did not answer when checked";
	const inventory = answers.inventory;
	const models =
		inventory?.source === "probe"
			? `Models: ${inventory.models.length} listed live`
			: inventory?.source === "catalog"
				? "Models: provider catalog (not live)"
				: inventory?.source === "cache"
					? "Models: earlier cache (not live now)"
					: inventory?.source === "legacy"
						? "Models: existing settings (not live)"
						: "Model ID: unverified";
	return [endpoint, models];
}

const REVIEW_STEP: Step = {
	id: "review",
	applies: () => true,
	run: async (wizard, answers) => {
		const facts = observeHostCapacityFacts();
		const capacity = resolveLocalConcurrency("auto", facts);
		// The dock has 16 body rows and may be only 40 columns wide. Keep the
		// summary compact; detailed observations are reachable before Save.
		for (;;) {
			const result = await wizard.select({
				heading: [
					"",
					chalk.bold("Review what Clio could verify"),
					truncate(`Connection: ${answers.targetId}`, wizard.host ? 36 : 70),
					truncate(`Model: ${answers.model}`, wizard.host ? 36 : 70),
					...verificationSummary(answers),
					wizard.sendTest ? "Save sends one short test message first." : "No generation or quality/tool tests.",
					"GPU/VRAM and model fit not checked.",
					`Automatic local workers: ${capacity.limit}`,
					answers.mode === "first" ? "Save sets the chat and fleet model." : "Existing routes stay in place.",
				],
				choices: [
					{ value: "save", label: "Save target" },
					...(firstRunFlow(answers) ? [{ value: "model", label: "Choose a different model" }] : []),
					{ value: "details", label: "Connection and machine details" },
					{ value: "back", label: "Back" },
					{ value: "cancel", label: "Cancel setup" },
				],
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind !== "selected") return result.kind;
			if (result.value === "model") return "model";
			if (result.value === "save" && wizard.sendTest) return testBeforeSave(wizard, answers, wizard.sendTest);
			if (result.value !== "details")
				return result.value === "save" ? "next" : result.value === "back" ? "back" : "cancel";
			const detailPages = [
				["Connection details", answers.runtime?.displayName ?? "", `ID: ${answers.targetId}`, `Model: ${answers.model}`],
				[
					"Connection address",
					answers.url ?? "Provider-managed address",
					answers.probe ? "This was a passive metadata check." : "Endpoint reachability was not checked.",
					"No generation request was sent.",
				],
				[
					"Credential handling",
					...(answers.credential === "stored"
						? ["Key written only when you save.", "Local storage: mode 0600.", "Storage is not encrypted."]
						: answers.credential === "env"
							? [
									`Read from $${answers.apiKeyEnv}`,
									answers.apiKeyEnv && process.env[answers.apiKeyEnv] ? "Set in this process." : "Not set in this process.",
								]
							: answers.credential === "keep"
								? ["Keep the saved credential."]
								: answers.runtime?.auth === "oauth"
									? ["Browser sign-in is saved immediately.", describeAuthStatus(answers.runtime, answers.existing)]
									: ["No API key selected.", "SDK/app sessions are not inspected."]),
					"No generation checked key validity.",
				],
				[
					"Machine observations",
					`${facts.cpus} usable CPUs`,
					`${(facts.availableMemoryBytes / 1024 ** 3).toFixed(1)} GiB available memory`,
					...(facts.cgroupAvailableBytes === null
						? []
						: [`${(facts.cgroupAvailableBytes / 1024 ** 3).toFixed(1)} GiB available to this process`]),
					`${capacity.limit} automatic local workers`,
					`Sizing bound: ${capacity.bound}`,
					"GPU/VRAM and model fit not checked.",
					"Answer quality and tool use untested.",
				],
			];
			let page = 0;
			while (page < detailPages.length) {
				const detail = await wizard.select({
					heading: detailPages[page] ?? [],
					choices: [
						{ value: "next", label: page === detailPages.length - 1 ? "Return to review" : "Next" },
						{ value: "previous", label: page === 0 ? "Return to review" : "Previous" },
					],
					railPrefix: wizard.rail,
					backLabel: "review",
					clearOnExit: true,
					input: wizard.input,
					output: wizard.output,
				});
				if (detail.kind === "quit") return "quit";
				if (detail.kind === "back") break;
				if (detail.value === "previous") {
					if (page === 0) break;
					page--;
				} else page++;
			}
		}
	},
};

/**
 * Send the test request and stay on its screen until it answers or the person
 * chooses: try again, change the key or address, or save anyway.
 */
async function testBeforeSave(wizard: Wizard, answers: Answers, send: SendChatTest): Promise<StepOutcome> {
	const runtime = answers.runtime;
	const model = answers.model;
	if (!runtime || model === undefined) return "next";
	const label = `${answers.targetId} / ${model}`;
	for (;;) {
		wizard.presenter.note(`Testing ${label} ...`);
		const target = draftDescriptor(answers, runtime, true);
		const apiKey =
			answers.apiKeyLiteral ??
			(answers.credential === "env" && answers.apiKeyEnv ? process.env[answers.apiKeyEnv] : undefined);
		const outcome: ChatTestOutcome = await send({
			runtime,
			target,
			model,
			...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
		});
		if (outcome.ok) {
			answers.tested = { latencyMs: outcome.latencyMs };
			wizard.presenter.completedStep(`Testing ${label} ... answered in ${(outcome.latencyMs / 1000).toFixed(1)} s.`);
			return "next";
		}
		const fix = chatTestFix(outcome, {
			provider: runtime.displayName,
			model,
			...(answers.url !== undefined ? { url: answers.url } : {}),
		});
		wizard.presenter.warn(`${label} did not answer: ${truncate(outcome.message, 200)}`);
		const result = await wizard.select<"retry" | "fix" | "model" | "save" | "cancel">({
			heading: ["", chalk.bold("The test request failed"), fix],
			choices: [
				{ value: "retry", label: "Try again" },
				{ value: "fix", label: "Change the key or address" },
				...(outcome.httpStatus === 404 ? [{ value: "model" as const, label: "Choose a different model" }] : []),
				{ value: "save", label: "Save anyway", hint: "saved as not checked" },
				{ value: "cancel", label: "Cancel setup" },
			],
			railPrefix: wizard.rail,
			backLabel: "review",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (result.value === "retry") continue;
		if (result.value === "save") {
			answers.tested = "skipped";
			return "next";
		}
		return result.value;
	}
}

/** Where "Change the key or address" goes: the key screen, else the credential question, else the address. */
function fixStep(answers: Answers): Step {
	if (KEY_STEP.applies(answers)) return KEY_STEP;
	if (answers.runtime?.auth === "api-key") {
		answers.keyGiven = undefined;
		return CREDENTIAL_STEP;
	}
	return URL_STEP.applies(answers) ? URL_STEP : REVIEW_STEP;
}

// Credential steps come before the URL step: a runtime that needs or may need a
// key (litellm, every cloud runtime, keyed openai-compat) has to have one in
// hand before the URL step probes reachability, or the probe reads as
// unreachable when the gateway is live and only the key was missing. A runtime
// with no credential at all skips both credential steps and keeps this order
// exactly as it was.
const STEPS: ReadonlyArray<Step> = [
	OFFERED_STEP,
	HAVE_STEP,
	FILE_STEP,
	KEY_STEP,
	CATEGORY_STEP,
	RUNTIME_STEP,
	SDK_STEP,
	COPILOT_STEP,
	CREDENTIAL_STEP,
	CREDENTIAL_VALUE_STEP,
	URL_STEP,
	DETECTED_RUNTIME_STEP,
	MODEL_STEP,
	THINKING_STEP,
	CONTEXT_STEP,
	REVIEW_STEP,
];

/** Write everything the wizard collected, in one settings update. */
function applyAnswers(
	settings: ClioSettings,
	answers: Answers,
	descriptor: TargetDescriptor,
	chatEligible: boolean,
): void {
	const current = settings.targets.find((target) => target.id === descriptor.id);
	if (answers.mode === "edit") {
		if (JSON.stringify(current) !== JSON.stringify(answers.existing))
			throw new Error("This target changed during setup; reopen Edit to keep those changes.");
	} else if (current && JSON.stringify(current) !== JSON.stringify(answers.detectedChatRoute?.target)) {
		throw new Error(`Target '${descriptor.id}' already exists; use Edit a target.`);
	}
	assertOrchestratorReplacementEligible(settings, descriptor);
	applyTarget(settings, descriptor);
	// The first target is the one everything points at. A second target is a
	// choice, and that is what the settings menu is for; asking a new user
	// which of their one target should answer chat is not a question.
	if (answers.mode === "first" && chatEligible) setOrchestratorPointer(settings, descriptor, answers.model ?? null);
	if (answers.mode === "first") setWorkerDefaultPointer(settings, descriptor, answers.model ?? null);
	if (answers.mode === "first" && answers.thinking !== undefined) {
		settings.chat.thinkingLevel = answers.thinking;
		settings.fleet.default.thinkingLevel = answers.thinking;
	}
}

export async function runOnboardingWizard(
	streams: OnboardingStreams,
	options:
		| {
				mode: "first" | "add";
				runtime?: RuntimeDescriptor;
				startsChat?: boolean;
				/** Send one short test request before Save; a function replaces the real request in tests. */
				verify?: boolean | SendChatTest;
		  }
		| { mode: "edit"; target: TargetDescriptor } = {
		mode: "first",
	},
	host?: ConfigureWizardHost,
): Promise<number> {
	const writer = host
		? { stream: streams.out, mark: () => 0, rewindTo: () => host.clearMessages() }
		: railWriter(streams.out);
	const presenter = createLifecyclePresenter({ stream: writer.stream, ...(host ? { plain: true } : {}) });
	const rail = railPrefix(presenter.isPlain());
	const columns = (streams.out as { columns?: number }).columns ?? 80;
	const wizard: Wizard = {
		goingBack: false,
		select: host?.select.bind(host) ?? promptSelect,
		text: host?.text.bind(host) ?? promptText,
		...(host ? { host } : {}),
		streams,
		presenter,
		rail,
		input: streams.in as NodeJS.ReadStream,
		output: streams.out as NodeJS.WriteStream,
		startsChat: options.mode !== "edit" && options.startsChat === true,
		answer: (label, value) => {
			presenter.fields([[label.padEnd(LABEL_WIDTH), truncate(value, Math.max(12, columns - LABEL_WIDTH - 6))]]);
		},
		sendTest:
			options.mode === "edit" || options.verify === undefined || options.verify === false
				? null
				: options.verify === true
					? sendChatTest
					: options.verify,
	};

	presenter.header(
		options.mode === "edit"
			? `Edit target: ${options.target.id}`
			: options.mode === "first"
				? "Welcome to Clio Coder"
				: "Add a target",
		"configure",
	);
	// A short terminal keeps the welcome and the line about Esc above the first question: at 15 rows this
	// sentence pushed the header, and the reason setup started, off the top of the screen.
	const rows = (streams.out as { rows?: number }).rows ?? 24;
	if (rows >= 20)
		presenter.note("Choose what you already use. Clio checks the endpoint and model list when the provider allows it.");
	if (wizard.sendTest)
		presenter.note("Before saving, Clio sends the model one short test message (a few tokens; paid providers bill it).");
	// "Nothing is saved" read as false to a first-run user who then found the
	// settings.yaml and credentials.yaml templates the home bootstrap writes. Those
	// hold no choice of theirs; the sentence is about the choices.
	// Under 20 rows the selector's own legend names Esc, so this sentence gives its rows to the header above.
	if (rows >= 20)
		presenter.note(
			"Esc goes back a step, and from the first step leaves without saving. Your choices are written to your Clio settings only at the review, except a browser sign-in you complete.",
		);

	const existing = options.mode === "edit" ? options.target : undefined;
	const offered: OfferedRoute[] = [];
	if (options.mode === "first" && !options.runtime) {
		const settings = readSettings();
		const { classifyDefaultTarget } = await import("./default-target.js");
		if (classifyDefaultTarget(settings).kind !== "usable") {
			const { collectSetupCandidates } = await import("./detect-chat-routes.js");
			const registry = getRuntimeRegistry();
			for (const candidate of await collectSetupCandidates(settings)) {
				const runtime = registry.get(candidate.target.runtime);
				if (!runtime) continue;
				offered.push({
					kind: candidate.source,
					source: candidate.label,
					runtime,
					target: candidate.target,
					...(candidate.model !== undefined ? { model: candidate.model } : {}),
					...(candidate.owner !== undefined ? { owner: candidate.owner } : {}),
				});
			}
		}
	}
	const answers: Answers = {
		mode: options.mode,
		offered,
		existing,
		runtime: existing
			? (getRuntimeRegistry().get(existing.runtime) ?? undefined)
			: options.mode !== "edit"
				? options.runtime
				: undefined,
		fixedRuntime: options.mode !== "edit" && options.runtime !== undefined,
		targetId:
			existing?.id ??
			(options.mode !== "edit" && options.runtime
				? deriveTargetId(options.runtime.id, readSettings().targets)
				: undefined),
		url: existing?.url,
		model: existing?.defaultModel,
		credential: existing?.auth?.apiKeyEnvVar ? "env" : existing?.auth?.apiKeyRef ? "keep" : undefined,
		apiKeyEnv: existing?.auth?.apiKeyEnvVar,
		contextWindow: existing?.capabilities?.contextWindow,
		thinking: existing?.capabilities?.reasoning === false ? "off" : undefined,
	};
	if (existing && !answers.runtime) {
		presenter.fail(`Unknown runtime: ${existing.runtime}`);
		return 2;
	}
	const stop = (quit = false): number => cancel(presenter, answers, { quit, advise: host === undefined });
	const marks = new Array<number>(STEPS.length).fill(writer.mark());
	const asked = new Set<number>();
	let cursor = 0;
	let direction = 1;

	while (cursor < STEPS.length) {
		if (host?.cancelled()) return stop(true);
		const step = STEPS[cursor];
		if (step === undefined) break;
		if (!step.applies(answers)) {
			cursor += direction;
			if (cursor < 0) return stop();
			continue;
		}
		marks[cursor] = writer.mark();
		asked.add(cursor);
		wizard.goingBack = direction < 0;
		const outcome = await step.run(wizard, answers);
		if (outcome === "quit" || outcome === "cancel") return stop(outcome === "quit");
		if (outcome === "imported") {
			presenter.done("Done");
			return 0;
		}
		if (outcome === "model") {
			const modelStep = STEPS.indexOf(MODEL_STEP);
			answers.chooseModel = true;
			// The model row is replaced in place when the flow drew one; a found route went straight to the review.
			if (asked.has(modelStep)) writer.rewindTo(marks[modelStep] ?? writer.mark());
			direction = 1;
			cursor = modelStep;
			continue;
		}
		if (outcome === "detected" || (answers.detectedChatRoute && step === MODEL_STEP && outcome === "next")) {
			direction = 1;
			cursor = STEPS.indexOf(answers.model ? REVIEW_STEP : MODEL_STEP);
			continue;
		}
		if (outcome === "credential") {
			direction = 1;
			cursor = STEPS.indexOf(CREDENTIAL_STEP);
			continue;
		}
		if (outcome === "fix") {
			direction = 1;
			cursor = STEPS.indexOf(fixStep(answers));
			continue;
		}
		// Leaving the list "Choose a different model" opened returns to the review with the model unchanged.
		if (outcome === "back" && step === MODEL_STEP && answers.chooseModel && firstRunFlow(answers)) {
			answers.chooseModel = undefined;
			if (answers.model !== undefined) wizard.answer("Model", answers.model);
			cursor = STEPS.indexOf(REVIEW_STEP);
			continue;
		}
		if (outcome === "back") {
			if (answers.detectedChatRoute) {
				cursor = 0;
				writer.rewindTo(marks[0] ?? writer.mark());
				continue;
			}
			direction = -1;
			cursor -= 1;
			// Rewind past the row the step we are returning to left behind, so it
			// can ask again in the same place rather than under its own answer.
			while (cursor >= 0 && !(STEPS[cursor]?.applies(answers) ?? false)) cursor -= 1;
			if (cursor < 0) return stop();
			writer.rewindTo(marks[cursor] ?? writer.mark());
			continue;
		}
		direction = 1;
		cursor += 1;
	}

	if (host?.cancelled()) return stop(true);
	return finish(wizard, answers);
}

function cancel(
	presenter: LifecyclePresenter,
	answers: Answers,
	options: { quit?: boolean; advise?: boolean } = {},
): number {
	// A first-run cancel really does leave Clio unconfigured, which is why this
	// exits 130 where leaving the settings menu exits 0. It is still the user's
	// choice and not a failure, so the rail says it once and nothing follows on
	// stderr; the closing line used to be chased by `error: configuration cancelled`.
	if (answers.signInLater !== undefined && !options.quit) {
		presenter.commandAdvice(
			"Nothing was saved. When you are ready:",
			`clio-coder auth login ${answers.signInLater}, then clio-coder`,
		);
		presenter.done("Nothing was saved");
		return answers.mode === "first" ? 130 : 0;
	}
	if (answers.mode === "first" && options.advise !== false)
		presenter.commandAdvice(
			"Clio cannot start until a model is set up. When you are ready, run:",
			"clio-coder configure",
		);
	presenter.done("Cancelled; nothing was saved");
	return answers.mode === "first" || options.quit === true ? 130 : 0;
}

async function finish(wizard: Wizard, answers: Answers): Promise<number> {
	const runtime = answers.runtime;
	// The id was derived when the runtime was chosen; another window can have taken it since.
	if (answers.mode !== "edit" && answers.runtime && answers.targetId !== undefined) {
		const taken = readSettings().targets;
		if (taken.some((target) => target.id === answers.targetId))
			answers.targetId = deriveTargetId(answers.runtime.id, taken);
	}
	const targetId = answers.targetId;
	if (!runtime || targetId === undefined)
		return cancel(wizard.presenter, answers, { advise: wizard.host === undefined });
	const presenter = wizard.presenter;

	const reasoning =
		PROTOCOL_COMPAT_RUNTIME_IDS.has(runtime.id) && answers.thinking !== undefined
			? answers.thinking !== "off"
			: undefined;
	const descriptor = draftDescriptor(answers, runtime, true);
	descriptor.capabilities = { ...descriptor.capabilities };
	if (reasoning !== undefined) descriptor.capabilities.reasoning = reasoning;
	// Clearing the field removes only that capability override.
	if (answers.contextWindow === undefined) delete descriptor.capabilities.contextWindow;
	else descriptor.capabilities.contextWindow = answers.contextWindow;
	const chatEligible = isOrchestratorEligibleRuntime(runtime);

	try {
		const preview = readSettings();
		applyAnswers(preview, answers, descriptor, chatEligible);
		const validated = validateSettings(preview);
		if (validated.issues.length) throw new SettingsValidationError(validated.issues);
		initializeClioHome();

		if (answers.apiKeyLiteral !== undefined && descriptor.auth?.apiKeyRef) {
			const auth = openAuthStorage();
			auth.setApiKey(descriptor.auth.apiKeyRef, answers.apiKeyLiteral);
			// The settings write is still ahead of us, so refusing here leaves the
			// whole run without an effect rather than half of one.
			if (
				wizard.host
					? auth.damageReason() !== null
					: credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; target '${targetId}' not saved`)
			) {
				if (wizard.host) presenter.fail("Credential not stored", auth.damageReason() ?? "unknown");
				presenter.done("Nothing written");
				return 1;
			}
			// Inside the TUI the flag is not something the operator can type; the credential step's choice is.
			presenter.warn(
				wizard.host
					? "API key stored unencrypted (mode 0600). Any process running as you can read it. Edit the target and choose Environment variable to keep the key off disk."
					: "API key stored unencrypted (mode 0600). Any process running as you can read it. Use --api-key-env <VAR> to keep the key off disk.",
			);
		}

		updateSettings((settings) => applyAnswers(settings, answers, descriptor, chatEligible));
		if (typeof answers.tested === "object" && answers.model !== undefined)
			recordTargetCheck(descriptor, answers.model, answers.tested.latencyMs);
		wizard.host?.onTargetSaved?.();
	} catch (error) {
		presenter.fail("settings were not written", error instanceof Error ? error.message : String(error));
		presenter.done("Target settings not saved");
		return 1;
	}

	presenter.completedStep(`target ${targetId} saved, runtime ${runtime.id}`);
	if (answers.mode === "first" && chatEligible)
		presenter.completedStep(`chat runs on ${targetId}${answers.model ? `, model ${answers.model}` : ""}`);
	else if (!chatEligible)
		presenter.completedStep(`${runtime.id} cannot answer chat; ${targetId} is registered for dispatch only`);
	if (answers.mode === "first") presenter.completedStep(`fleet default is ${targetId}`);
	else presenter.note("Use Settings → Chat, Fleet, or Context & Memory to change model defaults.");
	if (answers.mode === "first" && answers.thinking !== undefined)
		presenter.completedStep(`thinking level ${answers.thinking}`);
	presenter.completedStep(`settings written to ${shortenPath(settingsPath())}`);
	if (typeof answers.tested === "object")
		presenter.completedStep(
			answers.mode === "first"
				? "Saved. Chat and workers use this model. Change it any time with /model or /config."
				: "Saved. The model answered its test request.",
		);
	else if (answers.tested === "skipped") presenter.warn(`${targetId} was saved without a passed test request.`);

	if (contextWindowUndiscovered(descriptor, answers.probe ?? null)) {
		presenter.warn(
			wizard.host
				? `${targetId} reported no context window, so Clio will use the runtime default as a guess. Set the real one in Settings → Connections: select ${targetId} and choose Edit.`
				: `${targetId} reported no context window, so Clio will use the runtime default as a guess. Set the real one with \`clio-coder configure --id ${targetId} --runtime ${runtime.id} --context-window <N>\`.`,
		);
	}

	if (!wizard.host) {
		if (!wizard.startsChat) presenter.commandAdvice("Start Clio:", "clio-coder");
		presenter.commandAdvice("Change any of this later:", "clio-coder configure");
	}
	presenter.done("Done");
	return 0;
}
