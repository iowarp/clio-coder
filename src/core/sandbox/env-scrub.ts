import { holdsCredentialShape } from "../secret-shapes.js";
import type { SandboxEnvPolicy } from "./types.js";

/**
 * The environment a sandboxed command inherits, without credentials. A
 * contained main-session command reaches the network and runs without any
 * judgment, so a token in its environment could leave the host unseen; a
 * worker's sandboxed command is in the same position whenever its run holds
 * network. The scrub runs on the environment handed to the sandbox
 * executable itself: bubblewrap's `--unsetenv` only edits the copy it execs,
 * and its init process inside the PID namespace keeps the original in
 * `/proc/1/environ`. Commands that leave the sandbox (`unsandboxed: true`
 * after the judge, and yolo) keep the environment they had.
 */

/** Name fragments that mark a credential anywhere in a variable name. `TOKENIZER` is text tokenization, not a token. */
const SECRET_NAME_FRAGMENT =
	/TOKEN(?!IZ)|SECRET|PASSWORD|PASSWD|PASSPHRASE|ASKPASS|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|SESSION_?KEY|COOKIE|CONNECTION_?STRING/u;

/** A final name part that holds a credential (`STRIPE_KEY`, `SMTP_PASS`, `MYSQL_PWD`, `GITHUB_PAT`). */
const SECRET_LAST_PART = new Set(["KEY", "KEYS", "PASS", "PWD", "PAT"]);

/** Whole families of credential configuration; their non-secret members are listed in {@link KEPT_NAMES}. */
const SECRET_PREFIXES = ["AWS_", "PYPI_", "TWINE_", "VAULT_"] as const;

/** Variables inside a secret family that only select a region or a profile. */
const KEPT_NAMES = new Set(["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"]);

/**
 * Credentials a client reads from its environment by a name no fragment above marks: a scheduler or CI JWT (`SLURM_JWT`,
 * `CI_JOB_JWT`) and header sets (`ANTHROPIC_CUSTOM_HEADERS`, `OTEL_EXPORTER_OTLP_HEADERS`). Only the sandbox drops them:
 * scheduler clients run outside it and a Slurm site using JWT auth needs `SLURM_JWT` there.
 */
const SANDBOX_SECRET_NAME_FRAGMENT = /JWT|HEADERS|WEBHOOK/u;

/** Credential locations or channels whose names match no fragment. */
const SECRET_NAMES = new Set(["KUBECONFIG", "NETRC", "BW_SESSION"]);

/** `scheme://user:password@`, the user possibly empty (`redis://:pw@host`). */
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/iu;
/** `scheme://TOKEN@`, a token as the whole username: a git host token, or a long opaque run holding a digit. */
const URL_TOKEN_USER =
	/[a-z][a-z0-9+.-]*:\/\/(?:(?:gh[pousr]_|github_pat_|glpat-)[a-z0-9_-]{8,}|(?=[a-z0-9_-]*\d)[a-z0-9_-]{20,})@/iu;
/** A connection string carrying a password or a storage key (`Server=...;Password=...`). */
const CONNECTION_STRING_SECRET = /(?:^|;)\s*(?:password|pwd|accountkey|sharedaccesskey)\s*=/iu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

/**
 * `AUTH` as a word part (`DOCKER_AUTH_CONFIG`, `NPM_CONFIG__AUTH`, `OAUTH_ID`),
 * but not an author (`GIT_AUTHOR_NAME`); `AUTHORIZATION` is still a credential.
 */
function authPart(part: string): boolean {
	return part.includes("AUTH") && !/^AUTHOR(?!IZ)/u.test(part);
}

/** Pure: whether a variable name marks a credential. Case-insensitive. */
function isSandboxSecretEnvName(name: string): boolean {
	const upper = name.toUpperCase();
	if (KEPT_NAMES.has(upper)) return false;
	if (SECRET_NAMES.has(upper) || SECRET_NAME_FRAGMENT.test(upper)) return true;
	if (SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
	const parts = upper.split("_").filter((part) => part.length > 0);
	if (parts.some(authPart)) return true;
	const last = parts.at(-1);
	return parts.length > 1 && last !== undefined && SECRET_LAST_PART.has(last);
}

/** Pure: whether a value carries a credential whatever its variable is named. */
function isSandboxSecretEnvValue(value: string): boolean {
	return (
		URL_CREDENTIALS.test(value) ||
		URL_TOKEN_USER.test(value) ||
		CONNECTION_STRING_SECRET.test(value) ||
		PRIVATE_KEY_BLOCK.test(value) ||
		holdsCredentialShape(value)
	);
}

/** Pure: whether the sandbox scrub drops a variable by its name, which reaches past {@link isSandboxSecretEnvName}. */
function isSandboxScrubbedEnvName(name: string): boolean {
	return isSandboxSecretEnvName(name) || SANDBOX_SECRET_NAME_FRAGMENT.test(name.toUpperCase());
}

/**
 * Pure: `env` without its credential variables. A name in `passEnv` is kept
 * from `source` (the unfiltered environment the caller built `env` from)
 * when `env` lacks it, so the operator's escape hatch also reaches names an
 * earlier filter dropped. `removed` lists names only, never values.
 */
export function scrubSandboxEnv(
	env: NodeJS.ProcessEnv,
	policy: SandboxEnvPolicy,
	source: NodeJS.ProcessEnv = env,
): { env: NodeJS.ProcessEnv; removed: string[] } {
	const pass = new Set(policy.passEnv);
	const named = new Set(policy.secretNames);
	const out: NodeJS.ProcessEnv = {};
	const removed: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (!pass.has(key) && (named.has(key) || isSandboxScrubbedEnvName(key) || isSandboxSecretEnvValue(value))) {
			removed.push(key);
			continue;
		}
		out[key] = value;
	}
	for (const key of pass) {
		const value = source[key];
		if (out[key] === undefined && value !== undefined) out[key] = value;
	}
	return { env: out, removed };
}

/** Credentials Clio resolved in this process (stored keys, OAuth tokens, overrides), which no variable name marks. */
const resolvedSecrets = new Set<string>();

/** Record a credential Clio resolved, so a command that prints it has it masked in its captured output. */
export function rememberResolvedSecret(value: string | undefined): void {
	const trimmed = value?.trim();
	if (trimmed) resolvedSecrets.add(trimmed);
}

/** A credential-named variable that holds a path or a plain URL (`KUBECONFIG`, `SSH_AUTH_SOCK`, `VAULT_ADDR`) says where a secret lives. */
const LOCATOR_VALUE = /^(?:~?[\\/]|[A-Za-z]:[\\/]|[a-z][a-z0-9+.-]*:\/\/)/iu;

/**
 * Pure: whether a credential-named variable holds the credential itself rather than where one lives. An unsandboxed
 * command's environment drops these by the same name rule the sandbox scrub uses, so a bare `FOO_KEY`, `GH_PAT` or
 * `PASSWD` never reaches it, while `KUBECONFIG=~/.kube/config` or a credential-free `VAULT_ADDR` still does.
 */
export function holdsNamedCredential(name: string, value: string | undefined): boolean {
	if (!isSandboxSecretEnvName(name)) return false;
	const trimmed = value?.trim() ?? "";
	return !LOCATOR_VALUE.test(trimmed) || URL_CREDENTIALS.test(trimmed);
}

/**
 * The credential values a command's output must not show: every value the
 * scrub above would hide from a sandbox, judged by the same name and value
 * rules, and every credential Clio resolved. A path or credential-free URL
 * under a credential name is left out, because masking it only mangles output.
 */
export function knownSecretValues(env: NodeJS.ProcessEnv, secretNames: Iterable<string> = []): string[] {
	const named = new Set(secretNames);
	const values = new Set(resolvedSecrets);
	for (const [key, raw] of Object.entries(env)) {
		const value = raw?.trim();
		if (!value) continue;
		if (isSandboxSecretEnvValue(value)) values.add(value);
		else if ((named.has(key) || isSandboxScrubbedEnvName(key)) && !LOCATOR_VALUE.test(value)) values.add(value);
	}
	return [...values];
}

/** The scrub's inputs from settings: the operator's pass list and the variables Clio's targets read keys from. */
export function sandboxEnvPolicy(settings: {
	safety: { sandboxPassEnv: ReadonlyArray<string> };
	targets: ReadonlyArray<{ auth?: { apiKeyEnvVar?: string; headers?: Readonly<Record<string, string>> } }>;
}): SandboxEnvPolicy {
	const secretNames = settings.targets.flatMap((target) => {
		const name = target.auth?.apiKeyEnvVar?.trim();
		return name === undefined || name.length === 0 ? [] : [name];
	});
	const maskSettings = settings.targets.some((target) => Object.keys(target.auth?.headers ?? {}).length > 0);
	return {
		passEnv: [...settings.safety.sandboxPassEnv],
		secretNames: [...new Set(secretNames)],
		...(maskSettings ? { maskSettings: true as const } : {}),
	};
}
