import type { CallFailureRecord } from "./call-failure.js";
import { isProviderAuthRejection } from "./provider-auth-error.js";

const callFailures = new WeakMap<object, CallFailureRecord>();

/** Preserve provider error identity while making HTTP evidence available to recovery (#427). */
export function rememberOAuthCallFailure(error: unknown, failure: CallFailureRecord | undefined): void {
	if (typeof error === "object" && error !== null && failure !== undefined) callFailures.set(error, failure);
}

export interface SideCallAuth {
	apiKey?: string;
	/** Present only for a resolved stored OAuth credential (#427). */
	refreshApiKey?: (rejectedApiKey: string) => Promise<string>;
}

/** Retry only the rejected call, once; each attempt retains its own accounting (#427). */
export async function withOAuthRefresh<T>(
	input: SideCallAuth & { signal?: AbortSignal },
	call: (auth: { apiKey?: string }) => Promise<T>,
): Promise<T> {
	try {
		return await call(input.apiKey === undefined ? {} : { apiKey: input.apiKey });
	} catch (error) {
		const record = error as { status?: unknown } | null;
		const failure = typeof error === "object" && error !== null ? callFailures.get(error) : undefined;
		if (
			input.signal?.aborted ||
			input.apiKey === undefined ||
			input.refreshApiKey === undefined ||
			!isProviderAuthRejection(
				error instanceof Error ? error.message : String(error),
				failure?.httpStatus ?? record?.status,
			)
		)
			throw error;
		const apiKey = await input.refreshApiKey(input.apiKey);
		input.signal?.throwIfAborted();
		return call({ apiKey });
	}
}
