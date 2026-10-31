import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { type EvidenceOperationResult, type EvidenceRequest, RunRecordVerification } from "../../contracts/evidence.js";
import type { WorkerHost } from "../worker/host.js";
import type { CliRunner } from "./cli-runner.js";
import { fingerprint, type OperationRegistry } from "./operations.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

export class EvidenceService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
		private readonly operations: OperationRegistry,
	) {}
	async read<S extends TSchema>(input: EvidenceRequest, schema: S): Promise<Static<S>> {
		const value = Value.Clean(schema, await this.reads.call("evidence.read", input));
		if (!Value.Check(schema, value)) throw new AppProblem("unavailable", "Evidence returned an invalid projection.");
		return value;
	}
	/**
	 * `runId` reaches a child process argv, so it must already be an id this host
	 * served: the route admits it against the ArtifactWindow and passes the
	 * admitted value. Nothing here re-derives it from the request. A run's
	 * evidence is assessed when it settles, so the one operation left is the
	 * record recheck.
	 */
	async execute(workspaceId: string, runId: string, key: string) {
		const workspace = await this.workspaces.get(workspaceId);
		return this.operations.create({
			kind: "evidence.verify",
			scope: workspaceId,
			key,
			fingerprint: fingerprint({ workspaceId, runId, action: "verify" }),
			cancellable: false,
			run: async (progress): Promise<EvidenceOperationResult> => {
				progress("Clio is checking the record against its recorded run.");
				const verification = Value.Clean(
					RunRecordVerification,
					await this.runner.run({ kind: "run.verify", id: runId }, workspace.path),
				);
				if (!Value.Check(RunRecordVerification, verification))
					throw new AppProblem("operation_failed", "Run record verification returned an invalid projection.");
				return {
					kind: "run-record-verification",
					id: runId,
					exitCode: 0,
					message: `Run record check: ${verification.state}.`,
					verification,
				};
			},
		});
	}
}
