import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TraceRequest } from "../../contracts/traces.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";

export class TraceService {
	constructor(private readonly reads: WorkerHost) {}
	async read<S extends TSchema>(input: TraceRequest, schema: S): Promise<Static<S>> {
		const raw = await this.reads.call("traces.read", input);
		// Explicit closed schemas are the public projection: unknown database columns cannot escape.
		const projected = Value.Clean(schema, raw);
		if (!Value.Check(schema, projected)) throw new AppProblem("unavailable", "Trace storage returned an invalid record.");
		if (input.kind === "receipt" && !input.full && projected && typeof projected === "object" && "receipt" in projected) {
			const receipt = projected.receipt;
			if (receipt && typeof receipt === "object")
				for (const key of ["output", "upstreamResponses", "routeDecision", "briefing", "steering"])
					Reflect.deleteProperty(receipt, key);
		}
		return projected;
	}
}
