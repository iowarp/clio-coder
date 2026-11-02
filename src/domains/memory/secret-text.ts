import { createRedactionTally, redactSecretsText } from "../evidence/redact.js";
import { isEnvReference, isSecretArgKey, redactSecretString } from "../safety/redaction.js";

declare const memoryRouteTextBrand: unique symbol;
/**
 * Text cleared to leave for a memory route, which can be another provider than the one the session used. The model
 * request's `userPrompt` takes only this type, so a new caller cannot reach the route without going through here.
 */
export type MemoryRouteText = string & { readonly [memoryRouteTextBrand]: true };

/** `src/a.ts` or `./scripts`, in `grep -n token: src/a.ts`: a slash and a file shape name a path, not a credential. */
const PATH_ARGUMENT = /^(?:\.{0,2}\/[\w./-]+|[\w.-]+(?:\/[\w.-]+)*\/[\w-]+\.[A-Za-z][A-Za-z0-9]{0,5})$/u;

/** The evidence rule reads any long value after a secret-flavored key as a credential; these two hold none. */
function keepAssignmentValue(value: string): boolean {
	// `https://token:$GH_TOKEN@github.com` reaches this rule with its host still attached.
	return isEnvReference(value.replace(/@.*$/u, "")) || PATH_ARGUMENT.test(value);
}

/**
 * Both redactors, because each misses what the other knows: the display rule has key names, flags and URLs, and the
 * evidence patterns have bare token shapes. A command holding no secret stays byte-identical, so it can still be
 * compared to its receipt. Redact before cutting: a cut can leave a partial secret neither rule recognizes.
 */
export function redactForMemoryRoute(text: string): MemoryRouteText {
	return redactSecretsText(redactSecretString(text), createRedactionTally(), {
		keepAssignmentValue,
	}) as MemoryRouteText;
}

/** Serialize leaf by leaf, since redacting serialized text can swallow an escaped quote; a key names its own value. */
export function memoryRouteJson(value: unknown): MemoryRouteText {
	return JSON.stringify(value, (key, leaf: unknown) => {
		if (typeof leaf !== "string") return leaf;
		if (leaf !== "" && isSecretArgKey(key) && !isEnvReference(leaf)) return "[redacted:assignment]";
		return redactForMemoryRoute(leaf);
	}) as MemoryRouteText;
}
