import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { FleetRequest } from "../../contracts/fleet.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";

export class FleetService {
	constructor(private readonly reads: WorkerHost) {}
	async read<S extends TSchema>(input: FleetRequest, schema: S): Promise<Static<S>> {
		const raw = await this.reads.call("fleet.read", input);
		const value = Value.Clean(schema, raw);
		if (!Value.Check(schema, value)) throw new AppProblem("unavailable", "Fleet storage returned an invalid projection.");
		return value;
	}
}
