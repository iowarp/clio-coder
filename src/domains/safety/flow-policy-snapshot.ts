/**
 * The last approved information-flow section of a workspace's project safety
 * policy, kept beside the trust record. The trust store pins only a hash, so
 * when an unapproved edit changes or deletes a source rule the approved rules
 * would otherwise vanish for files not yet read. The snapshot is written only
 * from a policy whose trust verdict is `trusted`, and it is believed only when
 * the trust record still approves exactly the (path, hash) it names: a
 * standalone JSON file approves nothing by itself.
 *
 * Absent, unreadable and invalid are distinct. A workspace that never
 * approved a flow section has no snapshot and keeps its baseline. A snapshot
 * that exists but cannot be used is a provenance failure the policy engine
 * must refuse on, never a quiet fallback to fewer rules.
 */
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { projectSurfaceTrust, safetySurfaceTrustHash, workspaceTrustDirectory } from "../../core/workspace-trust.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import type { InformationFlowPolicyInput } from "./information-flow.js";

export interface ApprovedFlowPolicy {
	readonly policyHash: string;
	readonly informationFlow: InformationFlowPolicyInput;
}

export type ApprovedFlowPolicyRecall =
	| { readonly kind: "absent" }
	| { readonly kind: "approved"; readonly approved: ApprovedFlowPolicy }
	| { readonly kind: "unavailable"; readonly reason: string };

interface SnapshotRecord {
	version: 1;
	workspaceRoot: string;
	/** Canonical path of the approved safety.yaml, part of the trust digest. */
	policyPath: string;
	policyHash: string;
	informationFlow: InformationFlowPolicyInput;
}

function snapshotPath(canonicalRoot: string): string {
	return join(workspaceTrustDirectory(), `${createHash("sha256").update(canonicalRoot).digest("hex")}.flow.json`);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isFlowInput(value: unknown): value is InformationFlowPolicyInput {
	if (!isRecord(value) || !isRecord(value.groups) || !isRecord(value.targets) || !isRecord(value.mcp)) return false;
	if (!Array.isArray(value.sources)) return false;
	if (!Object.values(value.groups).every(isStringArray)) return false;
	if (!Object.values(value.targets).every((t) => isRecord(t) && typeof t.runtime === "string" && typeof t.endpoint === "string"))
		return false;
	if (
		!Object.values(value.mcp).every(
			(m) =>
				isRecord(m) &&
				typeof m.command === "string" &&
				isStringArray(m.args) &&
				(m.cwd === undefined || typeof m.cwd === "string") &&
				(m.env === undefined || isStringMap(m.env)),
		)
	)
		return false;
	return value.sources.every(
		(rule) =>
			isRecord(rule) &&
			typeof rule.id === "string" &&
			isStringArray(rule.paths) &&
			isStringArray(rule.tools) &&
			isStringArray(rule.recipients),
	);
}

/** The approved snapshot for a workspace: absent, approved by the trust record, or unavailable with the reason. */
export function recallApprovedFlowPolicy(workspaceRoot: string): ApprovedFlowPolicyRecall {
	const root = resolve(workspaceRoot);
	const file = snapshotPath(root);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		return { kind: "unavailable", reason: `approved information-flow snapshot ${file} cannot be read` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { kind: "unavailable", reason: `approved information-flow snapshot ${file} is not valid JSON` };
	}
	if (
		!isRecord(raw) ||
		raw.version !== 1 ||
		raw.workspaceRoot !== root ||
		typeof raw.policyPath !== "string" ||
		typeof raw.policyHash !== "string" ||
		!isFlowInput(raw.informationFlow)
	) {
		return { kind: "unavailable", reason: `approved information-flow snapshot ${file} has an unexpected shape` };
	}
	// The trust record, not this file, says what the operator approved.
	const verdict = projectSurfaceTrust(root, "safety", safetySurfaceTrustHash(raw.policyPath, raw.policyHash));
	if (verdict !== "trusted") {
		return {
			kind: "unavailable",
			reason: `approved information-flow snapshot ${file} names a safety policy the trust record does not approve (${verdict}); re-approve with clio-coder config trust safety`,
		};
	}
	return { kind: "approved", approved: { policyHash: raw.policyHash, informationFlow: raw.informationFlow } };
}

/**
 * Drop the snapshot when an approved policy no longer carries any source rule,
 * so a later unapproved edit cannot resurrect rules the operator removed.
 * Returns the failure reason when a stale snapshot could not be removed.
 */
export function forgetApprovedFlowPolicy(workspaceRoot: string): string | null {
	const file = snapshotPath(resolve(workspaceRoot));
	try {
		unlinkSync(file);
		return null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		return `stale approved information-flow snapshot ${file} could not be removed (${error instanceof Error ? error.message : String(error)})`;
	}
}

/**
 * Record the flow section of a policy the operator approved. Idempotent for
 * the same hash. Returns the failure reason when the snapshot could not be
 * written; the caller must then withhold the durable protection it promises.
 */
export function rememberApprovedFlowPolicy(
	workspaceRoot: string,
	policyPath: string,
	policyHash: string,
	informationFlow: InformationFlowPolicyInput,
): string | null {
	const root = resolve(workspaceRoot);
	const existing = recallApprovedFlowPolicy(root);
	if (existing.kind === "approved" && existing.approved.policyHash === policyHash) return null;
	if (stateRootRemoved()) return "Clio state was removed; the approved information-flow snapshot cannot be written";
	try {
		clioStateDir();
		withStateFileLockSync(snapshotPath(root), () => {
			if (stateRootRemoved()) throw new Error("Clio state was removed");
			const record: SnapshotRecord = { version: 1, workspaceRoot: root, policyPath, policyHash, informationFlow };
			safeResourceWrite(snapshotPath(root), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		});
		return null;
	} catch (error) {
		return `approved information-flow snapshot could not be written (${error instanceof Error ? error.message : String(error)})`;
	}
}
