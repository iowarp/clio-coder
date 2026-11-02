import { createRedactionTally, redactSecretsText } from "../evidence/redact.js";
import { redactSecretString } from "../safety/redaction.js";

/** `$NAME` and `${name}` name a variable and hold no credential, the same reading `redactSecretString` gives them. */
const ENV_REFERENCE = /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Z_][A-Z0-9_]*)/gu;
const MASKED_REFERENCE = /(\d+)/gu;

/**
 * What may leave for a memory route, which can be another provider than the one the session used.
 * `redactSecretString` is a display rule that knows key names, flags and URLs and misses a bare token; the
 * export-boundary patterns catch token shapes but read `API_TOKEN=$API_TOKEN` as a credential. Masking the
 * references keeps a command that holds none byte-identical, so it can still be compared to its receipt.
 */
export function redactForMemoryRoute(text: string): string {
	const references: string[] = [];
	const masked = redactSecretString(text).replace(ENV_REFERENCE, (reference) => {
		references.push(reference);
		return `${references.length - 1}`;
	});
	return redactSecretsText(masked, createRedactionTally()).replace(
		MASKED_REFERENCE,
		(_match, index: string) => references[Number(index)] ?? "",
	);
}
