import {
	DISPATCH_INTENT_TIMEOUT_MIN_MS,
	type DispatchIntentCheckBound,
	type DispatchIntentVerification,
	normalizeIntentExpectedOutputs,
	normalizeIntentVerification,
} from "../dispatch/intent.js";

export interface UserTaskAcceptance {
	expectedOutputs: string[];
	verification: DispatchIntentVerification[];
}

/** Validate stored acceptance without consulting a catalog that may have changed. */
export function normalizeUserTaskAcceptance(raw: unknown): UserTaskAcceptance {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("acceptance must be an object");
	}
	const value = raw as Record<string, unknown>;
	if (Object.keys(value).some((key) => key !== "expectedOutputs" && key !== "verification")) {
		throw new Error("acceptance contains an unknown field");
	}
	if (!Array.isArray(value.expectedOutputs) || !Array.isArray(value.verification)) {
		throw new Error("acceptance requires expectedOutputs and verification arrays");
	}
	const checks = new Map<string, DispatchIntentCheckBound>();
	const rawVerification = value.verification.map((entry: unknown) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error("acceptance verification must contain check and timeoutMs");
		}
		const item = entry as Record<string, unknown>;
		if (Object.keys(item).some((key) => key !== "check" && key !== "timeoutMs")) {
			throw new Error("acceptance verification contains an unknown field");
		}
		if (
			typeof item.check !== "string" ||
			typeof item.timeoutMs !== "number" ||
			!Number.isSafeInteger(item.timeoutMs) ||
			item.timeoutMs <= 0
		) {
			throw new Error("acceptance verification requires a check and a positive integer timeoutMs");
		}
		checks.set(item.check.trim(), {
			id: item.check.trim(),
			timeoutMs: Math.max(DISPATCH_INTENT_TIMEOUT_MIN_MS, item.timeoutMs, checks.get(item.check.trim())?.timeoutMs ?? 0),
		});
		return { check: item.check, timeout_ms: item.timeoutMs };
	});
	const expectedOutputs = normalizeIntentExpectedOutputs(value.expectedOutputs);
	if (!Array.isArray(expectedOutputs))
		throw new Error(expectedOutputs.ok ? "invalid acceptance outputs" : expectedOutputs.message);
	const verification = normalizeIntentVerification(rawVerification, checks);
	if (!Array.isArray(verification))
		throw new Error(verification.ok ? "invalid acceptance verification" : verification.message);
	return { expectedOutputs, verification };
}
