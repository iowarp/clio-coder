import { Value } from "typebox/value";
import type { MachineMutation } from "../../contracts/machines.js";
import { Machines } from "../../contracts/machines.js";
import type { WorkerHost } from "../worker/host.js";
import type { OperationRegistry } from "./operations.js";
import { fingerprint } from "./operations.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

export class MachinesService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly ops: WorkerHost,
		private readonly workspaces: WorkspaceService,
		private readonly operations: OperationRegistry,
	) {}

	async list(workspaceId: string): Promise<Machines> {
		const workspace = await this.workspaces.get(workspaceId);
		const machines = await this.reads.call("machines.list", { cwd: workspace.path }, { deadlineMs: 65_000 });
		const result = { workspaceId, projectRoot: workspace.path, observedAt: new Date().toISOString(), machines };
		if (!Value.Check(Machines, result)) throw new AppProblem("unavailable", "Invalid machine inventory.");
		return result;
	}

	async mutate(workspaceId: string, mutation: MachineMutation, key: string) {
		const workspace = await this.workspaces.get(workspaceId);
		return this.operations.create({
			kind: `machines.${mutation.action}`,
			scope: workspaceId,
			key,
			fingerprint: fingerprint({ workspaceId, mutation }),
			run: async (progress) => {
				progress(
					mutation.action === "check"
						? `Checking and recording SSH readiness for ${workspace.path}.`
						: "Updating the user fleet-node registry.",
				);
				return this.ops.call("machines.mutate", { cwd: workspace.path, mutation }, { progress });
			},
		});
	}
}
