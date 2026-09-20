import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	EvidenceItem,
	type EvidenceOperationResult,
	type EvidenceRequest,
	ReceiptVerification,
} from "../../contracts/evidence.js";
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
	async execute(workspaceId: string, runId: string, action: "build" | "verify", key: string) {
		const workspace = await this.workspaces.get(workspaceId);
		return this.operations.create({
			kind: `evidence.${action}`,
			scope: workspaceId,
			key,
			fingerprint: fingerprint({ workspaceId, runId, action }),
			cancellable: false,
			run: async (progress): Promise<EvidenceOperationResult> => {
				progress(
					action === "build"
						? "Clio is collecting the run’s evidence."
						: "Clio is checking the receipt against its recorded run.",
				);
				if (action === "verify") {
					const verification = Value.Clean(
						ReceiptVerification,
						await this.runner.run({ kind: "receipt.verify", id: runId }, workspace.path),
					);
					if (!Value.Check(ReceiptVerification, verification))
						throw new AppProblem("operation_failed", "Receipt verification returned an invalid projection.");
					return {
						kind: "receipt-verification",
						id: runId,
						exitCode: 0,
						message: `Receipt check: ${verification.state}.`,
						verification,
					};
				}
				try {
					await this.runner.run({ kind: "evidence.build", id: runId }, workspace.path);
					const artifact = await this.read({ kind: "built", runId }, EvidenceItem);
					return {
						kind: "evidence",
						id: artifact.overview.evidenceId,
						exitCode: 0,
						message: "Evidence collected. Review its findings and trust status.",
						artifact,
					};
				} catch {
					throw new AppProblem(
						"operation_failed",
						"Evidence collection or its follow-up read failed. Clio may have written an artifact with integrity findings; refresh the evidence list before retrying.",
					);
				}
			},
		});
	}
}
