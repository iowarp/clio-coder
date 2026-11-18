/**
 * The one reading of a `gateway` tool envelope. The gateway executes what this
 * returns, so every other reader of raw gateway arguments (required-tool
 * matching, `effectiveToolCall`, rows, telemetry facets, safety descriptors)
 * goes through it too, or a shorthand the gateway ran reads as something else.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the weak-model shapes: `args` as a JSON string, `name`/`tool` for
 * `capability`, an empty `parameters` object, and a missing `op` inferred from
 * what else was given.
 */
export function normalizeGatewayArguments(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	if (typeof out.capability !== "string") {
		const alias = out.name ?? out.tool;
		if (typeof alias === "string") out.capability = alias;
	}
	if (typeof out.args === "string") {
		try {
			const parsed: unknown = JSON.parse(out.args);
			if (isRecord(parsed)) out.args = parsed;
		} catch {
			// The body reports the unparseable string.
		}
	}
	// An empty `parameters` object carries nothing; refusing it blamed a correctly
	// shaped call for an envelope it never used (bt-23 N3).
	if (isRecord(out.parameters) && Object.keys(out.parameters).length === 0) delete out.parameters;
	// Arguments only ever belong to a call. A request carrying them without a
	// capability is a call whose envelope was nested inside `args`; reading it
	// as find answered a mis-wrapped call with a successful discovery listing,
	// and the model took that as the call having run.
	if (typeof out.op !== "string") {
		if (out.args !== undefined) out.op = "call";
		else if (typeof out.capability === "string") out.op = "describe";
		else out.op = "find";
	}
	return out;
}

/** The capability a gateway envelope calls, trimmed, or null when it is not a call naming one. */
export function gatewayCallCapability(args: unknown): string | null {
	if (!isRecord(args)) return null;
	const envelope = normalizeGatewayArguments(args);
	if (envelope.op !== "call" || typeof envelope.capability !== "string") return null;
	const capability = envelope.capability.trim();
	return capability.length > 0 ? capability : null;
}
