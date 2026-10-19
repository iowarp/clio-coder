import { homedir } from "node:os";
import path from "node:path";
import { clioConfigDir } from "../../core/xdg.js";

/**
 * Absolute path of Clio's provider secret store, when resolvable. The policy
 * engine treats it as zero-access for tool calls, and the worker OS sandbox
 * masks it so a shell command cannot read it either.
 */
export function clioCredentialStorePaths(): string[] {
	try {
		return [path.join(clioConfigDir(), "credentials.yaml")];
	} catch {
		// An unresolvable config root has no credential store to protect.
		return [];
	}
}

/**
 * Well-known operator credential locations under the home directory. The
 * sandbox reads the whole filesystem read-only, so without a mask a worker's
 * shell could still read (and exfiltrate over any allowed channel) these.
 * The list is deliberately conservative: each entry holds keys or tokens and
 * nothing a build or test needs.
 */
export const HOME_SECRET_RELATIVE_PATHS: ReadonlyArray<string> = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker/config.json",
	".netrc",
	".git-credentials",
	".npmrc",
	".pypirc",
	".cargo/credentials",
	".cargo/credentials.toml",
	".config/gh",
	".config/hub",
	".config/gcloud",
	".password-store",
	".local/share/keyrings",
];

/** Home-relative secret paths plus Clio's credential store, all absolute. */
export function workerSecretPaths(home: string = homedir()): string[] {
	const paths = HOME_SECRET_RELATIVE_PATHS.map((relative) => path.join(home, relative));
	return [...new Set([...paths, ...clioCredentialStorePaths()])];
}

/**
 * Secret files a workspace or a scratch root may hold, relative to the root
 * the policy compiles against. The typed tools refuse them as zero-access
 * entries (default-path-policy.ts spreads this list), and the shell sandbox
 * masks the files matching one of them by name at any depth
 * (core/sandbox/secret-files.ts), so a contained `cat .env` and a typed
 * `read .env` agree. A trailing slash marks a directory; `*` matches within
 * one path segment.
 */
export const WORKSPACE_SECRET_PATHS: ReadonlyArray<string> = [
	".env",
	".env.local",
	".env.development",
	".env.production",
	".env.staging",
	".env.test",
	".env.*.local",
	"*.env",
	"*-credentials.json",
	"*serviceAccount*.json",
	"*service-account*.json",
	"kubeconfig",
	"*-secret.yaml",
	"secrets.yaml",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"*.tfstate",
	"*.tfstate.backup",
	".terraform/",
	".vercel/",
	".netlify/",
	"firebase-adminsdk*.json",
	"serviceAccountKey.json",
	".supabase/",
	".git-credentials",
	".netrc",
	".pypirc",
	"credentials.json",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	// Kerberos ticket caches land in /tmp, a scratch root the main-session sandbox can read.
	"krb5cc_*",
	// Clio's own provider secret store. The literal covers a repo-level file
	// of the same name on purpose; the expanded clioConfigDir() form is
	// appended at policy construction (policy-engine.ts), since this static
	// list cannot call config helpers.
	"credentials.yaml",
	"dump.sql",
	"backup.sql",
	"*.dump",
];
