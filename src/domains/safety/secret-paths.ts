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
 * The files that hold a secret now, as zero-access path entries, by the rules the sandbox masks them on: Clio's
 * settings.yaml and the copies beside it (`settingsFileMasks()`) when a target authenticates with `auth.headers`,
 * mcp.yaml when a server declares an `env` map, the one place a user-scope server's token goes, and the build-tool
 * settings `buildToolSecretPaths()` names. Otherwise all stay readable. A stat call per file and use; the files are
 * read again only when one changes.
 */
export function conditionalSecretPaths(): string[] {
	let config: string | null;
	try {
		config = clioConfigDir();
	} catch {
		config = null;
	}
	const home = homedir();
	const settings = config === null ? null : path.join(config, "settings.yaml");
	const mcp = config === null ? null : path.join(config, "mcp.yaml");
	const watched = [settings, mcp, ...BUILD_TOOL_CREDENTIAL_FILES.map(({ relative }) => path.join(home, relative))];
	const signature = `${config}|${home}|${watched.map((file) => (file === null ? "-" : fileSignature(file))).join("|")}`;
	if (configSecretCache?.signature === signature) return configSecretCache.paths;
	const paths: string[] = [];
	if (settings !== null && mcp !== null) {
		const headers = (document: unknown) =>
			yamlEntries(document, "targets").some((target) =>
				nonEmptyMap((target as { auth?: { headers?: unknown } } | null)?.auth?.headers),
			);
		if (configFileHoldsSecret(settings, /\bheaders\s*:/u, headers)) {
			paths.push(path.join(config as string, "settings.yaml*"), path.join(config as string, ".settings.yaml.tmp-*"));
		}
		const env = (document: unknown) =>
			yamlEntries(document, "servers").some((server) => nonEmptyMap((server as { env?: unknown } | null)?.env));
		if (configFileHoldsSecret(mcp, /\benv\s*:/u, env)) paths.push(mcp);
	}
	paths.push(...buildToolSecretPaths(home));
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
	// Local services listening on loopback: a Jupyter kernel's connection file (ports and HMAC key) or a server's
	// token, the ipyparallel controller keys and the code-server password each let a holder run code as the operator.
	".local/share/jupyter/runtime",
	".jupyter",
	".ipython/profile_default/security",
	".config/code-server",
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
	// Browser profiles (session cookies, saved logins and their key), including the snap and flatpak Firefox and
	// Chromium-family installs. Playwright, Puppeteer and Selenium launch on a temporary profile and never read these.
	".mozilla",
	"snap/firefox/common/.mozilla",
	".var/app/org.mozilla.firefox/.mozilla",
	".config/google-chrome",
	".config/chromium",
	"snap/chromium/common/chromium",
	".config/BraveSoftware",
	".config/microsoft-edge",
	// Editor secret stores: extension logins and tokens live in globalStorage's state database.
	".config/Code/User/globalStorage",
	".vscode-server/data/User/globalStorage",
	".gem/credentials",
	".config/glab-cli",
	".oci",
	".config/doctl",
	".s3cfg",
	".boto",
	".config/containers/auth.json",
	".config/litellm",
	".wakatime.cfg",
	".m2/settings-security.xml",
	".copilot/config.json",
	".local/share/opencode/auth.json",
	".aider.conf.yml",
	".continue/config.yaml",
	".continue/config.json",
	".qwen/oauth_creds.json",
	".factory",
	".local/share/amp/secrets.json",
	".grok/user-settings.json",
	".mcp-auth",
	// The API key of syncthing's loopback GUI, and the key ollama signs registry pushes with.
	".config/syncthing/config.xml",
	".ollama/id_ed25519",
];

/**
 * Build-tool settings every Maven, Gradle or pip run reads, for a mirror, a proxy or a repository, so they are
 * masked only while they hold a credential: a Maven server `<password>`, `<passphrase>` or `<privateKey>`, a Gradle
 * property whose name says password, secret, token, key or credentials, a pip index URL with a user part.
 */
const BUILD_TOOL_CREDENTIAL_FILES: ReadonlyArray<{ relative: string; holds: RegExp }> = [
	{ relative: ".m2/settings.xml", holds: /<(?:password|passphrase|privateKey)>\s*[^<\s]/iu },
	{
		relative: ".gradle/gradle.properties",
		holds:
			/^[ \t]*[^#!\s=:][^=:\n]*?(?:password|passwd|secret|token|api[._-]?key|credentials?|signing\.?key)[^=:\n]*[=:][ \t]*\S/imu,
	},
	{ relative: ".config/pip/pip.conf", holds: /:\/\/[^\s/@]+@/u },
	{ relative: ".pip/pip.conf", holds: /:\/\/[^\s/@]+@/u },
];

/** The build-tool settings files under `home` that hold a credential now, absolute. */
export function buildToolSecretPaths(home: string = homedir()): string[] {
	const paths: string[] = [];
	for (const { relative, holds } of BUILD_TOOL_CREDENTIAL_FILES) {
		const file = path.join(home, relative);
		try {
			if (holds.test(readFileSync(file, "utf8"))) paths.push(file);
		} catch {}
	}
	return paths;
}

/** Home-relative secret paths plus Clio's credential store and control directories, all absolute. */
export function workerSecretPaths(home: string = homedir()): string[] {
	const paths = [...HOME_SECRET_RELATIVE_PATHS, ...HOME_AGENT_SECRET_RELATIVE_PATHS].map((relative) =>
		path.join(home, relative),
	);
	return [...new Set([...paths, ...buildToolSecretPaths(home), ...clioCredentialStorePaths(), ...clioControlPaths()])];
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
