import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import {
	cacheReport,
	callsReport,
	costReport,
	explain,
	runRowTelemetry,
	runTelemetry,
	sessionTelemetry,
	timeline,
	whyStopped,
} from "../../../../../src/domains/observability/read-model.js";
import type { RunListCursor } from "../../../../../src/domains/session/telemetry-source.js";
import {
	listRunTelemetrySources,
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
	if (input.kind === "runs") {
		const page = listRunTelemetrySources(state, { limit: input.limit, before: cursorOf(input.cursor) });
		return {
			runs: page.runs.map(({ runId, source }) => runRowTelemetry(runId, source)),
			nextCursor: page.nextBefore ? Buffer.from(JSON.stringify(page.nextBefore)).toString("base64url") : null,
		};
	}
	if (input.kind === "run") {
		if (!Value.Check(Id, input.runId)) throw new AppProblem("validation", "Invalid run identifier.");
		// A run that never had a directory is not found; one whose journal is missing or torn is unknown coverage.
		if (!existsSync(join(state, "runs", input.runId))) throw new AppProblem("not_found", "No run journal holds that id.");
		return runTelemetry(input.runId, loadRunTelemetrySource(state, input.runId));
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

const Cursor = Type.Object(
	{ writtenMs: Type.Union([Type.Number(), Type.Null()]), runId: Id },
	{ additionalProperties: false },
);
function cursorOf(encoded: string | undefined): RunListCursor | null {
	if (encoded === undefined) return null;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!Value.Check(Cursor, decoded)) throw new Error("cursor");
		return decoded;
	} catch {
		throw new AppProblem("validation", "Invalid telemetry run cursor.");
	}
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
