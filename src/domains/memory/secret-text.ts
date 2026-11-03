import { createRedactionTally, redactSecretsText } from "../evidence/redact.js";
import { isEnvReference, openUrlStart, redactSecretString, redactToolArgs } from "../safety/redaction.js";

declare const memoryRouteTextBrand: unique symbol;
/**
 * Text cleared to leave for a memory route, which can be another provider than the one the session used. The model
 * request's `userPrompt` takes only this type, so a new caller cannot reach the route without going through here.
 */
export type MemoryRouteText = string & { readonly [memoryRouteTextBrand]: true };

/**
 * A whole `$NAME` names a variable, not a credential. `$NAME@host` is that only as URL userinfo, where the `@` closes the
 * password, so `https://token:$GH_TOKEN@github.com` stays exact and `password: $AB@hunter2hunter2` does not. A path gets no
 * such pass, because a secret can look like one: `grep -n token: src/a.ts` fails closed and cannot ground a lesson.
 */
function keepAssignmentValue(value: string, before: string): boolean {
	const at = value.indexOf("@");
	if (at < 0) return isEnvReference(value);
	return isEnvReference(value.slice(0, at)) && !value.includes("@", at + 1) && openUrlStart(before) !== null;
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

/** `author` and `authority` hold no credential, and the tool-args key rule only sees their `auth`. */
const AUTHORSHIP_NAME = /author(?!iz)/giu;

function clearedForRoute(value: unknown, key: string): unknown {
	// The tool-args rule decides what a key hides. Probing with a string asks it without walking the value.
	const policyKey = key.replace(AUTHORSHIP_NAME, "");
	if (redactToolArgs("x", policyKey) !== "x") return clearedForRoute(redactToolArgs(value, policyKey), "");
	if (typeof value === "string") return redactForMemoryRoute(value);
	if (Array.isArray(value)) return value.map((item) => clearedForRoute(item, key));
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [childKey, child] of Object.entries(value)) {
		out[redactForMemoryRoute(childKey)] = clearedForRoute(child, childKey);
	}
	return out;
}

/** Serialize a cleared copy, since redacting serialized text can swallow an escaped quote. A property name is text too. */
export function memoryRouteJson(value: unknown): MemoryRouteText {
	return JSON.stringify(clearedForRoute(value, "")) as MemoryRouteText;
}
