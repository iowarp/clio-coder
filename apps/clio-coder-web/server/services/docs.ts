import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { DocsRequest } from "../../contracts/docs.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";

export class DocsService {
	constructor(private readonly reads: WorkerHost) {}
	async read<S extends TSchema>(input: DocsRequest, schema: S): Promise<Static<S>> {
		const raw = await this.reads.call("docs.read", input);
		if (!Value.Check(schema, raw)) throw new AppProblem("unavailable", "Documentation returned an invalid record.");
		return raw;
	}
	blueprint(path: string) {
		return this.reads.call("docs.blueprint", { path });
	}
}
