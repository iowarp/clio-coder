import { homedir } from "node:os";
import path from "node:path";
import { clioConfigDir, resolveClioDirs } from "../../core/xdg.js";

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
 * Directories under Clio's state and cache roots whose files open a channel to
 * a process running as the operator outside the sandbox. `<state>/gui` holds
 * the desktop app's launch token (`background/server.json`), which answers the
 * app's loopback challenge for a client credential. `<state>/mux/run` and
 * `<cache>/run` are where a pane host puts its control socket when the runtime
 * directory is unusable (mux/workspace/platform-posix.ts). Masked as whole
 * directories, so a later rewrite of a file inside cannot drop the mask, and
 * resolved without creating anything.
 */
export function clioControlPaths(): string[] {
	try {
		const { state, cache } = resolveClioDirs();
		return [path.join(state, "gui"), path.join(state, "mux", "run"), path.join(cache, "run")];
	} catch {
		// An unresolvable state root holds no app state to protect.
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

/**
 * Other agents' logins, tool token stores and shell histories under the home
 * directory. The sandbox masks them and the typed tools refuse them as
 * zero-access entries (default-path-policy.ts spreads this list), so a
 * contained `cat` and a typed `read` agree. Kept apart from the list above
 * because the workspace secret-file scan matches that one by name at any
 * depth, and a project's own `.gemini` is not a credential store.
 */
export const HOME_AGENT_SECRET_RELATIVE_PATHS: ReadonlyArray<string> = [
	".claude/.credentials.json",
	".claude.json",
	".codex/auth.json",
	".gemini",
	".config/github-copilot",
	".cache/huggingface/token",
	".huggingface/token",
	".config/configstore",
	".config/rclone",
	".config/op",
	".config/sops",
	".terraform.d/credentials.tfrc.json",
	".vault-token",
	".pgpass",
	".my.cnf",
	".bash_history",
	".zsh_history",
	".local/share/fish/fish_history",
	".python_history",
	".node_repl_history",
	".psql_history",
	".mysql_history",
];

/** Home-relative secret paths plus Clio's credential store and control directories, all absolute. */
export function workerSecretPaths(home: string = homedir()): string[] {
	const paths = [...HOME_SECRET_RELATIVE_PATHS, ...HOME_AGENT_SECRET_RELATIVE_PATHS].map((relative) =>
		path.join(home, relative),
	);
	return [...new Set([...paths, ...clioCredentialStorePaths(), ...clioControlPaths()])];
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
