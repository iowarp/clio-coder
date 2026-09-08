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

import {
	bindAgentProfileInSettings,
	type ClioSettings,
	readSettings,
	SettingsValidationError,
	settingsPath,
	updateSettings,
	validateSettings,
} from "../core/config.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../core/defaults.js";
import { initializeClioHome } from "../core/init.js";
import { resolveOnPath } from "../domains/interop/detect.js";
import { authStoragePath, openAuthStorage, targetRequiresAuth } from "../domains/providers/auth/index.js";
import {
	buildProviderSupportEntry,
	isOrchestratorEligibleRuntime,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	recordTargetModelSnapshot,
	resolveRuntimeAuthTarget,
} from "../domains/providers/index.js";
import { fingerprintNativeRuntime } from "../domains/providers/probe/fingerprint.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { greetLmStudio } from "../domains/providers/runtimes/common/lmstudio-http.js";
import type { ProbeResult, RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import { reviewInteropAgents } from "./configure-interop.js";
import { CONFIGURE_CATEGORY_CHOICES, type ConfigureCategory } from "./configure-layout.js";
import { loginOAuthRuntime } from "./configure-oauth.js";
import {
	applyTarget,
	buildDescriptor,
	contextWindowUndiscovered,
	defaultUrlFor,
	deriveTargetId,
	describeAuthStatus,
	inventoryGap,
	modelChoiceRefusal,
	modelSupportsThinking,
	normalizeUrl,
	PROTOCOL_COMPAT_RUNTIME_IDS,
	probeReadings,
	railPrefix,
	resolveSupportedWireModels,
	runtimeProbe,
	runtimesForCategory,
	setOrchestratorPointer,
	setWorkerDefaultPointer,
	setWorkerProfilePointer,
	targetApiKeyRef,
	type WireModelInventory,
} from "./configure-target.js";
import { createLifecyclePresenter, type LifecyclePresenter, shortenPath } from "./lifecycle-presenter.js";
import { canSelect, promptSelect, promptText } from "./select.js";
import { credentialWriteFailed, printError, printPlaintextCredentialWarning } from "./shared.js";
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

type StepOutcome = "next" | "back" | "quit" | "cancel";

interface Wizard {
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
	const descriptor = { ...answers.existing, ...configured };
	if (!withModel) delete descriptor.defaultModel;
	if (answers.existing?.auth || configured.auth) {
		descriptor.auth = { ...answers.existing?.auth, ...configured.auth };
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
		const current = CONFIGURE_CATEGORY_CHOICES.findIndex((choice) => choice.category === answers.category);
		const result = await promptSelect<ConfigureCategory>({
			heading: ["", chalk.bold("How will you connect Clio to a model?")],
			choices: CONFIGURE_CATEGORY_CHOICES.map((choice) => ({
				value: choice.category,
				label: choice.label,
				hint: choice.summary,
			})),
			initialIndex: current >= 0 ? current : 0,
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
		const choice = CONFIGURE_CATEGORY_CHOICES.find((entry) => entry.category === result.value);
		wizard.answer("Connection", choice?.label ?? result.value);
		return "next";
	},
};

const RUNTIME_STEP: Step = {
	id: "runtime",
	applies: (answers) => answers.mode !== "edit" && !answers.fixedRuntime,
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
		const result = await promptSelect<string>({
			heading: ["", chalk.bold("Which runtime?")],
			choices: usable.map((entry) => ({ value: entry.runtimeId, label: entry.runtimeId, hint: entry.summary })),
			initialIndex: previous >= 0 ? previous : featured >= 0 ? featured : 0,
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
			answers.targetId = undefined;
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
		wizard.answer("Runtime", `${runtime.id}  ${chalk.dim(supportFor(runtime).summary)}`);
		return "next";
	},
};

const TARGET_ID_STEP: Step = {
	id: "target-id",
	applies: (answers) => answers.mode !== "edit",
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const result = await promptText({
			heading: ["", chalk.bold("Target id")],
			initial: answers.targetId ?? deriveTargetId(runtime.id, readSettings().targets),
			hint: "the name you will use for this target in `clio-coder targets`",
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			validate: (value) => {
				if (value.length === 0) return "a target id is required";
				if (/\s/u.test(value)) return "a target id cannot contain spaces";
				if (readSettings().targets.some((target) => target.id === value))
					return "that target id already exists; choose another or use Edit a target";
				return null;
			},
			input: wizard.input,
			output: wizard.output,
		});
		if (result.kind === "quit") return "quit";
		if (result.kind === "back") return "back";
		if (answers.targetId !== result.value) answers.inventoryKey = undefined;
		answers.targetId = result.value;
		wizard.answer("Target id", result.value);
		return "next";
	},
};

const URL_STEP: Step = {
	id: "url",
	applies: (answers) => answers.runtime !== undefined && supportFor(answers.runtime).supportsCustomUrl,
	run: async (wizard, answers) => {
		const runtime = answers.runtime;
		if (!runtime) return "back";
		const local = supportFor(runtime).group === "local-http";
		const result = await promptText({
			heading: ["", chalk.bold(local ? "Where is the server?" : "Base URL")],
			initial: answers.url ?? defaultUrlFor(runtime.id),
			hint: "host:port is enough; Clio fills in the scheme and the port it knows",
			railPrefix: wizard.rail,
			backLabel: "back",
			clearOnExit: true,
			validate: (value) => (value.length === 0 ? "a URL is required for this runtime" : null),
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
		await reportReachability(wizard, answers, runtime, url);
		return "next";
	},
};

/**
 * Say what is at the URL, and never refuse over it.
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
): Promise<void> {
	const draft = draftDescriptor(answers, runtime, false);
	// A freshly typed "store the key" answer is not on disk yet (that write
	// happens at the end of the wizard), so it has to ride along as an explicit
	// token the same way the model step already does; env and stored-from-before
	// credentials resolve on their own through the descriptor's auth fields.
	const probe = await runtimeProbe(runtime, draft, answers.apiKeyLiteral);
	if (probe !== null) {
		if (probe.ok) {
			const readings = probeReadings(probe);
			wizard.presenter.step(`reachable, ${readings.length > 0 ? readings.join(", ") : "no model list offered"}`);
		} else if (probe.authFailed) {
			wizard.presenter.warn("rejected the key");
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
		const result = await promptSelect<boolean>({
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
	// A local llama.cpp server wants no credential, and offering `env` sent the
	// user to an unexplained variable name with nothing correct to type into it.
	return targetRequiresAuth({ id: targetId, runtime: runtime.id }, runtime) ? "env" : "skip";
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
			const result = await promptSelect<CredentialSource>({
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
			{ value: "skip" as CredentialSource, label: "No key", hint: "this target needs no credential" },
		];
		const current = answers.credential ?? defaultCredentialSource(runtime, answers.targetId ?? runtime.id);
		const initial = Math.max(
			0,
			choices.findIndex((choice) => choice.value === current),
		);
		const result = await promptSelect<CredentialSource>({
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
		const result = await promptText({
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
		const catalogOrdered = support.modelSource === "catalog";
		const preferred =
			answers.model ??
			(inventory.source === "probe" ? inventory.models[0] : support.defaultModel) ??
			(catalogOrdered ? undefined : inventory.models[0]) ??
			undefined;

		if (inventory.models.length === 0) {
			wizard.presenter.warn(inventoryGap(runtime, { url: answers.url }));
			const result = await promptText({
				heading: ["", chalk.bold("Which model?")],
				initial: preferred ?? "",
				hint: "the wire id the provider documents; Clio sends it as written",
				railPrefix: wizard.rail,
				backLabel: "back",
				clearOnExit: true,
				validate: (value) => (value.length === 0 ? "a model id is required" : null),
				input: wizard.input,
				output: wizard.output,
			});
			if (result.kind === "quit") return "quit";
			if (result.kind === "back") return "back";
			answers.model = result.value;
			wizard.answer("Model", result.value);
			await readModelCapabilities(answers, runtime);
			return "next";
		}

		const selected = inventory.models.indexOf(preferred ?? "");
		const result = await promptSelect<string>({
			heading: [
				"",
				chalk.bold("Which model?"),
				chalk.dim(
					inventory.source === "probe"
						? "read live from the target just now"
						: inventory.source === "cache"
							? "cached model snapshot; not verified in this run"
							: "model hints; not a live account catalog",
				),
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
		if (answers.mode !== "first" && !PROTOCOL_COMPAT_RUNTIME_IDS.has(answers.runtime?.id ?? "")) return false;
		const runtime = answers.runtime;
		if (!runtime || answers.model === undefined) return false;
		// A generic OpenAI/Anthropic-compatible endpoint reports nothing about
		// reasoning, so the answer here is also what tells Clio whether the model
		// has it at all.
		if (PROTOCOL_COMPAT_RUNTIME_IDS.has(runtime.id)) return true;
		return modelSupportsThinking(runtime, draftDescriptor(answers, runtime, true), answers.probe ?? null);
	},
	run: async (wizard, answers) => {
		const current = THINKING_LEVELS.indexOf(answers.thinking ?? "low");
		const result = await promptSelect<ThinkingLevel>({
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
		const choice = await promptSelect<boolean>({
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
		const picked = await promptSelect<string>({
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
	applies: (answers) => PROTOCOL_COMPAT_RUNTIME_IDS.has(answers.runtime?.id ?? "") || answers.mode === "edit",
	run: async (wizard, answers) => {
		const result = await promptText({
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

const REVIEW_STEP: Step = {
	id: "review",
	applies: () => true,
	run: async (wizard, answers) => {
		const result = await promptSelect({
			heading: [
				"",
				chalk.bold("Review target"),
				`${answers.targetId} · ${answers.runtime?.id} · ${answers.model}`,
				answers.mode === "first"
					? "Use for chat and fleet."
					: "Existing chat, fleet, memory, and profile defaults stay in place.",
				"Escape returns to the previous step; settings are saved only when you choose Save.",
			],
			choices: [
				{ value: "save", label: "Save target" },
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
		return result.value === "save" ? "next" : result.value === "back" ? "back" : "cancel";
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
	TARGET_ID_STEP,
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
	} else if (current) throw new Error(`Target '${descriptor.id}' already exists; use Edit a target.`);
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
): Promise<number> {
	const writer = railWriter(streams.out);
	const presenter = createLifecyclePresenter({ stream: writer.stream });
	const rail = railPrefix(presenter.isPlain());
	const columns = (streams.out as { columns?: number }).columns ?? 80;
	const wizard: Wizard = {
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
	presenter.note("Pick a model; escape goes back. Review and save when ready.");
	presenter.note(`Result: ${shortenPath(settingsPath())}`);

	const existing = options.mode === "edit" ? options.target : undefined;
	const answers: Answers = {
		mode: options.mode,
		existing,
		runtime: existing
			? (getRuntimeRegistry().get(existing.runtime) ?? undefined)
			: options.mode !== "edit"
				? options.runtime
				: undefined,
		fixedRuntime: options.mode !== "edit" && options.runtime !== undefined,
		targetId: existing?.id,
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
	const marks = new Array<number>(STEPS.length).fill(writer.mark());
	let cursor = 0;
	let direction = 1;

	while (cursor < STEPS.length) {
		const step = STEPS[cursor];
		if (step === undefined) break;
		if (!step.applies(answers)) {
			cursor += direction;
			if (cursor < 0) return cancel(presenter, answers);
			continue;
		}
		marks[cursor] = writer.mark();
		const outcome = await step.run(wizard, answers);
		if (outcome === "quit" || outcome === "cancel") return cancel(presenter, answers, outcome === "quit");
		if (outcome === "back") {
			direction = -1;
			cursor -= 1;
			// Rewind past the row the step we are returning to left behind, so it
			// can ask again in the same place rather than under its own answer.
			while (cursor >= 0 && !(STEPS[cursor]?.applies(answers) ?? false)) cursor -= 1;
			if (cursor < 0) return cancel(presenter, answers);
			writer.rewindTo(marks[cursor] ?? writer.mark());
			continue;
		}
		direction = 1;
		cursor += 1;
	}

	const code = finish(wizard, answers);
	if (code === 0 && answers.mode === "first") {
		await reviewInteropAgents({ rl: null, streams, presenter, rail, quiet: true });
	}
	return code;
}

function cancel(presenter: LifecyclePresenter, answers: Answers, quit = false): number {
	// A first-run cancel really does leave Clio unconfigured, which is why this
	// exits 130 where leaving the settings menu exits 0.
	presenter.done("Cancelled; target settings not saved");
	if (answers.mode === "first") printError("configuration cancelled");
	return answers.mode === "first" || quit ? 130 : 0;
}

function finish(wizard: Wizard, answers: Answers): number {
	const runtime = answers.runtime;
	const targetId = answers.targetId;
	if (!runtime || targetId === undefined) return cancel(wizard.presenter, answers);
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
			if (credentialWriteFailed(auth, `credential for ${runtime.id} was not stored; target '${targetId}' not saved`)) {
				presenter.done("Nothing written");
				return 1;
			}
			printPlaintextCredentialWarning();
		}

		updateSettings((settings) => applyAnswers(settings, answers, descriptor, chatEligible));
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
	else presenter.note("Use Targets & Auth to change chat, fleet, or background defaults.");
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

	presenter.commandAdvice("Start Clio:", "clio-coder");
	presenter.commandAdvice("Change any of this later:", "clio-coder configure");
	presenter.done("Done");
	return 0;
}
