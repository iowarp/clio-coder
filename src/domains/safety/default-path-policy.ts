import { foreignAgentDirs } from "../interop/registry.js";
import type { PathPolicyInput } from "./path-policy.js";
import { WORKSPACE_SECRET_PATHS } from "./secret-paths.js";

/**
 * Generated trees the default policy keeps out of hand edits. The operator's
 * yolo may delete them (#419); a write into one stays refused at every level.
 */
export const BUILD_OUTPUT_PATHS: ReadonlyArray<string> = [
	"dist/",
	"build/",
	".next/",
	".nuxt/",
	".output/",
	"node_modules/",
	"__pycache__/",
	".venv/",
	"venv/",
	"target/",
];

/**
 * Source-level damage-control path defaults adapted from the reference
 * extension. These apply even when a project has no `.clio-coder/safety.yaml`, so the
 * agent has a useful safety net out of the box. Project policy can add more
 * paths, or disable these defaults entirely when a local repo intentionally
 * needs a looser profile.
 */
export const DEFAULT_DAMAGE_CONTROL_PATH_POLICY: PathPolicyInput = {
	zeroAccessPaths: [
		...WORKSPACE_SECRET_PATHS,
		"~/.ssh/",
		"~/.gnupg/",
		"~/.aws/",
		"~/.config/gcloud/",
		"~/.azure/",
		"~/.kube/",
		"~/.docker/",
		"~/.netrc",
		"~/.npmrc",
		"~/.pypirc",
		"~/.git-credentials",
		// Remote URLs in the repo git config can embed access tokens, and .git
		// is hidden from grep/find but not from direct reads without this entry.
		// The shell sandbox keeps it readable and read-only, since git needs it.
		".git/config",
	],
	readOnlyPaths: [
		// Clio's own operator-authority files in the project. `safety.yaml` is the
		// policy that gates the model's tools, and `verifiers.yaml` is an argv
		// catalog that verify() executes; a model that can author either one can
		// widen its own permissions in two tool calls. Both are authored by the
		// operator through the CLI (`clio-coder verifiers author` lands nothing
		// before `--yes`), so model-side writes and deletes are refused.
		// Skills also refuse model-side writes and deletes; installs go through `clio-coder library install`.
		".clio-coder/safety.yaml",
		".clio-coder/verifiers.yaml",
		".clio-coder/skills/",
		".clio-coder/plugins/",
		".clio-coder/extensions/",
		"/etc/",
		"/usr/",
		"/bin/",
		"/sbin/",
		"/boot/",
		"/root/",
		"~/.bash_history",
		"~/.zsh_history",
		"~/.node_repl_history",
		"~/.bashrc",
		"~/.zshrc",
		"~/.profile",
		"~/.bash_profile",
		"*.min.js",
		"*.min.css",
		"*.bundle.js",
		"*.chunk.js",
		...BUILD_OUTPUT_PATHS,
	],
	// Another agent's own configuration. Clio reads these roots for skills,
	// prompts, and rule prose and has no reason to author them, so the guard is
	// on writes and not only on deletes.
	noWritePaths: [...foreignAgentDirs()],
	noDeletePaths: [
		"~/.claude/",
		"CLAUDE.md",
		"LICENSE",
		"LICENSE.*",
		"COPYING",
		"COPYING.*",
		"NOTICE",
		"PATENTS",
		"README.md",
		"README.*",
	],
};

export function mergePathPolicyInputs(base: PathPolicyInput, override: PathPolicyInput): PathPolicyInput {
	return {
		zeroAccessPaths: [...(base.zeroAccessPaths ?? []), ...(override.zeroAccessPaths ?? [])],
		readOnlyPaths: [...(base.readOnlyPaths ?? []), ...(override.readOnlyPaths ?? [])],
		noWritePaths: [...(base.noWritePaths ?? []), ...(override.noWritePaths ?? [])],
		noDeletePaths: [...(base.noDeletePaths ?? []), ...(override.noDeletePaths ?? [])],
	};
}

/** Operator and host authority survives every project-local exemption. */
export const OPERATOR_PATH_POLICY: PathPolicyInput = {
	zeroAccessPaths: DEFAULT_DAMAGE_CONTROL_PATH_POLICY.zeroAccessPaths?.filter((entry) => entry.startsWith("~/")) ?? [],
	readOnlyPaths:
		DEFAULT_DAMAGE_CONTROL_PATH_POLICY.readOnlyPaths?.filter(
			(entry) => entry.startsWith("~/") || entry.startsWith("/") || entry.startsWith(".clio-coder/"),
		) ?? [],
	noWritePaths: DEFAULT_DAMAGE_CONTROL_PATH_POLICY.noWritePaths ?? [],
	noDeletePaths: DEFAULT_DAMAGE_CONTROL_PATH_POLICY.noDeletePaths?.filter((entry) => entry.startsWith("~/")) ?? [],
};
