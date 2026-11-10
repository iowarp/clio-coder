/**
 * Targets a project settings layer pointed at a URL. Such a target never
 * receives the operator's stored or environment credential (review
 * R1-safety-secrets-05): trusting a repository for its rules is not consent to
 * send provider keys wherever its settings say. A loopback URL is no
 * exception for a target that sends a credential, since another user on a
 * shared host can own the port (R2-safety-secrets-17). The layered settings
 * reader records them; auth resolution reads them. Entries accumulate per
 * process, so a host reading several workspaces never forgets one it has seen.
 */
const projectTargets = new Set<string>();

function entryKey(id: string, url: string): string {
	return `${id}\u0000${url}`;
}

export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "[::1]" ||
		host === "0.0.0.0" ||
		/^127(\.\d{1,3}){3}$/u.test(host)
	);
}

export function noteProjectTargets(targets: ReadonlyArray<{ id: string; url?: string }>): void {
	for (const target of targets) {
		const url = target.url?.trim();
		if (url) projectTargets.add(entryKey(target.id, url));
	}
}

/**
 * The URL when this target came from a project layer and the operator's
 * credential must not follow it, else null. Only a loopback URL for a target
 * that sends no credential is exempt.
 */
export function projectChosenTargetUrl(target: { id: string; url?: string }, sendsCredential: boolean): string | null {
	const url = target.url?.trim();
	if (!url || !projectTargets.has(entryKey(target.id, url))) return null;
	return sendsCredential || !isLoopbackUrl(url) ? url : null;
}
