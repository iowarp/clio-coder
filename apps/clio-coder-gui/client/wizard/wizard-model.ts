// What the setup wizard shows for each prompt the configure child sends, before any of it is drawn.
//
// The transport is the one `clio-coder configure --gui-host` already speaks: select prompts with a
// heading and choices, text prompts with a hint and a mask, and plain message lines. This module reads
// the TUI's own strings (src/cli/configure-onboarding.ts, configure-oauth.ts, configure-layout.ts) and
// turns each prompt into a typed step. A prompt it does not recognise becomes a `generic` step that is
// still answerable, so a newer CLI can add a question without breaking the wizard. The child owns the
// order of the steps and what each answer means. Nothing here decides what to ask next.

import type { SetupAnswer, SetupState } from "../../contracts/setup.js";

export type Prompt = NonNullable<SetupState["prompt"]>;
export type SelectPrompt = Extract<Prompt, { kind: "select" }>;
export type TextPrompt = Extract<Prompt, { kind: "text" }>;
export type Choice = SelectPrompt["choices"][number];

/** The stepper's stages. A step belongs to exactly one. */
export type StageId = "provider" | "connect" | "model" | "test" | "workspace";

export const STAGE_LABELS: Readonly<Record<StageId, string>> = {
	provider: "Provider",
	connect: "Connect",
	model: "Model",
	test: "Test",
	workspace: "Workspace",
};

export type WizardMode = "first" | "add" | "repair";

/**
 * The stages a run shows. A machine that already has a workspace skips that stage. Repair keeps the
 * provider stage because the CLI still asks it first; the wizard answers it with the saved provider.
 */
export function stagesFor(_mode: WizardMode, needsWorkspace: boolean): readonly StageId[] {
	const stages: StageId[] = ["provider", "connect", "model", "test"];
	if (needsWorkspace) stages.push("workspace");
	return stages;
}

/**
 * The film played behind a step, one per stage so the scene changes where the work does: Clio reads when
 * it starts, one dash is set while a provider is chosen, helpers go out and return while the connection
 * is reached, one model is chosen, the sweep inspects what was verified, and the mark settles when saved.
 * Each is a bounded clip from the site's animation set.
 */
export type SceneId = "read" | "focus" | "helpers" | "inspect" | "finale";

export type CategoryKey = "local-app" | "local-server" | "subscription" | "cloud-api" | "external-worker";

const CATEGORY_BY_LABEL: Readonly<Record<string, CategoryKey>> = {
	"An app on this computer": "local-app",
	"A model server": "local-server",
	"An AI subscription": "subscription",
	"A provider account or API": "cloud-api",
	"An installed coding agent": "external-worker",
};

export interface CategoryOption {
	readonly choice: Choice;
	readonly key: CategoryKey | null;
	readonly label: string;
	readonly summary: string;
}

export interface ProviderOption {
	readonly choice: Choice;
	/** The runtime's id, taken from the hint the CLI prints after the summary. */
	readonly runtimeId: string | null;
	readonly label: string;
	readonly summary: string;
	/** One or two letters for the tile. */
	readonly monogram: string;
}

export type CredentialSource = "env" | "stored" | "keep" | "skip";

export interface CredentialOption {
	readonly choice: Choice;
	readonly source: CredentialSource | null;
	readonly label: string;
	readonly hint: string;
}

export interface ModelOption {
	readonly choice: Choice;
	/** The id Clio will send. The CLI may print a friendly name after it. */
	readonly id: string;
	readonly name: string | null;
	/** "default", or the state the provider reports. */
	readonly note: string | null;
	readonly recommended: boolean;
}

export interface ReviewFact {
	readonly key: string;
	readonly label: string;
	readonly text: string;
	readonly tone: "ok" | "warn" | "info";
}

interface Base {
	readonly stage: StageId;
	readonly scene: SceneId;
}

export type StepView =
	| (Base & { kind: "category"; prompt: SelectPrompt; options: readonly CategoryOption[] })
	| (Base & { kind: "provider"; prompt: SelectPrompt; options: readonly ProviderOption[]; searchable: boolean })
	| (Base & {
			kind: "signin";
			prompt: SelectPrompt;
			provider: string;
			status: string;
			note: string | null;
			connect: Choice | null;
			later: Choice | null;
	  })
	| (Base & {
			kind: "credential-source";
			prompt: SelectPrompt;
			status: string;
			options: readonly CredentialOption[];
	  })
	| (Base & { kind: "credential-env"; prompt: TextPrompt })
	| (Base & { kind: "credential-key"; prompt: TextPrompt })
	| (Base & { kind: "oauth-code"; prompt: TextPrompt })
	| (Base & { kind: "server"; prompt: TextPrompt; title: string; guidance: readonly string[] })
	| (Base & { kind: "detected"; prompt: SelectPrompt; served: string; options: readonly Choice[] })
	| (Base & { kind: "login-method"; prompt: SelectPrompt; provider: string; options: readonly Choice[] })
	| (Base & {
			kind: "model";
			prompt: SelectPrompt;
			note: string | null;
			models: readonly ModelOption[];
			searchable: boolean;
	  })
	| (Base & {
			kind: "model-missing";
			prompt: SelectPrompt;
			reason: string | null;
			retry: Choice | null;
			key: Choice | null;
			change: Choice | null;
			manual: Choice | null;
	  })
	| (Base & { kind: "model-manual"; prompt: TextPrompt; warning: string | null })
	| (Base & {
			kind: "review";
			prompt: SelectPrompt;
			facts: readonly ReviewFact[];
			notes: readonly string[];
			verified: boolean;
			save: Choice | null;
			details: Choice | null;
			back: Choice | null;
	  })
	| (Base & {
			kind: "details";
			prompt: SelectPrompt;
			title: string;
			lines: readonly string[];
			next: Choice | null;
			previous: Choice | null;
	  })
	| (Base & { kind: "generic"; prompt: Prompt });

export type WizardView =
	| { kind: "welcome" }
	/** The child is starting and has not said yet whether a returning user's route needs no setup at all. */
	| { kind: "starting" }
	| StepView
	| (Base & { kind: "working"; label: string; signIn: SignIn | null })
	| (Base & { kind: "saved"; summary: readonly string[]; warnings: readonly string[]; verified: boolean })
	| { kind: "failed"; problem: string }
	| { kind: "cancelled" };

export interface SignIn {
	readonly url: string | null;
	readonly code: string | null;
}

const head = (prompt: Prompt): string => prompt.heading[0] ?? "";
const rest = (prompt: Prompt): string[] => prompt.heading.slice(1);

/** The first character or two of a name, for a tile that has no logo of its own. */
export function monogram(label: string): string {
	const words = label.split(/[\s/()-]+/u).filter((word) => /[A-Za-z0-9]/u.test(word));
	const [first, second] = words;
	if (first === undefined) return "?";
	if (second !== undefined && /^[A-Z]/u.test(second)) return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
	return first.slice(0, 2).replace(/^./u, (letter) => letter.toUpperCase());
}

/** `Ollama, LM Studio · runtime ollama` is the CLI's hint for a provider. */
function splitProviderHint(hint: string): { summary: string; runtimeId: string | null } {
	const match = /^(.*?)\s*·\s*runtime\s+(\S+)\s*$/u.exec(hint);
	return match ? { summary: match[1] ?? "", runtimeId: match[2] ?? null } : { summary: hint, runtimeId: null };
}

function byLabel(prompt: SelectPrompt, pattern: RegExp): Choice | null {
	return prompt.choices.find((choice) => pattern.test(choice.label)) ?? null;
}

const CREDENTIAL_LABELS: ReadonlyArray<readonly [RegExp, CredentialSource]> = [
	[/^Environment variable$/u, "env"],
	[/^Store the key$/u, "stored"],
	[/^Keep what is there$/u, "keep"],
	[/^No key$/u, "skip"],
];

/** `gpt-5 — Friendly name` is a model id with a label; a bare id has none. */
function splitModel(label: string): { id: string; name: string | null } {
	const cut = label.indexOf(" — ");
	return cut < 0 ? { id: label, name: null } : { id: label.slice(0, cut), name: label.slice(cut + 3) || null };
}

const VERIFIED_ENDPOINT = /reachable/iu;
const UNVERIFIED = /not verified|no passive check|not reachable|unverified/iu;

function reviewFacts(lines: readonly string[]): { facts: ReviewFact[]; notes: string[]; verified: boolean } {
	const facts: ReviewFact[] = [];
	const notes: string[] = [];
	let endpointOk = false;
	let modelsLive = false;
	for (const line of lines) {
		const pair = /^(Connection|Model|Endpoint|Models|Model ID|Automatic local workers):\s*(.+)$/u.exec(line);
		if (pair) {
			const [, key = "", text = ""] = pair;
			if (key === "Endpoint") {
				const ok = VERIFIED_ENDPOINT.test(text) && !UNVERIFIED.test(text);
				endpointOk = ok;
				facts.push({ key, label: "Endpoint", text, tone: ok ? "ok" : "warn" });
			} else if (key === "Models") {
				const live = /listed live/iu.test(text);
				modelsLive = live;
				facts.push({ key, label: "Model list", text, tone: live ? "ok" : "warn" });
			} else if (key === "Model ID") facts.push({ key, label: "Model", text, tone: "warn" });
			else if (key === "Connection") facts.push({ key, label: "Connection", text, tone: "info" });
			else if (key === "Model") facts.push({ key, label: "Model", text, tone: "info" });
			else facts.push({ key, label: "Local workers", text, tone: "info" });
			continue;
		}
		if (/^ALCF catalog reachable/iu.test(line)) {
			endpointOk = true;
			facts.push({ key: "Endpoint", label: "Endpoint", text: line, tone: "ok" });
			continue;
		}
		notes.push(line);
	}
	return { facts, notes, verified: endpointOk && modelsLive };
}

/** The prompt as a step, or null when it is not a prompt this module knows how to present. */
export function stepFor(prompt: Prompt): StepView {
	const title = head(prompt);
	if (prompt.kind === "select") {
		if (title === "Where does your model come from?")
			return {
				kind: "category",
				stage: "provider",
				scene: "focus",
				prompt,
				options: prompt.choices.map((choice) => ({
					choice,
					key: CATEGORY_BY_LABEL[choice.label] ?? null,
					label: choice.label,
					summary: choice.hint,
				})),
			};
		if (title === "Which provider or app do you use?")
			return {
				kind: "provider",
				stage: "provider",
				scene: "focus",
				prompt,
				searchable: prompt.searchable,
				options: prompt.choices.map((choice) => {
					const { summary, runtimeId } = splitProviderHint(choice.hint);
					return { choice, runtimeId, label: choice.label, summary, monogram: monogram(choice.label) };
				}),
			};
		if (title.startsWith("Sign in to ")) {
			const lines = rest(prompt);
			const status =
				lines
					.find((line) => line.startsWith("credential:"))
					?.slice("credential:".length)
					.trim() ?? "";
			return {
				kind: "signin",
				stage: "connect",
				scene: "helpers",
				prompt,
				provider: title.slice("Sign in to ".length),
				status,
				note: lines.find((line) => /^Sign-in stores credentials/u.test(line)) ?? null,
				connect: byLabel(prompt, /^Connect now$/u),
				later: byLabel(prompt, /^Later$/u),
			};
		}
		if (title === "How should Clio get the API key?")
			return {
				kind: "credential-source",
				stage: "connect",
				scene: "helpers",
				prompt,
				status:
					rest(prompt)
						.find((line) => line.startsWith("currently:"))
						?.slice("currently:".length)
						.trim() ?? "",
				options: prompt.choices.map((choice) => ({
					choice,
					source: CREDENTIAL_LABELS.find(([pattern]) => pattern.test(choice.label))?.[1] ?? null,
					label: choice.label,
					hint: choice.hint,
				})),
			};
		// configure-oauth.ts asks which sign-in flow to use when a provider has more than one.
		const method = /^Select (.+) login method:?$/u.exec(title);
		if (method)
			return {
				kind: "login-method",
				stage: "connect",
				scene: "helpers",
				prompt,
				provider: method[1] ?? "",
				options: prompt.choices,
			};
		if (title.startsWith("That URL is serving "))
			return {
				kind: "detected",
				stage: "connect",
				scene: "helpers",
				prompt,
				served: title.slice("That URL is serving ".length).replace(/\.$/u, ""),
				options: prompt.choices,
			};
		if (title === "Which model?")
			return {
				kind: "model",
				stage: "model",
				scene: "focus",
				prompt,
				note: rest(prompt)[0] ?? null,
				searchable: prompt.searchable,
				models: prompt.choices.map((choice) => {
					const { id, name } = splitModel(choice.label);
					return { choice, id, name, note: choice.hint || null, recommended: choice.hint === "default" };
				}),
			};
		if (title === "Clio could not read a model list")
			return {
				kind: "model-missing",
				stage: "model",
				scene: "focus",
				prompt,
				reason: rest(prompt)[0] ?? null,
				retry: byLabel(prompt, /^Check again$/u),
				key: byLabel(prompt, /^This server needs an API key$/u),
				change: byLabel(prompt, /^Change the connection$/u),
				manual: byLabel(prompt, /^Enter an unverified model ID$/u),
			};
		if (title === "Review what Clio could verify") {
			const { facts, notes, verified } = reviewFacts(rest(prompt));
			return {
				kind: "review",
				stage: "test",
				scene: "inspect",
				prompt,
				facts,
				notes,
				verified,
				save: byLabel(prompt, /^Save/u),
				details: byLabel(prompt, /machine details$/u),
				back: byLabel(prompt, /^Back$/u),
			};
		}
		if (/^(Connection details|Connection address|Credential handling|Machine observations)$/u.test(title))
			return {
				kind: "details",
				stage: "test",
				scene: "inspect",
				prompt,
				title,
				lines: rest(prompt),
				next: byLabel(prompt, /^(Next|Return to review)$/u),
				previous: byLabel(prompt, /^(Previous|Return to review)$/u),
			};
		return { kind: "generic", stage: "connect", scene: "helpers", prompt };
	}
	if (title === "Which environment variable?")
		return { kind: "credential-env", stage: "connect", scene: "helpers", prompt };
	if (title === "Paste the API key") return { kind: "credential-key", stage: "connect", scene: "helpers", prompt };
	if (/verification code/iu.test(title)) return { kind: "oauth-code", stage: "connect", scene: "helpers", prompt };
	if (title === "Unverified model id")
		return { kind: "model-manual", stage: "model", scene: "focus", prompt, warning: rest(prompt)[0] ?? null };
	// The server address is the one text prompt whose hint names how to write a URL.
	if (/^(host:port is enough|paste the whole URL)/u.test(prompt.hint))
		return { kind: "server", stage: "connect", scene: "helpers", prompt, title, guidance: rest(prompt) };
	return { kind: "generic", stage: "connect", scene: "helpers", prompt };
}

// ---- messages ------------------------------------------------------------------------------------

// The CLI wraps its introduction at 80 columns, so the tails of two sentences arrive as lines of their own.
const INTRO =
	/^(Welcome to Clio Coder|Add a target|Edit target:|Choose what you already use|Back returns|Escape goes back|Saved result:|provider allows it\.|you complete\.)/u;

export interface ProbeReading {
	readonly state: "reachable" | "unreachable" | "auth-failed" | "warning";
	readonly text: string;
}

export interface Recap {
	readonly label: string;
	readonly value: string;
}

export interface ReadMessages {
	/** The route the CLI took for a returning user without asking: `Chat: openai / gpt-6-luna from OPENAI_API_KEY.` */
	readonly chat: string | null;
	readonly signIn: SignIn | null;
	readonly probe: ProbeReading | null;
	readonly recap: readonly Recap[];
	readonly saved: readonly string[];
	readonly warnings: readonly string[];
	/** Anything else the CLI said, in order, without its introduction. */
	readonly other: readonly string[];
}

const RECAP_LABELS = /^(Source|Provider|URL|Credential|Model|Thinking|Context|Colleague|Detected)\s{2,}(.*\S)\s*$/u;
const SIGN_IN_URL = /^\s*Open:\s*(https?:\/\/\S+)\s*$/u;
const CHAT_ROUTE = /^Chat: \S+ \/ .+ from .+\.$/u;

/** A sign-in link is only offered when it is a plain http(s) URL without credentials in it. */
export function safeUrl(text: string): string | null {
	try {
		const url = new URL(text);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
	} catch {
		// Not a URL, so it is shown as text and never linked.
		return null;
	}
}

export function readMessages(messages: readonly string[]): ReadMessages {
	let chat: string | null = null;
	let url: string | null = null;
	let code: string | null = null;
	let probe: ProbeReading | null = null;
	const recap: Recap[] = [];
	const saved: string[] = [];
	const warnings: string[] = [];
	const other: string[] = [];
	for (const raw of new Set(messages)) {
		const line = raw.trim();
		if (line === "" || INTRO.test(line)) continue;
		if (CHAT_ROUTE.test(line)) {
			chat = line;
			continue;
		}
		const link = SIGN_IN_URL.exec(line);
		if (link) {
			url = safeUrl(link[1] ?? "") ?? url;
			continue;
		}
		const device = /^Enter code:\s*(\S+)/u.exec(line);
		if (device) {
			code = device[1] ?? null;
			continue;
		}
		const row = RECAP_LABELS.exec(line);
		if (row) {
			recap.push({ label: row[1] ?? "", value: row[2] ?? "" });
			continue;
		}
		if (/^authentication failed/iu.test(line)) probe = { state: "auth-failed", text: line };
		else if (/^not reachable/iu.test(line)) probe = { state: "unreachable", text: line };
		else if (/reachable/iu.test(line) && !/^not /iu.test(line)) probe = { state: "reachable", text: line };
		else if (/answered, but not with/iu.test(line)) probe = { state: "warning", text: line };
		if (/^✓\s/u.test(line)) {
			saved.push(line.replace(/^✓\s*/u, ""));
			continue;
		}
		if (probe?.text === line) continue;
		if (/Credentials are stored with mode 0600|reported no context window|did not complete|not stored/iu.test(line))
			warnings.push(line);
		else other.push(line);
	}
	return { chat, signIn: url || code ? { url, code } : null, probe, recap, saved, warnings, other };
}

const SUMMARY_LABELS: Readonly<Record<string, string>> = {
	Provider: "Provider",
	URL: "Address",
	Model: "Model",
	Credential: "Credential",
};

/** The rows of the saved screen, from what was chosen. */
export function savedSummary(recap: readonly Recap[]): string[] {
	return recap.flatMap((row) => {
		const label = SUMMARY_LABELS[row.label];
		return label ? [`${label}: ${row.value}`] : [];
	});
}

/** A sentence from a fragment the CLI printed: capitalised, with a full stop. */
export function sentence(text: string): string {
	const trimmed = text.trim();
	if (trimmed === "") return "";
	const cap = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/u.test(cap) ? cap : `${cap}.`;
}

/** What the child is doing while no prompt is open, in the words the setup shows. */
export function workingLabel(read: ReadMessages, after: WizardView | null = null): string {
	if (read.signIn) return "Waiting for you to finish signing in";
	// The answer just sent says what the CLI is doing with it better than its messages do.
	switch (after && "kind" in after ? after.kind : null) {
		case "server":
			return "Checking the address and reading the model list";
		case "model-missing":
			return "Checking the endpoint again";
		case "model":
		case "model-manual":
			return "Reading what the model supports";
		case "detected":
			return "Reading the model list";
		case "review":
			return "Saving your connection";
		case "credential-key":
		case "credential-env":
		case "credential-source":
			return "Checking the credential";
		default:
			break;
	}
	const last = read.other.at(-1) ?? "";
	if (/checking the endpoint|probe|read(ing)? .*model/iu.test(last)) return "Reading the model list";
	if (read.probe?.state === "reachable") return "Server answered. Reading what it offers";
	return "Setting this up";
}

/**
 * The step for a snapshot. While the child is working, `previous` keeps the stage and scene of the last
 * prompt so the stepper does not jump.
 */
export function viewFor(state: SetupState | null, previous: WizardView | null): WizardView {
	if (state === null) return { kind: "welcome" };
	const read = readMessages(state.messages);
	switch (state.status) {
		case "prompt":
			return state.prompt ? stepFor(state.prompt) : { kind: "failed", problem: "Setup sent an empty step." };
		case "working": {
			const held = previous && "stage" in previous ? previous : null;
			return {
				kind: "working",
				stage: held?.stage ?? "provider",
				scene: read.signIn ? "helpers" : (held?.scene ?? "focus"),
				label: workingLabel(read, held),
				signIn: read.signIn,
			};
		}
		case "saved":
			return {
				kind: "saved",
				stage: "test",
				scene: "finale",
				// The CLI says nothing after it saves, so the summary is the choices made on the way.
				summary: [...savedSummary(read.recap), ...read.saved],
				warnings: read.warnings,
				verified: read.probe?.state !== "unreachable" && read.probe?.state !== "auth-failed",
			};
		case "cancelled":
			return { kind: "cancelled" };
		case "failed":
			return { kind: "failed", problem: state.problem ?? "Setup could not finish." };
	}
}

// ---- answers -------------------------------------------------------------------------------------

export const selectAnswer = (prompt: Prompt, choice: Choice): SetupAnswer => ({
	promptId: prompt.id,
	action: "select",
	choice: choice.id,
});
export const textAnswer = (prompt: Prompt, value: string): SetupAnswer => ({
	promptId: prompt.id,
	action: "text",
	value,
});
export const backAnswer = (prompt: Prompt): SetupAnswer => ({ promptId: prompt.id, action: "back" });

/** Case-folded substring match over what a person sees on a tile. */
export function matches(text: readonly string[], query: string): boolean {
	const needle = query.trim().toLocaleLowerCase();
	return needle === "" || text.some((part) => part.toLocaleLowerCase().includes(needle));
}

/** The model to start on: the CLI's own default, else the first listed. */
export function startingModel(models: readonly ModelOption[], initial: number): ModelOption | undefined {
	return models.find((model) => model.recommended) ?? models.find((model) => model.choice.id === initial) ?? models[0];
}
