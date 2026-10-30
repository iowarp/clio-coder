import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TelemetryRequest } from "../../contracts/telemetry.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";

export class TelemetryService {
	constructor(private readonly reads: WorkerHost) {}
	async read<S extends TSchema>(input: TelemetryRequest, schema: S): Promise<Static<S>> {
		const raw = await this.reads.call("telemetry.read", input);
		// The DTO is the public projection and its schema is closed, so it is checked as served, never cleaned: a
		// field the contract does not describe is a drift to surface, not a column to drop (#434 R11).
		if (!Value.Check(schema, raw))
			throw new AppProblem("unavailable", "The telemetry read model returned a shape the contract does not describe.");
		return raw;
	}
}
