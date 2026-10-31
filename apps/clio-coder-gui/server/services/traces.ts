import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TraceRequest } from "../../contracts/traces.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";

export class TraceService {
	constructor(private readonly reads: WorkerHost) {}
	async read<S extends TSchema>(input: TraceRequest, schema: S): Promise<Static<S>> {
		const raw = await this.reads.call("traces.read", input);
		// Explicit closed schemas are the public projection: unknown ledger or record fields cannot escape.
		const projected = Value.Clean(schema, raw);
		if (!Value.Check(schema, projected)) throw new AppProblem("unavailable", "Trace storage returned an invalid record.");
		// The saved document leaves only when asked for; by default the record is its evidence alone.
		if (input.kind === "run-record" && !input.full && projected && typeof projected === "object" && "record" in projected)
			Reflect.set(projected, "record", null);
		return projected;
	}
}
