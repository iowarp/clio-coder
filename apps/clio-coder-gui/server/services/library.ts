import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { LibraryAgents, LibraryVerifiers } from "../../contracts/library.js";
import type { WorkerHost } from "../worker/host.js";
import type { CliRunner } from "./cli-runner.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

function checked<S extends TSchema>(schema: S, raw: unknown): Static<S> {
	const value = Value.Clean(schema, raw);
	if (!Value.Check(schema, value)) throw new AppProblem("unavailable", "Library returned an invalid projection.");
	return value;
}
export class LibraryService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
	) {}
	async read<S extends TSchema>(workspaceId: string, kind: "inventory" | "extensions", schema: S) {
		const workspace = await this.workspaces.get(workspaceId);
		return checked(schema, await this.reads.call("library.read", { kind, cwd: workspace.path }, { deadlineMs: 20_000 }));
	}
	async agents(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		const raw = await this.runner.run({ kind: "library.agents" }, workspace.path);
		if (!Array.isArray(raw) || raw.length > 2000)
			throw new AppProblem("unavailable", "Agent inventory is invalid or exceeds 2,000 rows.");
		const agents = (raw as unknown[]).map((value) => {
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new AppProblem("unavailable", "Invalid agent row.");
			const { id, name, description, source, audience, category, skills, tools, ...configuration } = value as Record<
				string,
				unknown
			>;
			return { id, name, description, source, audience, category, skills, tools, configuration };
		});
		return checked(LibraryAgents, { agents });
	}
	async verifiers(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		return checked(LibraryVerifiers, await this.runner.run({ kind: "library.verifiers" }, workspace.path));
	}
}
