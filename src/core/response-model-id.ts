/** What Clio directly observed about a provider response model id. */
export type ResponseModelIdObservation =
	| { state: "reported"; reportedModelId: string }
	| { state: "not-reported" }
	| { state: "not-observed" }
	| { state: "legacy-difference-only"; differingModelId: string | null };

export type MissingResponseModelIdObservation = "not-observed" | "legacy-difference-only";

/** Call counts grouped by the exact response model-id observation state. */
export interface ResponseModelIdObservationCounts {
	reportedCalls: number;
	notReportedCalls: number;
	notObservedCalls: number;
	legacyDifferenceOnlyCalls: number;
}

export function emptyResponseModelIdObservationCounts(): ResponseModelIdObservationCounts {
	return { reportedCalls: 0, notReportedCalls: 0, notObservedCalls: 0, legacyDifferenceOnlyCalls: 0 };
}

export function addResponseModelIdObservationCount(
	counts: ResponseModelIdObservationCounts,
	observation: ResponseModelIdObservation,
	calls = 1,
): void {
	switch (observation.state) {
		case "reported":
			counts.reportedCalls += calls;
			break;
		case "not-reported":
			counts.notReportedCalls += calls;
			break;
		case "not-observed":
			counts.notObservedCalls += calls;
			break;
		case "legacy-difference-only":
			counts.legacyDifferenceOnlyCalls += calls;
			break;
	}
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsedObservation(value: unknown): ResponseModelIdObservation | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	switch (record.state) {
		case "reported": {
			const reportedModelId = nonEmptyString(record.reportedModelId);
			return reportedModelId === null ? null : { state: "reported", reportedModelId };
		}
		case "not-reported":
			return { state: "not-reported" };
		case "not-observed":
			return { state: "not-observed" };
		case "legacy-difference-only":
			return { state: "legacy-difference-only", differingModelId: nonEmptyString(record.differingModelId) };
		default:
			return null;
	}
}

/**
 * Read the current observation shape and the short-lived #193 shape. A caller
 * chooses how to label a missing field because a live message is not historical,
 * while a persisted row without either shape predates model-id presence capture.
 */
export function responseModelIdObservationFromRecord(
	record: Readonly<Record<string, unknown>>,
	missing: MissingResponseModelIdObservation,
): ResponseModelIdObservation {
	const current = parsedObservation(record.responseModelIdObservation);
	if (current !== null) return current;
	if (Object.hasOwn(record, "servedModel")) {
		const reportedModelId = nonEmptyString(record.servedModel);
		return reportedModelId === null ? { state: "not-reported" } : { state: "reported", reportedModelId };
	}
	if (missing === "not-observed") return { state: "not-observed" };
	return { state: "legacy-difference-only", differingModelId: nonEmptyString(record.responseModel) };
}

/** The response's model id only when it is not the requested one; a stream that echoes the requested id differs in nothing. */
export function differingResponseModelId(requestedModelId: unknown, responseModelId: unknown): string | null {
	const response = nonEmptyString(responseModelId);
	return response === null || response === nonEmptyString(requestedModelId) ? null : response;
}

/**
 * A route refused because the model it names is not the one the provider will serve. `model_unavailable` is the
 * pre-call refusal: the target's live model list lacks the requested id. `served_model_mismatch` is the backstop: the
 * provider accepted the id and reported serving another. Either ends the turn before any tool call of that response.
 */
export type ModelRouteRefusal =
	| { code: "model_unavailable"; target: string; requested: string; available: string[] }
	| { code: "served_model_mismatch"; requested: string; served: string };

/** The one sentence every surface prints for a refused route. */
export function modelRouteRefusalMessage(refusal: ModelRouteRefusal): string {
	if (refusal.code === "served_model_mismatch")
		return `requested ${refusal.requested}, provider served ${refusal.served}; the turn is refused. Pick another model with /model.`;
	const shown = refusal.available.slice(0, 24);
	const more = refusal.available.length > shown.length ? `, and ${refusal.available.length - shown.length} more` : "";
	return `no model ${refusal.requested} on target ${refusal.target}; available: ${shown.length > 0 ? shown.join(", ") : "none"}${more}. Pick another with /model.`;
}

/** The typed refusal a refused assistant message carries, or null. */
export function modelRouteRefusalOf(message: unknown): ModelRouteRefusal | null {
	if (message === null || typeof message !== "object") return null;
	const value = (message as { modelRouteRefusal?: unknown }).modelRouteRefusal;
	if (value === null || typeof value !== "object") return null;
	const code = (value as { code?: unknown }).code;
	return code === "model_unavailable" || code === "served_model_mismatch" ? (value as ModelRouteRefusal) : null;
}

/**
 * Whether a runtime tier names models the way the guards can judge. A cloud provider and a subscription seat own their
 * model catalogs; a local engine (llama.cpp reports its alias or GGUF path) and a protocol gateway (LiteLLM maps its
 * own model names) report labels their operator configured, so neither guard applies to them.
 */
export function modelRouteGuarded(runtime: { tier?: string | undefined } | null | undefined): boolean {
	return runtime?.tier === "cloud" || runtime?.tier === "subscription";
}

const DATED_SNAPSHOT = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|0\d{2})$/u;

/**
 * A model id split into the model it names and the snapshot it pins, after the aliasing providers apply to one model:
 * lower case; a provider or path prefix and any `:tag` dropped (`openai/gpt-4o`, `models/gemini-2.5-pro`,
 * `llama-3-8b:free`); a `-latest` suffix dropped; dots read as dashes (`claude-opus-4.5` is `claude-opus-4-5`) and a
 * trailing `-0` minor dropped (`claude-sonnet-4-0` is `claude-sonnet-4`). The snapshot is a Vertex `@version` or a
 * dated or numbered suffix (`-20250514`, `-2024-08-06`, `-0613`, `-002`), dashes removed; null for a floating alias.
 */
function modelIdParts(id: string): { model: string; snapshot: string | null } {
	let out = id.trim().toLowerCase();
	out = out.slice(out.lastIndexOf("/") + 1).replace(/:.*$/u, "");
	let snapshot: string | null = null;
	const at = out.indexOf("@");
	if (at >= 0) {
		const version = out.slice(at + 1).replace(/-/gu, "");
		snapshot = version === "" || version === "latest" ? null : version;
		out = out.slice(0, at);
	}
	out = out.replace(/-latest$/u, "");
	const dated = DATED_SNAPSHOT.exec(out);
	if (dated) {
		snapshot ??= dated[0].slice(1).replace(/-/gu, "");
		out = out.slice(0, dated.index);
	}
	return { model: out.replace(/\./gu, "-").replace(/-0$/u, ""), snapshot };
}

/**
 * Whether a reported id names the requested model: the same model, and the same snapshot unless one side is a floating
 * alias (`claude-sonnet-4` against `claude-sonnet-4-20250514`). Another version (`gpt-5.1` is not `gpt-5`), another
 * variant (`gpt-4o-mini` is not `gpt-4o`) or another pinned snapshot (`gpt-4o-2024-05-13` is not
 * `gpt-4o-2024-08-06`) is another model.
 */
export function sameServedModel(requested: string, reported: string): boolean {
	const a = modelIdParts(requested);
	const b = modelIdParts(reported);
	if (a.model.length === 0 || b.model.length === 0) return true;
	return a.model === b.model && (a.snapshot === null || b.snapshot === null || a.snapshot === b.snapshot);
}

/**
 * Whether a listed id offers the requested model. A floating alias is offered by any snapshot of its model; a pinned
 * snapshot only by that snapshot, since a list that names other snapshots of the model does not serve this one.
 */
export function listedModelOffers(listed: string, requested: string): boolean {
	const want = modelIdParts(requested);
	const have = modelIdParts(listed);
	return (
		want.model.length > 0 && want.model === have.model && (want.snapshot === null || want.snapshot === have.snapshot)
	);
}

/**
 * The served id when a provider reported serving a model other than the requested one; null when it reported none,
 * reported the same model, or the request named a router (`openrouter/auto`) whose job is to choose.
 */
export function servedModelMismatch(requestedModelId: string, observation: unknown): string | null {
	const parsed = parsedObservation(observation);
	if (parsed?.state !== "reported") return null;
	if (requestedModelId.trim().toLowerCase().split("/").at(-1) === "auto") return null;
	return sameServedModel(requestedModelId, parsed.reportedModelId) ? null : parsed.reportedModelId;
}

/** Model id used for accounting without claiming more than the observation supports. */
export function attributedModelId(
	observation: ResponseModelIdObservation,
	requestedModelId: string,
	differingResponseModelId: string | null,
): string {
	switch (observation.state) {
		case "reported":
			return observation.reportedModelId;
		case "not-reported":
			return "unknown";
		case "not-observed":
			return differingResponseModelId ?? requestedModelId;
		case "legacy-difference-only":
			return observation.differingModelId ?? requestedModelId;
	}
}
