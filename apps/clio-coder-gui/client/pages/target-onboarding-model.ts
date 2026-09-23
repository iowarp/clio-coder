// Wording and request shaping for adding a connection. Pure, so it is testable without a browser.

import type { TargetAdd, TargetRuntimes } from "../../contracts/targets-cli.js";

export type Runtime = TargetRuntimes["runtimes"][number];
export type Draft = { runtime: string; id: string; url: string; model: string; apiKeyEnv: string; useForChat: boolean };

/** What the operator must do about credentials. The app never takes one, so every state names a terminal step or none. */
export function authGuidance(runtime: Runtime): { tone: "ready" | "action"; text: string } {
	switch (runtime.auth) {
		case "connected":
			return { tone: "ready", text: "Clio is already signed in to this provider." };
		case "credential":
			return { tone: "ready", text: "Clio already holds a stored key for this provider." };
		case "none":
			return { tone: "ready", text: "This runtime needs no credential." };
		case "key-optional":
			return {
				tone: "ready",
				text: "A key is optional. If the endpoint needs one, name the environment variable that holds it.",
			};
		case "login":
			return {
				tone: "action",
				text: `Sign in first from a terminal: clio-coder auth login ${runtime.id}. This app never handles the sign-in.`,
			};
		case "needs-key":
			return {
				tone: "action",
				text: `This provider needs a key. Name the environment variable that holds it, or store one from a terminal with clio-coder auth login ${runtime.id}. This app has no key field on purpose.`,
			};
		default:
			return { tone: "action", text: "This runtime authenticates through its own tool. Set that up in a terminal first." };
	}
}

/** A connection id the CLI accepts, suggested from the runtime and kept clear of existing ids. */
export function suggestId(runtime: Runtime, taken: readonly string[]): string {
	const base = runtime.id.replace(/[^A-Za-z0-9._-]/g, "-");
	if (!taken.includes(base)) return base;
	for (let n = 2; n < 100; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
	return `${base}-${Date.now()}`;
}

/** Field problems the page can name before the CLI does. The CLI stays the authority on everything else. */
export function draftProblems(draft: Draft, runtime: Runtime | undefined, taken: readonly string[]): string[] {
	const problems: string[] = [];
	if (!runtime) return ["Choose a runtime."];
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(draft.id))
		problems.push(
			"The connection id starts with a letter or digit and uses only letters, digits, dot, dash and underscore.",
		);
	else if (taken.includes(draft.id)) problems.push(`A connection named ${draft.id} already exists.`);
	if (draft.url && !/^(https?|wss?):\/\/\S+$/.test(draft.url))
		problems.push("The URL starts with http://, https://, ws:// or wss://.");
	else if (draft.url.length > 2048) problems.push("The endpoint URL must be 2,048 characters or fewer.");
	if (runtime.modelRequired && !draft.model.trim())
		problems.push("This provider's model list has no recommended default, so choose a model.");
	else if (draft.model.trim() && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(draft.model.trim()))
		problems.push("The model ID must start with a letter or digit and use only model ID characters (up to 200).");
	if (draft.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(draft.apiKeyEnv))
		problems.push("An environment variable name uses letters, digits and underscore.");
	return problems;
}

/** Blank optional fields are omitted so the CLI applies its own defaults. */
export function toRequest(draft: Draft, runtime: Runtime): TargetAdd {
	return {
		id: draft.id,
		runtime: runtime.id,
		...(runtime.supportsCustomUrl && draft.url.trim() ? { url: draft.url.trim() } : {}),
		...(draft.model.trim() ? { model: draft.model.trim() } : {}),
		...(draft.apiKeyEnv.trim() ? { apiKeyEnv: draft.apiKeyEnv.trim() } : {}),
		...(draft.useForChat ? { useForChat: true } : {}),
	};
}
