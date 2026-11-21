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
 * A string `args` as the object it encodes. A chain envelope cut one brace short
 * (the most common truncation, C-8) is read with that brace restored, only when
 * the envelope reads as a chain and the restored object carries `steps`; any
 * other string that does not parse, a call's included, is never guessed at.
 */
function parsedArgs(text: string, chainLike: boolean): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		if (!chainLike) return null;
		try {
			const repaired: unknown = JSON.parse(`${text}}`);
			return isRecord(repaired) && repaired.steps !== undefined ? repaired : null;
		} catch {
			return null;
		}
	}
}

/**
 * Accept the weak-model shapes: `args` as a JSON string, `name`/`tool` for
 * `capability`, an empty `parameters` object, and a missing `op` inferred from
 * what else was given. A chain's `steps` nested in `args` is lifted beside
 * `op`, and `steps` without a capability reads as a chain (C-8).
 */
export function normalizeGatewayArguments(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	if (typeof out.capability !== "string") {
		const alias = out.name ?? out.tool;
		if (typeof alias === "string") out.capability = alias;
	}
	// A chain by its envelope: `op` chain, or no `op` and no capability. An explicit other op never is.
	const chainLike = out.op === "chain" || (out.op === undefined && typeof out.capability !== "string");
	if (typeof out.args === "string") {
		// The body reports a string that is not an object.
		const parsed = parsedArgs(out.args, chainLike && out.steps === undefined);
		if (parsed !== null) out.args = parsed;
	}
	if (chainLike && out.steps === undefined && isRecord(out.args) && out.args.steps !== undefined) {
		const { steps, ...rest } = out.args;
		out.steps = steps;
		if (Object.keys(rest).length === 0) delete out.args;
		else out.args = rest;
	}
	if (out.op === "chain" && out.steps !== undefined) delete out.capability;
	// An empty `parameters` object carries nothing; refusing it blamed a correctly
	// shaped call for an envelope it never used (bt-23 N3).
	if (isRecord(out.parameters) && Object.keys(out.parameters).length === 0) delete out.parameters;
	// Arguments only ever belong to a call. A request carrying them without a
	// capability is a call whose envelope was nested inside `args`; reading it
	// as find answered a mis-wrapped call with a successful discovery listing,
	// and the model took that as the call having run.
	if (typeof out.op !== "string") {
		if (out.steps !== undefined && typeof out.capability !== "string") out.op = "chain";
		else if (out.args !== undefined) out.op = "call";
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
