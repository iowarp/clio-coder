/**
 * Write-ahead durability for protected-artifact registrations.
 *
 * A middleware protection becomes live before the session ledger append can
 * complete. Stage it here first so an append fault cannot erase the hard
 * block on reset or process restart. Successful ledger appends remove the
 * staged file; startup/session reload reconciles any remainder before it
 * declares the protection state trustworthy.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import type { ProtectedArtifact } from "../safety/protected-artifacts.js";
import type { ProtectedArtifactProtectEvent } from "../safety/protected-artifacts-registration.js";
import type { SessionContract } from "./contract.js";
import { protectedArtifactEntryFromArtifact } from "./protected-artifacts.js";

export interface PendingProtectedArtifactRecord {
	version: 1;
	id: string;
	sessionId: string;
	artifact: ProtectedArtifact;
	context: {
		parentTurnId: string | null;
		toolName: string;
		toolCallId?: string;
		runId?: string;
		correlationId?: string;
	};
	createdAt: string;
	integrity: { algorithm: "sha256"; digest: string };
}

export interface PendingProtectedArtifactHandle {
	record: PendingProtectedArtifactRecord;
	path: string;
}

export interface PendingProtectedArtifactReadResult {
	records: PendingProtectedArtifactHandle[];
	errors: Array<{ path: string; message: string }>;
}

function sessionKey(sessionId: string): string {
	return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function journalDirectory(sessionId: string): string {
	return join(clioStateDir(), "protected-artifact-pending", sessionKey(sessionId));
}

function artifactPayload(artifact: ProtectedArtifact): Record<string, unknown> {
	return {
		path: artifact.path,
		protectedAt: artifact.protectedAt,
		reason: artifact.reason,
		source: artifact.source,
		...(artifact.validationCommand !== undefined ? { validationCommand: artifact.validationCommand } : {}),
		...(artifact.validationExitCode !== undefined ? { validationExitCode: artifact.validationExitCode } : {}),
	};
}

function recordPayload(record: Omit<PendingProtectedArtifactRecord, "integrity">): Record<string, unknown> {
	return {
		contract: "clio.protectedArtifact.pending",
		version: record.version,
		id: record.id,
		sessionId: record.sessionId,
		artifact: artifactPayload(record.artifact),
		context: {
			parentTurnId: record.context.parentTurnId,
			toolName: record.context.toolName,
			...(record.context.toolCallId !== undefined ? { toolCallId: record.context.toolCallId } : {}),
			...(record.context.runId !== undefined ? { runId: record.context.runId } : {}),
			...(record.context.correlationId !== undefined ? { correlationId: record.context.correlationId } : {}),
		},
		createdAt: record.createdAt,
	};
}

function digest(record: Omit<PendingProtectedArtifactRecord, "integrity">): string {
	return createHash("sha256")
		.update(JSON.stringify(recordPayload(record)), "utf8")
		.digest("hex");
}

function withoutIntegrity(record: PendingProtectedArtifactRecord): Omit<PendingProtectedArtifactRecord, "integrity"> {
	return {
		version: record.version,
		id: record.id,
		sessionId: record.sessionId,
		artifact: { ...record.artifact },
		context: { ...record.context },
		createdAt: record.createdAt,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown, sessionId: string): PendingProtectedArtifactRecord | null {
	if (!isRecord(value) || value.version !== 1 || value.sessionId !== sessionId) return null;
	if (
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		typeof value.createdAt !== "string" ||
		!isRecord(value.artifact) ||
		typeof value.artifact.path !== "string" ||
		typeof value.artifact.protectedAt !== "string" ||
		typeof value.artifact.reason !== "string" ||
		(value.artifact.source !== "validation" &&
			value.artifact.source !== "middleware" &&
			value.artifact.source !== "user" &&
			value.artifact.source !== "session") ||
		!isRecord(value.context) ||
		(value.context.parentTurnId !== null && typeof value.context.parentTurnId !== "string") ||
		typeof value.context.toolName !== "string" ||
		!isRecord(value.integrity) ||
		value.integrity.algorithm !== "sha256" ||
		typeof value.integrity.digest !== "string"
	) {
		return null;
	}
	const artifact: ProtectedArtifact = {
		path: value.artifact.path,
		protectedAt: value.artifact.protectedAt,
		reason: value.artifact.reason,
		source: value.artifact.source,
	};
	if (typeof value.artifact.validationCommand === "string") {
		artifact.validationCommand = value.artifact.validationCommand;
	}
	if (typeof value.artifact.validationExitCode === "number") {
		artifact.validationExitCode = value.artifact.validationExitCode;
	}
	const context: PendingProtectedArtifactRecord["context"] = {
		parentTurnId: value.context.parentTurnId,
		toolName: value.context.toolName,
	};
	if (typeof value.context.toolCallId === "string") context.toolCallId = value.context.toolCallId;
	if (typeof value.context.runId === "string") context.runId = value.context.runId;
	if (typeof value.context.correlationId === "string") context.correlationId = value.context.correlationId;
	const parsed: PendingProtectedArtifactRecord = {
		version: 1,
		id: value.id,
		sessionId,
		artifact,
		context,
		createdAt: value.createdAt,
		integrity: { algorithm: "sha256", digest: value.integrity.digest },
	};
	return digest(withoutIntegrity(parsed)) === parsed.integrity.digest ? parsed : null;
}

export function stagePendingProtectedArtifact(
	sessionId: string,
	event: ProtectedArtifactProtectEvent,
): PendingProtectedArtifactHandle {
	const id = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
	const without: Omit<PendingProtectedArtifactRecord, "integrity"> = {
		version: 1,
		id,
		sessionId,
		artifact: { ...event.artifact },
		context: {
			parentTurnId: event.turnId ?? null,
			toolName: event.toolName,
			...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
			...(event.runId !== undefined ? { runId: event.runId } : {}),
			...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
		},
		createdAt: new Date().toISOString(),
	};
	const record: PendingProtectedArtifactRecord = {
		...without,
		integrity: { algorithm: "sha256", digest: digest(without) },
	};
	const directory = journalDirectory(sessionId);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${id}.json`);
	atomicWrite(path, JSON.stringify(record, null, 2));
	return { record, path };
}

export function clearPendingProtectedArtifact(handle: PendingProtectedArtifactHandle): void {
	rmSync(handle.path, { force: true });
}

export function readPendingProtectedArtifacts(sessionId: string): PendingProtectedArtifactReadResult {
	const directory = journalDirectory(sessionId);
	if (!existsSync(directory)) return { records: [], errors: [] };
	const records: PendingProtectedArtifactHandle[] = [];
	const errors: PendingProtectedArtifactReadResult["errors"] = [];
	for (const name of readdirSync(directory)
		.filter((entry) => entry.endsWith(".json"))
		.sort()) {
		const path = join(directory, name);
		try {
			const parsed = parseRecord(JSON.parse(readFileSync(path, "utf8")) as unknown, sessionId);
			if (parsed === null) throw new Error("invalid or integrity-mismatched pending protection");
			records.push({ record: parsed, path });
		} catch (error) {
			errors.push({ path, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { records, errors };
}

export function reconcilePendingProtectedArtifacts(session: SessionContract): number {
	const current = session.current();
	if (current === null) return 0;
	const pending = readPendingProtectedArtifacts(current.id);
	if (pending.errors.length > 0) {
		throw new Error(
			`pending protection journal is untrustworthy: ${pending.errors.map((entry) => entry.message).join("; ")}`,
		);
	}
	for (const handle of pending.records) {
		session.appendEntry(
			protectedArtifactEntryFromArtifact(handle.record.artifact, {
				parentTurnId: handle.record.context.parentTurnId,
				toolName: handle.record.context.toolName,
				...(handle.record.context.toolCallId !== undefined ? { toolCallId: handle.record.context.toolCallId } : {}),
				...(handle.record.context.runId !== undefined ? { runId: handle.record.context.runId } : {}),
				...(handle.record.context.correlationId !== undefined
					? { correlationId: handle.record.context.correlationId }
					: {}),
			}),
		);
		if (session.flushAppends === undefined) {
			throw new Error("session does not expose the durable append flush required by protection reconciliation");
		}
		session.flushAppends();
		clearPendingProtectedArtifact(handle);
	}
	return pending.records.length;
}
