import { stripVTControlCharacters } from "node:util";
import { redactSecretsText } from "../../domains/evidence/redact.js";
import { redactStreamingSecretString, redactUrlCredentials } from "../../domains/safety/redaction.js";

const SCAN_LIMIT = 8_192;
const DISPLAY_LIMIT = 600;
const ROUTE_ADVICE_TAIL = 1_024;
const AVAILABLE_DIAGNOSTIC_TAIL = " ... [available diagnostic: /view transcript]";

/** Discard incomplete control sequences at the scan boundary, including their payload. */
function terminalSafePrefix(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	const parts: string[] = [];
	let start = 0;
	let i = 0;
	while (i < end) {
		const code = value.charCodeAt(i);
		if (code !== 27 && !(code >= 0x80 && code <= 0x9f)) {
			i++;
			continue;
		}
		parts.push(value.slice(start, i));
		const introducer = code === 27 ? value.charCodeAt(++i) : code;
		i++;
		if (introducer === 91 || introducer === 0x9b) {
			while (i < end) {
				const next = value.charCodeAt(i++);
				if (next >= 0x40 && next <= 0x7e) break;
			}
		} else if ([93, 80, 88, 94, 95, 0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(introducer)) {
			while (i < end) {
				const next = value.charCodeAt(i++);
				if (next === 7 || next === 0x9c) break;
				if (next === 27 && i < end && value.charCodeAt(i) === 92) {
					i++;
					break;
				}
			}
		}
		start = i;
	}
	parts.push(value.slice(start, end));
	return stripVTControlCharacters(parts.join(""));
}

/**
 * Transport plumbing has a plain sentence, for the rows that have no failure class to word it from: a retry attempt, or a
 * session saved before failures carried one. The original stays in the diagnostic.
 */
const PLAIN_TRANSPORT_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
	[/Provider stream ended before a finish reason/iu, "The connection dropped before the reply finished."],
	[/^(?:\[error\]\s*)?terminated\b/iu, "The connection dropped."],
	[/^(?:\[error\]\s*)?(?:fetch failed|connection error|socket hang up)\b/iu, "The connection to the provider failed."],
	[/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET)\b/u, "The connection to the provider failed."],
];

/** Available evidence is sanitized and redacted only when explicitly inspected. */
export function providerErrorEvidence(value: string, scanLimit = value.length): string {
	return redactSecretsText(
		// A scan limit can end this prefix inside a URL, where userinfo never resolves (#446).
		redactStreamingSecretString(terminalSafePrefix(value, scanLimit), scanLimit >= value.length).replace(
			/(\b(?:authorization["']?\s*[:=]\s*["']?\s*)?(?:Bearer|Basic)\s+)[^\s"'<>]+/gi,
			"$1[redacted]",
		),
		{ count: 0 },
	).replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : " "));
}

/**
 * A bounded projection; never use this to replace a persisted diagnostic. `remedyStated` is for a caller printing
 * {@link providerFailureAdvice} under it, where the LiteLLM tail would give the same way out a second time and push
 * the failure's own remedy behind the row fold.
 */
export function presentProviderError(value: string, options: { remedyStated?: boolean } = {}): string {
	const available = providerErrorEvidence(value, SCAN_LIMIT);
	// Preserve the actual Clio wrapper suffix; never infer a retry policy from
	// provider error codes. A restored body can push this advice past the scan
	// window, so a long diagnostic is matched on its bounded tail instead.
	const beyondScan = value.length > SCAN_LIMIT;
	const routeParts = (beyondScan ? providerErrorEvidence(value.slice(-ROUTE_ADVICE_TAIL)) : available).match(
		/\n\n((LiteLLM route [^\n]+ failed\.) Clio did not (?:retry or )?(substitute another model); (select a different route with \/model, then resend\.))$/,
	);
	const routeAdvice = routeParts?.[1];
	const sample =
		routeAdvice && !beyondScan ? available.slice(0, available.length - routeAdvice.length).trimEnd() : available;
	let summary = sample;
	const jsonStart = sample.indexOf("{");
	const html = /<!doctype\s+html|<html\b/i.test(sample);
	if (html) {
		const title = sample.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
		const prefix = sample
			.slice(0, sample.indexOf("<"))
			.trim()
			.replace(/[:;,\s]+$/u, "");
		const titled = title !== undefined && prefix.length > 0 && title.startsWith(prefix.replace(/^.*\s/u, ""));
		summary = [
			// The SDK's bare status and a gateway page's title usually say the same thing.
			titled ? prefix.replace(/\S+$/u, "").trim() : prefix,
			title,
			routeAdvice ? "" : "the provider or a gateway answered with an HTML error page",
		]
			.filter(Boolean)
			.join("; ");
	} else if (jsonStart >= 0) {
		// Decode only quoted diagnostic strings, never parse and round numeric
		// source facts. The scan and every allocation are bounded by SCAN_LIMIT.
		const matched = [...sample.matchAll(/"(message|detail|type|code)"\s*:\s*"((?:[^"\\]|\\.)*)/g)];
		// A provider's error class says nothing its message has not said, so it only stands in for a missing one.
		const explained = matched.some((match) => match[1] === "message" || match[1] === "detail");
		const fields = matched.map((match) => {
			const quoted = match[2];
			if (quoted === undefined || (explained && match[1] === "type")) return "";
			try {
				// A bounded prefix of an unfinished quoted field is still useful
				// prose. The matcher excludes a dangling escape at the boundary.
				const decoded: unknown = JSON.parse(`"${quoted}"`);
				return typeof decoded === "string" ? providerErrorEvidence(decoded) : "";
			} catch {
				return "";
			}
		});
		if (fields.some(Boolean)) {
			// The SDK leads with `401:` or `503 `; a bare status reads as the status it is, with no stray colon.
			const lead = sample
				.slice(0, jsonStart)
				.trim()
				.replace(/[:;,\s]+$/u, "");
			summary = [lead.replace(/^((?:\[[^\]]+\]\s*)?)([45]\d\d)$/u, "$1HTTP $2"), ...new Set(fields)]
				.filter(Boolean)
				.join("; ");
		}
	}
	const status =
		sample.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:_code)?["']?\s*[:=]\s*)([45]\d\d)\b/i)?.[1] ??
		sample.match(/"(?:status|status_?code)"\s*:\s*([45]\d{2})(?=\s*[,}])/i)?.[1] ??
		sample.match(/"error"\s*:\s*\{[^{}]*?"code"\s*:\s*([45]\d{2})(?=\s*[,}])/i)?.[1];
	if (status && !summary.includes(status)) summary = `HTTP ${status}; ${summary}`;
	summary = summary.replace(/\s+/g, " ").trim();
	const plainTransport = PLAIN_TRANSPORT_FAILURES.find(([plumbing]) => plumbing.test(summary))?.[1];
	if (plainTransport !== undefined) summary = plainTransport;
	if (routeAdvice && options.remedyStated !== true) {
		// Keep route recovery ahead of long body detail so row clipping cannot
		// spend the entire primary preview on the provider payload.
		const prefix = summary.slice(0, 60);
		const identity = routeParts?.[2];
		const policy = routeParts?.[3];
		const remedy = routeParts?.[4];
		// A saved failure may claim no retry that the ladder since made untrue, so the policy is restated rather than replayed.
		const advice = identity && policy && remedy ? `${remedy} Clio did not ${policy}. ${identity}` : routeAdvice;
		summary = `${prefix}${summary.length > 60 ? " ..." : ""}; ${advice}`;
	}
	const shortened = summary.length > DISPLAY_LIMIT || value.length > SCAN_LIMIT || summary !== sample.trim();
	return `${summary.slice(0, DISPLAY_LIMIT)}${shortened ? AVAILABLE_DIAGNOSTIC_TAIL : ""}`;
}

/** The route a provider failure happened on, and enough of the failure to say what gets past it. */
export interface ProviderFailureRoute {
	targetId: string;
	url?: string;
	/** Absent on a session saved before failures carried their class; the advice then stays general. */
	stage?: string;
	errorClass?: string;
	partialReply?: boolean;
}

export function readProviderFailureRoute(value: unknown): ProviderFailureRoute | null {
	const route = value as
		| { targetId?: unknown; url?: unknown; stage?: unknown; errorClass?: unknown; partialReply?: unknown }
		| null
		| undefined;
	if (typeof route?.targetId !== "string" || route.targetId.length === 0) return null;
	return {
		targetId: route.targetId,
		...(typeof route.url === "string" && route.url.length > 0 ? { url: route.url } : {}),
		...(typeof route.stage === "string" ? { stage: route.stage } : {}),
		...(typeof route.errorClass === "string" ? { errorClass: route.errorClass } : {}),
		...(route.partialReply === true ? { partialReply: true } : {}),
	};
}

/** Credentials and any query go; what is left is the endpoint the operator configured. */
function shownEndpoint(url: string): string {
	return providerErrorEvidence(redactUrlCredentials(url.split(/[?#]/u)[0] ?? url));
}

const SWITCH_ROUTE = "/model switches route";
const RESEND = "Up recalls your message, Enter resends";

/** A fact for the composer rail, with the form it takes when cells run short. */
export interface ProviderFailureRailFact {
	text: string;
	short?: string;
}

/** What the rail says about a failure, so it never gives a different way out than the block in the transcript. */
export interface ProviderFailureRailFacts {
	cause: ProviderFailureRailFact;
	way?: ProviderFailureRailFact;
}

const RESEND_RAIL: ProviderFailureRailFact = { text: "Up resends" };

function httpStatusOf(errorClass: string): number | null {
	const status = /^http_(\d{3})$/u.exec(errorClass)?.[1];
	return status === undefined ? null : Number(status);
}

/**
 * The plain sentence that leads a provider failure. Null means nothing about the class says more than the failure's own
 * text, which is then what the block leads with: a refused admission and a budget wait are already in Clio's words.
 */
export function providerFailureHeadline(route: ProviderFailureRoute): string | null {
	const errorClass = route.errorClass ?? "";
	const status = httpStatusOf(errorClass);
	if (route.stage === "auth") {
		if (status !== null) return "The provider refused the credential.";
		return errorClass === "credential_expired"
			? "The saved credential has expired."
			: "This route has no usable credential.";
	}
	if (route.stage === "transport") {
		const cut = route.partialReply === true ? "before the reply finished" : "before a reply arrived";
		if (errorClass === "stream_dropped") return `The connection dropped ${cut}.`;
		if (errorClass === "timeout") return `The request timed out ${cut}.`;
		if (errorClass === "aborted") return `The request was cut off ${cut}.`;
		return `The connection to the provider failed ${cut}.`;
	}
	if (status === null) return null;
	if (status === 429) return "The provider is rate limiting this route.";
	if (status >= 500) return `The provider failed on its side (HTTP ${status}).`;
	if (status === 404) return "The provider does not know this model or endpoint (HTTP 404).";
	if (status === 402) return "The provider wants payment or more quota (HTTP 402).";
	return `The provider rejected the request (HTTP ${status}).`;
}

/** The same failure in rail cells. Null keeps the rail to the failure and the route switch. */
export function providerFailureRailFacts(route: ProviderFailureRoute): ProviderFailureRailFacts | null {
	const errorClass = route.errorClass ?? "";
	const status = httpStatusOf(errorClass);
	if (route.stage === "auth") {
		const way = { text: `clio-coder configure --id ${route.targetId}` };
		if (status !== null) return { cause: { text: "credential refused", short: "key refused" }, way };
		return {
			cause:
				errorClass === "credential_expired"
					? { text: "credential expired", short: "key expired" }
					: { text: "no usable credential", short: "no key" },
			way,
		};
	}
	if (route.stage === "transport") {
		const cause =
			errorClass === "stream_dropped"
				? { text: "connection dropped", short: "dropped" }
				: errorClass === "timeout"
					? { text: "request timed out", short: "timed out" }
					: errorClass === "aborted"
						? { text: "request cut off", short: "cut off" }
						: { text: "connection failed", short: "no connection" };
		return { cause, way: RESEND_RAIL };
	}
	if (status === 429)
		return { cause: { text: "rate limited" }, way: { text: "Up resends once it clears", short: "Up resends" } };
	if (status !== null && status >= 500)
		return { cause: { text: "provider failing", short: "server error" }, way: RESEND_RAIL };
	if (status === 404) return { cause: { text: "model or endpoint not found", short: "not found" } };
	if (status !== null) return { cause: { text: "request rejected", short: "rejected" } };
	return null;
}

/** What failed, what was kept and the next step, worded for this failure rather than for every failure. */
export function providerFailureAdvice(route: ProviderFailureRoute): string {
	const configure = `clio-coder configure --id ${route.targetId}`;
	const errorClass = route.errorClass ?? "";
	if (route.stage === "auth") return `${configure} replaces it · ${SWITCH_ROUTE}.`;
	if (route.stage === "transport") {
		// The block folds at few rows, so the way out leads and what the model missed follows it.
		return route.partialReply === true
			? `${RESEND} · ${SWITCH_ROUTE}. The model will not see the partial reply.`
			: `${RESEND} · ${SWITCH_ROUTE}.`;
	}
	if (errorClass === "http_429") return `${RESEND} once the limit clears · ${SWITCH_ROUTE}.`;
	if (/^http_5/u.test(errorClass)) return `${RESEND} once it recovers · ${SWITCH_ROUTE}.`;
	return `${SWITCH_ROUTE} · ${configure} edits this target.`;
}

const ERROR_MARKER = /^\[error\]\s*/u;

/**
 * The technical half of a block a headline leads, on one row the operator can ignore: which endpoint, what it said, and
 * where the full text lives. A transport failure's own text only restates the headline, so it names the endpoint alone.
 */
export function providerFailureEvidence(route: ProviderFailureRoute, value: string): string {
	const where = route.url !== undefined ? `${route.targetId} at ${shownEndpoint(route.url)}` : route.targetId;
	const said =
		route.stage === "transport"
			? ""
			: presentProviderError(value, { remedyStated: true })
					.replace(AVAILABLE_DIAGNOSTIC_TAIL, "")
					.replace(ERROR_MARKER, "")
					.trim();
	return [where, said, "/view transcript has the full text"].filter(Boolean).join(" · ");
}
