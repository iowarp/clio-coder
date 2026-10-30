import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TelemetryRequest } from "../../contracts/telemetry.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";

export class TelemetryService {
	constructor(
		private readonly reads: WorkerHost,
		/** Whether this host holds the session: then a missing journal is unknown coverage, not a 404 (R9). */
		private readonly known: (sessionId: string) => boolean = () => false,
	) {}
	async read<S extends TSchema>(input: TelemetryRequest, schema: S): Promise<Static<S>> {
		const request: TelemetryRequest =
			"sessionId" in input ? { ...input, knownSession: this.known(input.sessionId) } : input;
		const raw = await this.reads.call("telemetry.read", request);
		// The DTO is the public projection and its schema is closed, so it is checked as served, never cleaned: a
		// field the contract does not describe is a drift to surface, not a column to drop (#434 R11).
		if (!Value.Check(schema, raw))
			throw new AppProblem("unavailable", "The telemetry read model returned a shape the contract does not describe.");
		return raw;
	}
}
