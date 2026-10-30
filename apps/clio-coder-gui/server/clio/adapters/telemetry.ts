import { Value } from "typebox/value";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import {
	cacheReport,
	callsReport,
	costReport,
	explain,
	sessionTelemetry,
	timeline,
	whyStopped,
} from "../../../../../src/domains/observability/read-model.js";
import {
	loadRunTelemetrySource,
	loadSessionTelemetrySource,
} from "../../../../../src/domains/session/telemetry-source.js";
import { Id } from "../../../contracts/common.js";
import type { TelemetryRequest } from "../../../contracts/telemetry.js";
import { parseFactRef } from "../../../contracts/wire.js";
import { AppProblem } from "../../services/problem.js";
import { preflightLedger } from "./sessions.js";

/**
 * The telemetry read model for the GUI (#434 §11.3): cold reads over the journals on disk through the same loader
 * and folds the CLI uses, so a number served here is the number `clio-coder telemetry … --json` prints. Nothing
 * here sums, prices or words a value; the DTOs come back as the read model built them.
 */
export function readTelemetry(input: TelemetryRequest): unknown {
	const state = clioStateDir();
	if (input.kind === "explain") {
		const ref = parseFactRef(input.ref);
		if (!ref || !Value.Check(Id, ref.owner)) throw new AppProblem("validation", "Invalid telemetry reference.");
		if (ref.scope !== "run" && !preflightLedger()) throw notFound();
		const explained =
			ref.scope === "run"
				? explain(input.ref, { runId: ref.owner, run: loadRunTelemetrySource(state, ref.owner) })
				: resolveSession(state, ref.owner, (session) => explain(input.ref, { session }));
		if (!explained) throw new AppProblem("not_found", "Nothing in the journals resolves that telemetry reference.");
		return explained;
	}
	if (!Value.Check(Id, input.sessionId)) throw new AppProblem("validation", "Invalid session identifier.");
	if (!preflightLedger()) throw notFound();
	return resolveSession(state, input.sessionId, (source) => {
		switch (input.kind) {
			case "session":
				return sessionTelemetry(source);
			case "calls":
				return callsReport(source, input.filter);
			case "cost":
				return costReport(source, input.by);
			case "cache":
				return cacheReport(source);
			case "timeline":
				return timeline(source, input.range);
			case "why-stopped":
				return whyStopped(source);
		}
	});
}

function notFound() {
	return new AppProblem("not_found", "No session journal or ledger holds that id.");
}

function resolveSession<T>(
	state: string,
	sessionId: string,
	read: (source: NonNullable<ReturnType<typeof loadSessionTelemetrySource>>) => T,
): T {
	let source: ReturnType<typeof loadSessionTelemetrySource>;
	try {
		source = loadSessionTelemetrySource(state, sessionId);
	} catch (error) {
		if (error instanceof AppProblem) throw error;
		throw new AppProblem("unavailable", "The session's telemetry journal cannot be read.");
	}
	if (!source) throw notFound();
	return read(source);
}
