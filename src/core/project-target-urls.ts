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
/** The key variable a trusted project named for one of its own target URLs (`auth.apiKeyEnvVar`). */
const projectKeyVariables = new Map<string, string>();

function entryKey(id: string, url: string): string {
	return `${id}\u0000${url}`;
}

/** A name a project may give for its target's key: an environment variable name, never a value. */
export function isProjectKeyVariableName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name);
}

/**
 * The one sentence every surface prints for a target whose key variable is unset: run, the TUI and doctor. With
 * `projectFile`, the project settings file that declares the target, it also names the two fixes: the shell, or
 * that file's `auth.apiKeyEnvVar`, since `clio-coder configure` edits only the user's settings.
 */
export function unsetKeyVariableSentence(targetId: string, variable: string, projectFile?: string): string {
	const unset = `target ${targetId} reads its key from $${variable}, which is not set in this shell`;
	return projectFile === undefined
		? `${unset}.`
		: `${unset}; set it with \`export ${variable}=<key>\`, or fix auth.apiKeyEnvVar on target ${targetId} in ${projectFile}.`;
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

export function noteProjectTargets(
	targets: ReadonlyArray<{ id: string; url?: string; auth?: { apiKeyEnvVar?: string } }>,
): void {
	for (const target of targets) {
		const url = target.url?.trim();
		if (!url) continue;
		projectTargets.add(entryKey(target.id, url));
		const variable = target.auth?.apiKeyEnvVar?.trim();
		if (variable && isProjectKeyVariableName(variable)) projectKeyVariables.set(entryKey(target.id, url), variable);
		else projectKeyVariables.delete(entryKey(target.id, url));
	}
}

/**
 * The variable a trusted project named for this target's URL, when the target still names it: the one credential
 * Clio sends to an address a project chose, because the trust card said "sends $NAME to <url>". Else null.
 */
export function projectTargetKeyVariable(target: {
	id: string;
	url?: string;
	auth?: { apiKeyEnvVar?: string };
}): string | null {
	const url = target.url?.trim();
	if (!url) return null;
	const variable = projectKeyVariables.get(entryKey(target.id, url));
	return variable !== undefined && target.auth?.apiKeyEnvVar?.trim() === variable ? variable : null;
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
