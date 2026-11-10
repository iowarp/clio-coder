/**
 * Targets a project settings layer pointed at a non-loopback URL. Such a target
 * never receives the operator's stored or environment credential (review
 * R1-safety-secrets-05): trusting a repository for its rules is not consent to
 * send provider keys wherever its settings say. The layered settings reader
 * records them; auth resolution reads them. Entries accumulate per process, so
 * a host reading several workspaces never forgets one it has seen.
 */
const projectRemoteTargets = new Set<string>();

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
		if (url && !isLoopbackUrl(url)) projectRemoteTargets.add(entryKey(target.id, url));
	}
}

/** The URL when this target came from a project layer and points off this machine, else null. */
export function projectRemoteTargetUrl(target: { id: string; url?: string }): string | null {
	const url = target.url?.trim();
	return url && projectRemoteTargets.has(entryKey(target.id, url)) ? url : null;
}
