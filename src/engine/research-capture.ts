import type { TelemetryContext } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import type { TelemetryCall } from "../core/telemetry/producer.js";
import { telemetryCaptures } from "../core/telemetry/producer.js";
import { PROVIDER_HEADER_PATTERN } from "../core/telemetry/schemas.js";

/** A body past this many characters keeps only its head, as text; the session's research cap still applies (#434). */
const REQUEST_CAPTURE_MAX_CHARS = 1024 * 1024;
const HEADER_VALUE_MAX_CHARS = 256;
const ALLOWED_HEADER = new RegExp(PROVIDER_HEADER_PATTERN);

/**
 * Research capture for one provider request, decided once when the request starts so standard mode assembles
 * nothing: the body under content capture and consent, the allowlisted response headers under `providerHeaders`.
 * Both are recorded under the call's own context when its stream ends (#434, P4).
 */
export function researchCaptureFor(call: TelemetryCall | undefined, ctx: TelemetryContext | undefined) {
	if (!call || !ctx) return undefined;
	const body = telemetryCaptures("request.captured", ctx);
	const headers = telemetryCaptures("provider.headers_captured", ctx);
	if (!body && !headers) return undefined;
	return {
		/** The serialized payload Pi handed its provider; absent when it never got that far. */
		settle(serialized: string | undefined): void {
			try {
				if (body && serialized !== undefined) {
					const truncated = serialized.length > REQUEST_CAPTURE_MAX_CHARS;
					telemetryHub().emitContent(
						"request.captured",
						{ bodyBytes: Buffer.byteLength(serialized), truncated },
						// A parsed copy: the live payload shares message objects the agent keeps mutating.
						truncated
							? { bodyText: serialized.slice(0, REQUEST_CAPTURE_MAX_CHARS), truncated: true }
							: { body: JSON.parse(serialized) as unknown },
						ctx,
					);
				}
				const response = headers ? call.lastResponse?.() : undefined;
				if (response) {
					const kept: Record<string, string> = {};
					for (const [name, value] of Object.entries(response.headers)) {
						const key = name.toLowerCase();
						if (ALLOWED_HEADER.test(key)) kept[key] = String(value).slice(0, HEADER_VALUE_MAX_CHARS);
					}
					if (Object.keys(kept).length > 0)
						telemetryHub().emit("provider.headers_captured", { status: response.status, headers: kept }, ctx);
				}
			} catch {
				// Research capture never changes the call it describes (#434).
			}
		},
	};
}
