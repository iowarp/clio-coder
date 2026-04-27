export interface NativeRuntimeFingerprint {
	runtimeId: "lmstudio-native" | "ollama-native";
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
 * matching runtime id when LM Studio (`/api/v0/models`) or Ollama
 * (`/api/version`) responds, null otherwise. Used by doctor + configure
 * wizard to steer users onto native runtimes for resident-model lifecycle.
 */
export async function fingerprintNativeRuntime(baseUrl: string): Promise<NativeRuntimeFingerprint | null> {
	const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	const lmStudio = await fetchWithTimeout(`${trimmed}/api/v0/models`, 750);
	if (lmStudio?.ok) return { runtimeId: "lmstudio-native", displayName: "LM Studio" };
	const ollama = await fetchWithTimeout(`${trimmed}/api/version`, 750);
	if (ollama?.ok) {
		try {
			const data = (await ollama.json()) as { version?: unknown };
			if (typeof data.version === "string") {
				return { runtimeId: "ollama-native", displayName: "Ollama" };
			}
		} catch {}
	}
	return null;
}
