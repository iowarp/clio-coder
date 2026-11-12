import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
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

let configSecretCache: { signature: string; paths: string[] } | null = null;

function fileSignature(file: string): string {
	try {
		const stat = statSync(file);
		return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "-";
	}
}

/** Entries of a YAML list, or the values of a YAML map, under `key`; a malformed file still names its entries. */
function yamlEntries(document: unknown, key: string): unknown[] {
	if (document === null || typeof document !== "object") return [];
	const value = (document as Record<string, unknown>)[key];
	if (Array.isArray(value)) return value;
	return value !== null && typeof value === "object" ? Object.values(value) : [];
}

function nonEmptyMap(value: unknown): boolean {
	return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

/**
 * Whether a config file holds a secret by the rule given, read from disk. A file YAML cannot parse counts when its
 * text names the field, so a broken file is not readable just for being broken.
 */
function configFileHoldsSecret(file: string, field: RegExp, holds: (document: unknown) => boolean): boolean {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return false;
	}
	try {
		return holds(parseYaml(text));
	} catch {
		return field.test(text);
	}
}

/**
 * Clio's config files that hold a secret now, as zero-access path entries, by the rules the sandbox masks them on:
 * settings.yaml and the copies beside it (`settingsFileMasks()`) when a target authenticates with `auth.headers`,
 * and mcp.yaml when a server declares an `env` map, the one place a user-scope server's token goes. Otherwise both
 * stay readable. Two stat calls per use; the files are read again only when one changes.
 */
export function clioConfigSecretPaths(): string[] {
	let config: string;
	try {
		config = clioConfigDir();
	} catch {
		return [];
	}
	const settings = path.join(config, "settings.yaml");
	const mcp = path.join(config, "mcp.yaml");
	const signature = `${config}|${fileSignature(settings)}|${fileSignature(mcp)}`;
	if (configSecretCache?.signature === signature) return configSecretCache.paths;
	const paths: string[] = [];
	const headers = (document: unknown) =>
		yamlEntries(document, "targets").some((target) =>
			nonEmptyMap((target as { auth?: { headers?: unknown } } | null)?.auth?.headers),
		);
	if (configFileHoldsSecret(settings, /\bheaders\s*:/u, headers)) {
		paths.push(path.join(config, "settings.yaml*"), path.join(config, ".settings.yaml.tmp-*"));
	}
	const env = (document: unknown) =>
		yamlEntries(document, "servers").some((server) => nonEmptyMap((server as { env?: unknown } | null)?.env));
	if (configFileHoldsSecret(mcp, /\benv\s*:/u, env)) paths.push(mcp);
	configSecretCache = { signature, paths };
	return paths;
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
