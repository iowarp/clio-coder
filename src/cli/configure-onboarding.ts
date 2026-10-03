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
	bindAgentProfileInSettings,
	readSettings,
	SettingsValidationError,
	settingsPath,
	updateSettings,
	validateSettings,
} from "../core/config.js";
import type { ThinkingLevel } from "../core/defaults.js";
import { THINKING_LEVELS } from "../core/defaults.js";
import { initializeClioHome } from "../core/init.js";
import { resolveOnPath } from "../domains/interop/detect.js";
import { ensureClaudeAgentSdk } from "../domains/lifecycle/claude-sdk-install.js";
import { authStoragePath, openAuthStorage, targetRequiresAuth } from "../domains/providers/auth/index.js";
import type { ProviderSupportEntry } from "../domains/providers/index.js";
import {
	buildProviderSupportEntry,
	isOrchestratorEligibleRuntime,
	listProviderSupportEntries,
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
import type { ConfigureWizardHost } from "./configure-host.js";
import { reviewInteropAgents } from "./configure-interop.js";
import type { ConfigureCategory } from "./configure-layout.js";
import { CONFIGURE_CATEGORY_CHOICES } from "./configure-layout.js";
import { loginOAuthRuntime } from "./configure-oauth.js";
import type { WireModelInventory } from "./configure-target.js";
import {
	applyTarget,
	assertOrchestratorReplacementEligible,
	buildDescriptor,
	contextWindowUndiscovered,
	deriveTargetId,
	describeAuthStatus,
	gatewayUrlGuidance,
	inventoryGap,
	inventoryNote,
	modelChoiceRefusal,
	modelSupportsThinking,
	normalizeUrl,
	offeredUrlFor,
	PROTOCOL_COMPAT_RUNTIME_IDS,
	preferredModelFor,
	probeReadings,
	railPrefix,
	resolveSupportedWireModels,
	runtimeProbe,
	runtimesForCategory,
	setOrchestratorPointer,
	setWorkerDefaultPointer,
	setWorkerProfilePointer,
	targetApiKeyRef,
} from "./configure-target.js";
import type { DetectedChatRoute } from "./detect-chat-routes.js";
import type { LifecyclePresenter } from "./lifecycle-presenter.js";
import { createLifecyclePresenter, shortenPath } from "./lifecycle-presenter.js";
import { canSelect, promptSelect, promptText } from "./select.js";
import { credentialWriteFailed, printPlaintextCredentialWarning } from "./shared.js";
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
	detectedChatRoute?: DetectedChatRoute | undefined;
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
	apiKeyEnv?: string | undefined;
	apiKeyLiteral?: string | undefined;
	inventory?: WireModelInventory | undefined;
	/** The inputs the cached inventory was read for, so a changed URL re-reads it. */
	inventoryKey?: string | undefined;
	model?: string | undefined;
	thinking?: ThinkingLevel | undefined;
	probe?: ProbeResult | null | undefined;
	antigravity?: { targetId: string; model: string } | undefined;
}

type StepOutcome = "next" | "back" | "quit" | "cancel" | "credential" | "detected";

interface Wizard {
	detectedRoutes: ReadonlyArray<DetectedChatRoute>;
	select: ConfigureWizardHost["select"];
	text: ConfigureWizardHost["text"];
	host?: ConfigureWizardHost;
	streams: OnboardingStreams;
	presenter: LifecyclePresenter;
	rail: string;
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	/** Row on the rail, at the wizard's shared label column. */
	answer: (label: string, value: string) => void;
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

const CATEGORY_STEP: Step = {
	id: "category",
	applies: (answers) => answers.mode !== "edit" && !answers.fixedRuntime,
	run: async (wizard, answers) => {
		const registry = getRuntimeRegistry();
		const eligible = allEntries().filter((entry) => {
			const runtime = registry.get(entry.runtimeId);
			return runtime !== null && (answers.mode !== "first" || isOrchestratorEligibleRuntime(runtime));
		});
		const available = CONFIGURE_CATEGORY_CHOICES.filter(
			(choice) => runtimesForCategory(eligible, choice.category).length > 0,
		);
		const current = available.findIndex((choice) => choice.category === answers.category);
		const result = await wizard.select<ConfigureCategory | DetectedChatRoute>({
			heading: [
				"",
				chalk.bold("Where does your model come from?"),
				chalk.dim("Choose the description you recognize; Clio shows the exact providers next."),
			],
			choices: [
				...wizard.detectedRoutes.map((route) => ({
					value: route,
					label: `Use ${route.runtime.id} / ${route.model ?? "choose model"}`,
					hint: `from ${route.source}`,
				})),
				...available.map((choice) => ({
					value: choice.category,
					label: choice.label,
					hint: choice.summary,
				})),
			],
			initialIndex: current >= 0 ? current + wizard.detectedRoutes.length : 0,
			railPrefix: wizard.rail,
			backLabel: "cancel",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (typeof result.value !== "string") {
			const route = result.value;
			answers.detectedChatRoute = route;
			answers.runtime = route.runtime;
			answers.targetId = route.target.id;
			answers.url = route.target.url;
			answers.model = route.model;
			answers.apiKeyEnv = route.target.auth?.apiKeyEnvVar;
			answers.credential = answers.apiKeyEnv ? "env" : route.target.auth?.apiKeyRef ? "keep" : undefined;
			answers.apiKeyLiteral = undefined;
			answers.thinking = undefined;
			answers.contextWindow = route.target.capabilities?.contextWindow;
			answers.probe = route.source.startsWith("http://127.0.0.1:")
				? { ok: true, models: route.model ? [route.model] : [] }
				: undefined;
			answers.inventory = { models: route.model ? [route.model] : [], source: answers.probe ? "probe" : "catalog" };
			answers.inventoryKey = undefined;
			wizard.answer("Source", route.source);
			wizard.answer("Provider", route.runtime.id);
			return "detected";
		}
		if (answers.detectedChatRoute) answers.runtime = undefined;
		answers.detectedChatRoute = undefined;
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
	applies: (answers) => !answers.fixedRuntime,
	run: async (wizard, answers) => {
		const registry = getRuntimeRegistry();
		const chatEntries = allEntries().filter((entry) => {
			const runtime = registry.get(entry.runtimeId);
			return runtime !== null && (answers.mode !== "first" || isOrchestratorEligibleRuntime(runtime));
		});
		const entries = answers.category ? runtimesForCategory(chatEntries, answers.category) : chatEntries;
		const usable = entries.length > 0 ? entries : chatEntries;
		const previous = usable.findIndex((entry) => entry.runtimeId === answers.runtime?.id);
		const featured = usable.findIndex((entry) => entry.featured);
		const result = await wizard.select<string>({
			heading: [
				"",
				chalk.bold("Which provider or app do you use?"),
				chalk.dim("The runtime id in each description is Clio's internal adapter name."),
			],
			choices: usable.map((entry) => ({
				value: entry.runtimeId,
				label: entry.label,
				hint: `${entry.summary} · runtime ${entry.runtimeId}`,
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
			answers.credential = undefined;
			answers.apiKeyEnv = undefined;
			answers.apiKeyLiteral = undefined;
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

const URL_STEP: Step = {
	id: "url",
	applies: (answers) => answers.runtime !== undefined && supportFor(answers.runtime).supportsCustomUrl,
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const local = supportFor(runtime).group === "local-http";
		const gateway = runtime.gatewayUrl;
		const result = await wizard.text({
			heading: [
				"",
				chalk.bold(gateway?.label ?? (local ? "Where is the server?" : "Base URL")),
				...gatewayUrlGuidance(runtime).map((line) => chalk.dim(line)),
			],
			initial: answers.url ?? offeredUrlFor(runtime) ?? "",
			hint: gateway
				? "paste the whole URL, scheme and path included"
				: "host:port is enough; Clio fills in the scheme and the port it knows",
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			validate: (value) =>
				value.length === 0 ? (gateway ? `the ${gateway.label} is required` : "a URL is required for this runtime") : null,
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		const url = normalizeUrl(result.value, runtime.id);
		if (answers.url !== url) {
			answers.inventoryKey = undefined;
			answers.detected = undefined;
		}
		answers.url = url;
		wizard.answer("URL", url);
		const authenticated = await reportReachability(wizard, answers, runtime, url);
		if (!authenticated && runtime.auth === "api-key") {
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
): Promise<boolean> {
	const draft = draftDescriptor(answers, runtime, false);
	// A freshly typed "store the key" answer is not on disk yet (that write
	// happens at the end of the wizard), so it has to ride along as an explicit
	// token the same way the model step already does; env and stored-from-before
	// credentials resolve on their own through the descriptor's auth fields.
	const probe = await runtimeProbe(runtime, draft, answers.apiKeyLiteral);
	if (probe !== null) {
		if (probe.ok) {
			const readings = probeReadings(probe);
			wizard.presenter.step(
				`${runtime.id === "alcf" ? "ALCF catalog reachable; inference URL not checked" : "reachable"}, ${readings.length > 0 ? readings.join(", ") : "no model list offered"}`,
			);
		} else if (probe.authFailed) {
			wizard.presenter.warn("Authentication failed. Choose a credential for this server before selecting a model.");
			return false;
		} else {
			wizard.presenter.warn(`not reachable, you can fix this later: ${probe.error ?? "no reply"}`);
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
async function connectOAuth(wizard: Wizard, runtime: RuntimeDescriptor): Promise<boolean> {
	if (wizard.host) return loginOAuthRuntime(null, runtime, wizard.host);
	const rl = createInterface({ input: wizard.streams.in, output: wizard.streams.out });
	try {
		return await loginOAuthRuntime(rl, runtime);
	} finally {
		rl.close();
	}
}

const CREDENTIAL_STEP: Step = {
	id: "credential",
	applies: (answers) => answers.runtime?.auth === "api-key" || answers.runtime?.auth === "oauth",
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const stored = describeAuthStatus(runtime, answers.existing);
		if (runtime.auth === "oauth") {
			const result = await wizard.select<CredentialSource>({
				heading: [
					"",
					chalk.bold(`Sign in to ${runtime.displayName}`),
					chalk.dim(`credential: ${stored}`),
					"Sign-in stores credentials immediately; target settings wait for Save.",
				],
				choices: [
					{ value: "oauth-connect", label: "Connect now", hint: "opens your browser and waits for the callback" },
					{
						value: "oauth-skip",
						label: "Later",
						hint: `run \`clio-coder auth login ${runtime.id}\` before the first turn`,
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
				if (!connected) {
					wizard.presenter.warn(`sign-in did not complete; run \`clio-coder auth login ${runtime.id}\` when ready`);
					wizard.answer("Credential", "not connected yet");
					return "next";
				}
				wizard.answer("Credential", `connected to ${runtime.id}`);
				return "next";
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
		const current = answers.credential ?? defaultCredentialSource(runtime, answers.targetId ?? runtime.id);
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
	applies: (answers) => answers.credential === "env" || answers.credential === "stored",
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
				value.length > 0
					? null
					: `Enter ${wantsEnv ? "an environment variable" : "a key"}, or press Escape to choose No key.`,
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
		wizard.answer("Credential", result.value.length > 0 ? "stored in credentials.yaml" : "none");
		return "next";
	},
};

/** Read the model list once per distinct set of connection answers. */
async function modelInventory(answers: Answers, runtime: RuntimeDescriptor): Promise<WireModelInventory> {
	const key = [
		runtime.id,
		answers.targetId,
		answers.url,
		answers.apiKeyEnv,
		answers.apiKeyLiteral ? "literal" : "",
	].join("|");
	if (answers.inventoryKey === key && answers.inventory) return answers.inventory;
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
		const inventory = await modelInventory(answers, runtime);
		// A catalog-ordered list has no head worth recommending: openai's first of
		// 38 ids is `gpt-4` because g sorts early.
		const preferred = answers.model ?? preferredModelFor(inventory, support);

		if (inventory.models.length === 0) {
			const gap = inventoryGap(runtime, { url: answers.url }, inventory.probeError);
			wizard.presenter.warn(gap);
			const canDetect = runtimeListsModelsLive(runtime);
			const result = await wizard.select<"retry" | "back" | "manual">({
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

		const selected = inventory.models.indexOf(preferred ?? "");
		const result = await wizard.select<string>({
			heading: [
				"",
				chalk.bold("Which model?"),
				chalk.dim(inventoryNote(runtime, inventory) ?? "read live from the target just now"),
			],
			choices: inventory.models.map((model) => {
				const state = inventory.modelStates?.[model]?.state;
				const hint = model === preferred ? "default" : state !== undefined && state !== "unknown" ? state : undefined;
				const label = inventory.labels?.[model];
				return {
					value: model,
					label: label && label !== model ? `${model} — ${label}` : model,
					...(hint === undefined ? {} : { hint }),
				};
			}),
			initialIndex: selected >= 0 ? selected : 0,
			searchable: inventory.models.length > 8,
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

const ANTIGRAVITY_COLLEAGUE_STEP: Step = {
	id: "antigravity-colleague",
	applies: (answers) =>
		answers.mode === "first" &&
		answers.runtime !== undefined &&
		isOrchestratorEligibleRuntime(answers.runtime) &&
		resolveOnPath(["agy"]).presence === "present" &&
		!readSettings().targets.some((target) => target.runtime === "antigravity-code"),
	run: async (wizard, answers) => {
		const runtime = getRuntimeRegistry().get("antigravity-code");
		if (!runtime) return "next";
		const choice = await wizard.select<boolean>({
			heading: [
				"",
				chalk.bold("Add your local Antigravity research colleague?"),
				chalk.dim("optional, experimental, dispatch-only; Clio does not authenticate or inspect its session"),
			],
			choices: [
				{ value: false, label: "Not now", hint: "your primary Clio target is unchanged" },
				{ value: true, label: "Add read-only colleague", hint: "probe the non-generating model catalog" },
			],
			initialIndex: answers.antigravity ? 1 : 0,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (choice.kind === "quit") return "quit";
		if (choice.kind === "back") return "back";
		if (!choice.value) {
			answers.antigravity = undefined;
			wizard.answer("Colleague", "not added");
			return "next";
		}
		const targetId = deriveTargetId(runtime.id, readSettings().targets);
		const descriptor = buildDescriptor(runtime, targetId, {});
		const inventory = await resolveSupportedWireModels(runtime, descriptor);
		if (inventory.source !== "probe" || inventory.models.length === 0) {
			answers.antigravity = undefined;
			wizard.presenter.warn(
				inventory.probeError ??
					"Antigravity did not return a live catalog. Run `agy` yourself, complete sign-in, then add it from Configure → Targets.",
			);
			wizard.answer("Colleague", "not added; sign in with agy first");
			return "next";
		}
		const picked = await wizard.select<string>({
			heading: ["", chalk.bold("Antigravity research model"), chalk.dim("live account catalog")],
			choices: inventory.models.map((model) => ({
				value: model,
				label: inventory.labels?.[model] ? `${model} — ${inventory.labels[model]}` : model,
			})),
			initialIndex: 0,
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			input: wizard.input,
			output: wizard.output,
		});
		if (picked.kind === "quit") return "quit";
		if (picked.kind === "back") return "back";
		answers.antigravity = { targetId, model: picked.value };
		wizard.answer("Colleague", `${targetId}/${picked.value} → world-knowledge`);
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
			: "Endpoint: reachability not verified";
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
					"No generation or quality/tool tests.",
					"GPU/VRAM and model fit not checked.",
					`Automatic local workers: ${capacity.limit}`,
					answers.mode === "first" ? "Save sets the chat and fleet model." : "Existing routes stay in place.",
				],
				choices: [
					{ value: "save", label: "Save target" },
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

// Credential steps come before the URL step: a runtime that needs or may need a
// key (litellm, every cloud runtime, keyed openai-compat) has to have one in
// hand before the URL step probes reachability, or the probe reads as
// unreachable when the gateway is live and only the key was missing. A runtime
// with no credential at all skips both credential steps and keeps this order
// exactly as it was.
const STEPS: ReadonlyArray<Step> = [
	CATEGORY_STEP,
	RUNTIME_STEP,
	SDK_STEP,
	CREDENTIAL_STEP,
	CREDENTIAL_VALUE_STEP,
	URL_STEP,
	DETECTED_RUNTIME_STEP,
	MODEL_STEP,
	THINKING_STEP,
	CONTEXT_STEP,
	ANTIGRAVITY_COLLEAGUE_STEP,
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
	if (answers.antigravity !== undefined) {
		const antigravityRuntime = getRuntimeRegistry().get("antigravity-code");
		if (!antigravityRuntime) throw new Error("Antigravity runtime disappeared before settings were written");
		const external = buildDescriptor(antigravityRuntime, answers.antigravity.targetId, {
			model: answers.antigravity.model,
		});
		applyTarget(settings, external);
		setWorkerProfilePointer(settings, "world-knowledge-external", external, answers.antigravity.model);
		bindAgentProfileInSettings(settings, "world-knowledge", "world-knowledge-external");
	}
}

export async function runOnboardingWizard(
	streams: OnboardingStreams,
	options: { mode: "first" | "add"; runtime?: RuntimeDescriptor } | { mode: "edit"; target: TargetDescriptor } = {
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
		detectedRoutes: [],
		select: host?.select.bind(host) ?? promptSelect,
		text: host?.text.bind(host) ?? promptText,
		...(host ? { host } : {}),
		streams,
		presenter,
		rail,
		input: streams.in as NodeJS.ReadStream,
		output: streams.out as NodeJS.WriteStream,
		answer: (label, value) => {
			presenter.fields([[label.padEnd(LABEL_WIDTH), truncate(value, Math.max(12, columns - LABEL_WIDTH - 6))]]);
		},
	};

	presenter.header(
		options.mode === "edit"
			? `Edit target: ${options.target.id}`
			: options.mode === "first"
				? "Welcome to Clio Coder"
				: "Add a target",
		"configure",
	);
	presenter.note("Choose what you already use. Clio checks the endpoint and model list when the provider allows it.");
	// "Nothing is saved" read as false to a first-run user who then found the
	// settings.yaml and credentials.yaml templates the home bootstrap writes. Those
	// hold no choice of theirs; the sentence is about the choices.
	presenter.note("Escape goes back. Your choices are saved only at the review, except a browser sign-in you complete.");
	presenter.note(`Saved result: ${shortenPath(settingsPath())}`);

	const existing = options.mode === "edit" ? options.target : undefined;
	if (options.mode === "first" && !options.runtime) {
		const settings = readSettings();
		const { classifyDefaultTarget } = await import("./default-target.js");
		if (classifyDefaultTarget(settings).kind !== "usable") {
			const { detectChatRoutes } = await import("./detect-chat-routes.js");
			wizard.detectedRoutes = await detectChatRoutes(settings);
		}
	}
	const answers: Answers = {
		mode: options.mode,
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
		const outcome = await step.run(wizard, answers);
		if (outcome === "quit" || outcome === "cancel") return stop(outcome === "quit");
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
	const code = finish(wizard, answers);
	if (code === 0 && answers.mode === "first") {
		await reviewInteropAgents({ rl: null, streams, presenter, rail, quiet: true });
	}
	return code;
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
	if (answers.mode === "first" && options.advise !== false)
		presenter.commandAdvice("Set up later:", "clio-coder configure");
	presenter.done("Cancelled; target settings not saved");
	return answers.mode === "first" || options.quit === true ? 130 : 0;
}

function finish(wizard: Wizard, answers: Answers): number {
	const runtime = answers.runtime;
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
			if (wizard.host) presenter.warn("Credentials are stored with mode 0600, not encrypted.");
			else printPlaintextCredentialWarning();
		}

		updateSettings((settings) => applyAnswers(settings, answers, descriptor, chatEligible));
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
	if (answers.antigravity !== undefined) {
		presenter.completedStep(
			`world-knowledge bound read-only to ${answers.antigravity.targetId}/${answers.antigravity.model}`,
		);
	}
	presenter.completedStep(`settings written to ${shortenPath(settingsPath())}`);

	if (contextWindowUndiscovered(descriptor, answers.probe ?? null)) {
		presenter.warn(
			`${targetId} reported no context window, so Clio will use the runtime default as a guess. Set the real one with \`clio-coder configure --id ${targetId} --runtime ${runtime.id} --context-window <N>\`.`,
		);
	}

	if (!wizard.host) {
		presenter.commandAdvice("Start Clio:", "clio-coder");
		presenter.commandAdvice("Change any of this later:", "clio-coder configure");
	}
	presenter.done("Done");
	return 0;
}
