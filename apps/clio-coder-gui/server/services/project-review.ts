import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	MEMORY_PENDING_MAX,
	type MemoryDecision,
	MemoryPending,
	TRUST_PREVIEW_FILES_MAX,
	TRUST_PREVIEW_TEXT_MAX,
	TrustPreview,
	type TrustSurface,
} from "../../contracts/review.js";
import type { CliRunner } from "./cli-runner.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
/** Cut a file's text before validation so one large file still previews; the cut is reported with its length. */
function boundedFile(value: unknown): unknown {
	const file = object(value);
	if (!file || typeof file.text !== "string" || file.text.length <= TRUST_PREVIEW_TEXT_MAX) return value;
	let end = TRUST_PREVIEW_TEXT_MAX;
	// Never leave half a surrogate pair at the cut.
	const last = file.text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return { ...file, text: file.text.slice(0, end), truncatedFrom: file.text.length };
}
function boundedFiles(value: unknown, surface: TrustSurface): unknown {
	if (!Array.isArray(value)) return value;
	if (value.length > TRUST_PREVIEW_FILES_MAX)
		throw new AppProblem(
			"unsupported",
			`Project ${surface} names more than ${TRUST_PREVIEW_FILES_MAX} files. Review it in a terminal with clio-coder config trust ${surface}.`,
		);
	return value.map(boundedFile);
}
function checked<S extends TSchema>(schema: S, raw: unknown, what: string) {
	const value = Value.Clean(schema, raw);
	if (!Value.Check(schema, value)) throw new AppProblem("unavailable", `CLIO Coder returned an invalid ${what}.`);
	return value;
}
const pending = (record: Record<string, unknown>) => record.approved === false && record.rejectedAt === undefined;

/** The operator's two review decisions a terminal makes today: project trust and pending memory lessons. */
export class ProjectReviewService {
	constructor(
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
	) {}
	async trustPreview(workspaceId: string, surface: TrustSurface) {
		const workspace = await this.workspaces.get(workspaceId);
		return this.preview(workspace.path, surface);
	}
	private async preview(cwd: string, surface: TrustSurface) {
		const raw = object(await this.runner.run({ kind: "trust.preview", surface }, cwd));
		if (!raw) throw new AppProblem("unavailable", "CLIO Coder returned an invalid trust preview.");
		// Cleaning drops what the contract does not carry: package digests and origins, a repository's fingerprint.
		return checked(
			TrustPreview,
			{
				...raw,
				files: boundedFiles(raw.files, surface),
				...(raw.scripts !== undefined ? { scripts: boundedFiles(raw.scripts, surface) } : {}),
			},
			"trust preview",
		);
	}
	async trustApprove(workspaceId: string, surface: TrustSurface, hash: string) {
		const workspace = await this.workspaces.get(workspaceId);
		try {
			await this.runner.run({ kind: "trust.approve", surface, hash }, workspace.path);
		} catch (error) {
			// The runner keeps the CLI's stderr private, so a refusal is told apart by reading the bytes again.
			if (!(error instanceof AppProblem) || error.problem.code !== "operation_failed") throw error;
			const current = await this.preview(workspace.path, surface).catch(() => null);
			if (current !== null && !current.files.some((file) => file.text !== null))
				throw new AppProblem("conflict", `Project ${surface} has no readable file to trust.`);
			if (current !== null && current.contentHash !== hash)
				throw new AppProblem("conflict", "The files changed after you opened this review.");
			throw error;
		}
		return {};
	}
	async memoryPending(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		return this.pendingAt(workspace.path);
	}
	private async pendingAt(cwd: string) {
		const raw = object(await this.runner.run({ kind: "memory.list" }, cwd));
		if (!raw || !Array.isArray(raw.records))
			throw new AppProblem("unavailable", "CLIO Coder returned an invalid memory list.");
		const records = raw.records
			.map(object)
			.filter((record): record is Record<string, unknown> => record !== null && pending(record))
			.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
			.slice(0, MEMORY_PENDING_MAX);
		return checked(MemoryPending, { records }, "memory list");
	}
	async memoryDecide(workspaceId: string, id: string, decision: MemoryDecision) {
		const workspace = await this.workspaces.get(workspaceId);
		try {
			await this.runner.run({ kind: "memory.decide", id, decision }, workspace.path);
		} catch (error) {
			if (!(error instanceof AppProblem) || error.problem.code !== "operation_failed") throw error;
			const waiting = await this.pendingAt(workspace.path).catch(() => null);
			if (waiting !== null && !waiting.records.some((record) => record.id === id))
				throw new AppProblem("conflict", `Lesson ${id} is no longer waiting for review.`);
			throw error;
		}
		return {};
	}
}
