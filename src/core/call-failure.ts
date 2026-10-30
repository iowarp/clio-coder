/** Shared, content-free failure evidence for model-call accounting (#430). */
export interface CallFailureRecord {
	invoked: boolean;
	stage: "auth" | "admission" | "transport" | "provider";
	httpStatus: number | null;
	errorClass: string;
	retryAttempts?: number;
}

export interface CallObservation {
	/** Present when the owned call journal already recorded this attempt (#434). */
	callId?: string;
	attemptId?: string;
	callOutcome: "success" | "error" | "aborted";
	failure?: CallFailureRecord;
}

// Only these adapters prove that an absent fetch means no send (#430).
const FETCH_OBSERVED_APIS = new Set(["anthropic-messages", "openai-completions", "openai-responses", "ollama-native"]);

function failureStatus(error: unknown, depth = 0): number | null {
	if (depth > 3) return null;
	if (typeof error === "object" && error !== null) {
		const record = error as Record<string, unknown>;
		for (const key of ["httpStatus", "status", "statusCode", "httpStatusCode"]) {
			const status = record[key];
			if (
				typeof status === "number" &&
				Number.isInteger(status) &&
				status >= 100 &&
				status <= 599 &&
				(status < 200 || status >= 300)
			)
				return status;
		}
		for (const key of ["cause", "$metadata"]) {
			const status = failureStatus(record[key], depth + 1);
			if (status !== null) return status;
		}
	}
	const match = /(?:\bHTTP(?:\s+error)?|\bstatus(?:Code)?|\bUnexpected server response)\s*[:=]?\s*([1-5]\d{2})\b/iu.exec(
		failureText(error),
	);
	const status = match === null ? null : Number(match[1]);
	return status !== null && (status < 200 || status >= 300) ? status : null;
}

function failureText(error: unknown): string {
	if (error instanceof Error) return `${error.name} ${error.message}`;
	if (typeof error === "object" && error !== null && "errorMessage" in error) return String(error.errorMessage);
	return String(error);
}

/** Observe the caller's fetch without replacing provider or caller behavior (#430). */
export function trackCallFetch(fetchImpl: typeof globalThis.fetch = (url, init) => globalThis.fetch(url, init)) {
	let attempts = 0;
	let status: number | null = null;
	let transportError: unknown;
	let unobservedTransportStarted = false;
	const fetch: typeof globalThis.fetch = async (url, init) => {
		const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
		signal?.throwIfAborted();
		attempts += 1;
		status = null;
		transportError = undefined;
		try {
			const response = await fetchImpl(url, init);
			status = response.status;
			return response;
		} catch (error) {
			transportError = error;
			throw error;
		}
	};
	return {
		fetch,
		start(api?: string, transport?: string): void {
			// WebSocket, AWS SDK and plugin transports can send without fetch (#429, #430).
			unobservedTransportStarted =
				!FETCH_OBSERVED_APIS.has(api ?? "") && !(api === "openai-codex-responses" && transport === "sse");
		},
		failure(error: unknown, aborted = false, usageObserved = false): CallFailureRecord {
			return classifyCallFailure(transportError ?? error, {
				invoked: attempts > 0 || usageObserved || unobservedTransportStarted,
				httpStatus: status !== null && (status < 200 || status >= 300) ? status : failureStatus(transportError ?? error),
				retryAttempts: Math.max(0, attempts - 1),
				aborted,
				transportFailed: transportError !== undefined,
			});
		},
	};
}

/** Match known causes, but never persist provider text or arbitrary error names (#430). */
export function classifyCallFailure(
	error: unknown,
	evidence: {
		invoked: boolean;
		httpStatus?: number | null;
		retryAttempts?: number;
		aborted?: boolean;
		transportFailed?: boolean;
	},
): CallFailureRecord {
	const message = failureText(error);
	const httpStatus = evidence.httpStatus ?? null;
	let stage: CallFailureRecord["stage"];
	let errorClass: string;
	if (httpStatus === 401 || httpStatus === 403) {
		stage = "auth";
		errorClass = `http_${httpStatus}`;
	} else if (httpStatus !== null) {
		stage = "provider";
		errorClass = `http_${httpStatus}`;
	} else if (!evidence.invoked && /credential|authentication|api.?key|oauth|token.*expired/iu.test(message)) {
		stage = "auth";
		errorClass = /expir/iu.test(message) ? "credential_expired" : "credential_unavailable";
	} else {
		stage = evidence.invoked ? "transport" : "admission";
		errorClass = /timeout|timed out|deadline/iu.test(message)
			? "timeout"
			: evidence.aborted || /abort/iu.test(message)
				? "aborted"
				: /stream.*(?:drop|end|clos)|terminated|socket|ECONNRESET/iu.test(message)
					? "stream_dropped"
					: evidence.invoked
						? "network_error"
						: "admission_refused";
		if (
			evidence.invoked &&
			!evidence.aborted &&
			!evidence.transportFailed &&
			!/fetch|network|socket|connect|ECONN|stream|abort|timeout|timed out|deadline|terminated/iu.test(message)
		) {
			stage = "provider";
			errorClass = "provider_error";
		}
	}
	return {
		invoked: evidence.invoked,
		stage,
		httpStatus,
		errorClass,
		...(evidence.retryAttempts === undefined ? {} : { retryAttempts: evidence.retryAttempts }),
	};
}

/** Validate optional evidence while retaining the ability to read older rows (#430). */
export function readCallFailure(value: unknown): CallFailureRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.invoked !== "boolean" ||
		(record.stage !== "auth" &&
			record.stage !== "admission" &&
			record.stage !== "transport" &&
			record.stage !== "provider") ||
		(record.httpStatus !== null &&
			!(
				typeof record.httpStatus === "number" &&
				Number.isInteger(record.httpStatus) &&
				record.httpStatus >= 100 &&
				record.httpStatus <= 599
			)) ||
		typeof record.errorClass !== "string" ||
		!/^[a-z][a-z0-9_]{0,63}$/u.test(record.errorClass)
	)
		return undefined;
	return {
		invoked: record.invoked,
		stage: record.stage,
		httpStatus: record.httpStatus as number | null,
		errorClass: record.errorClass,
		...(typeof record.retryAttempts === "number" && Number.isInteger(record.retryAttempts) && record.retryAttempts >= 0
			? { retryAttempts: record.retryAttempts }
			: {}),
	};
}
