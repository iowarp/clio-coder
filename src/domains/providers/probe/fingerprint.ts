export interface NativeRuntimeFingerprint {
	runtimeId: "lmstudio" | "ollama-native";
	displayName: string;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { signal: controller.signal });
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probes a URL for known native local-server fingerprints. Returns the
 * matching runtime id when LM Studio (`/api/v1/models`, falling back to
 * `/api/v0/models`) or Ollama (`/api/version`) responds, null otherwise. Used
 * by doctor + configure wizard to steer users onto native runtimes for
 * resident-model lifecycle.
 */
export async function fingerprintNativeRuntime(baseUrl: string): Promise<NativeRuntimeFingerprint | null> {
	const normalized = baseUrl.replace(/^ws:/u, "http:").replace(/^wss:/u, "https:");
	const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	const greeting = await fetchWithTimeout(`${trimmed}/lmstudio-greeting`, 750);
	if (greeting?.ok) {
		try {
			const data = (await greeting.json()) as { lmstudio?: unknown };
			if (data.lmstudio === true) return { runtimeId: "lmstudio", displayName: "LM Studio" };
		} catch {
			// The exact JSON body is the fingerprint.
		}
	}
	const lmStudioV0 = await fetchWithTimeout(`${trimmed}/api/v0/models`, 750);
	if (lmStudioV0?.ok) {
		try {
			const data = (await lmStudioV0.json()) as { data?: unknown };
			if (
				Array.isArray(data.data) &&
				data.data.some((entry) => typeof entry === "object" && entry !== null && "compatibility_type" in entry)
			) {
				return { runtimeId: "lmstudio", displayName: "LM Studio" };
			}
		} catch {
			// A malformed v0 body is not an LM Studio fingerprint.
		}
	}
	const ollama = await fetchWithTimeout(`${trimmed}/api/version`, 750);
	if (ollama?.ok) {
		try {
			const data = (await ollama.json()) as { version?: unknown };
			if (typeof data.version === "string") {
				return { runtimeId: "ollama-native", displayName: "Ollama" };
			}
		} catch {
			// A reachable endpoint with a non-JSON version reply fingerprints as
			// unknown; the caller treats null as "no native runtime detected".
		}
	}
	return null;
}
