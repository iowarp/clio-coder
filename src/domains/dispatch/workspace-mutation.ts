import type { MiddlewareHookInput } from "../middleware/types.js";
import { isLegacyReadOnlyReceipt } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasChangedPaths(value: unknown): boolean {
	return Array.isArray(value) && value.some((path) => typeof path === "string" && path.length > 0);
}

/** A sealed dispatch result can move the parent's files even when the worker failed. */
export function dispatchMutatedParentWorkspace(details: MiddlewareHookInput["toolResultDetails"]): boolean {
	if (!Array.isArray(details?.runs)) return false;
	return details.runs.some((value: unknown) => {
		if (!isRecord(value) || !isRecord(value.receiptIntegrity) || value.receiptIntegrity.ok !== true) return false;
		if (value.readOnly === true || isLegacyReadOnlyReceipt(value)) return false;
		const mutatingSucceeded = isRecord(value.toolActivity) && value.toolActivity.mutatingSucceeded === true;
		const placement = value.placement;
		if (placement === undefined) return mutatingSucceeded;
		if (!isRecord(placement)) return false;
		if (placement.mode === "worktree") return placement.applied === true && hasChangedPaths(placement.changedPaths);
		if (placement.mode === "current") {
			// A checkout delta is stronger evidence than a mutating-capable call.
			// When observed, an empty delta means the parent files did not change.
			return Array.isArray(placement.changedPaths) ? hasChangedPaths(placement.changedPaths) : mutatingSucceeded;
		}
		return false;
	});
}
