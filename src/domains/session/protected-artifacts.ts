import { type ProtectedArtifact, type ProtectedArtifactState, protectArtifact } from "../safety/protected-artifacts.js";
import type { ProtectedArtifactEntry, ProtectedArtifactEntryArtifact, SessionEntry } from "./entries.js";

export interface ProtectedArtifactEntryContext {
	parentTurnId: string | null;
	toolName?: string;
	toolCallId?: string;
	runId?: string;
	correlationId?: string;
}

export type ProtectedArtifactEntryInput = Omit<ProtectedArtifactEntry, "turnId" | "timestamp"> & {
	turnId?: string;
	timestamp?: string;
};

export function protectedArtifactEntryFromArtifact(
	artifact: ProtectedArtifact,
	context: ProtectedArtifactEntryContext,
): ProtectedArtifactEntryInput {
	const entry: ProtectedArtifactEntryInput = {
		kind: "protectedArtifact",
		parentTurnId: context.parentTurnId,
		action: "protect",
		artifact: artifactSnapshot(artifact),
	};
	if (context.toolName !== undefined) entry.toolName = context.toolName;
	if (context.toolCallId !== undefined) entry.toolCallId = context.toolCallId;
	if (context.runId !== undefined) entry.runId = context.runId;
	if (context.correlationId !== undefined) entry.correlationId = context.correlationId;
	return entry;
}

export function protectedArtifactFromSessionEntry(entry: ProtectedArtifactEntry): ProtectedArtifact {
	return protectedArtifactFromSnapshot(entry.artifact);
}

export function protectedArtifactStateFromSessionEntries(entries: ReadonlyArray<SessionEntry>): ProtectedArtifactState {
	let state: ProtectedArtifactState = { artifacts: [] };
	const protectedEntries = entries
		.map((entry, index) => ({ entry, index }))
		.filter((item): item is { entry: ProtectedArtifactEntry; index: number } => item.entry.kind === "protectedArtifact")
		.sort(compareProtectedEntryPositions);
	for (const item of protectedEntries) {
		if (item.entry.action !== "protect") continue;
		state = protectArtifact(state, protectedArtifactFromSessionEntry(item.entry));
	}
	return state;
}

function artifactSnapshot(artifact: ProtectedArtifact): ProtectedArtifactEntryArtifact {
	const snapshot: ProtectedArtifactEntryArtifact = {
		path: artifact.path,
		protectedAt: artifact.protectedAt,
		reason: artifact.reason,
		source: artifact.source,
	};
	if (artifact.validationCommand !== undefined) snapshot.validationCommand = artifact.validationCommand;
	if (artifact.validationExitCode !== undefined) snapshot.validationExitCode = artifact.validationExitCode;
	return snapshot;
}

function protectedArtifactFromSnapshot(snapshot: ProtectedArtifactEntryArtifact): ProtectedArtifact {
	const artifact: ProtectedArtifact = {
		path: snapshot.path,
		protectedAt: snapshot.protectedAt,
		reason: snapshot.reason,
		source: snapshot.source,
	};
	if (snapshot.validationCommand !== undefined) artifact.validationCommand = snapshot.validationCommand;
	if (snapshot.validationExitCode !== undefined) artifact.validationExitCode = snapshot.validationExitCode;
	return artifact;
}

function compareProtectedEntryPositions(
	left: { entry: ProtectedArtifactEntry; index: number },
	right: { entry: ProtectedArtifactEntry; index: number },
): number {
	return (
		compareStrings(left.entry.timestamp, right.entry.timestamp) ||
		compareStrings(left.entry.turnId, right.entry.turnId) ||
		left.index - right.index
	);
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
