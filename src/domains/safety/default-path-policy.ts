import { foreignAgentDirs } from "../interop/registry.js";
import type { PathPolicyInput } from "./path-policy.js";

/**
 * Source-level damage-control path defaults adapted from the reference
 * extension. These apply even when a project has no `.clio-coder/safety.yaml`, so the
 * agent has a useful safety net out of the box. Project policy can add more
 * paths, or disable these defaults entirely when a local repo intentionally
 * needs a looser profile.
 */
export const DEFAULT_DAMAGE_CONTROL_PATH_POLICY: PathPolicyInput = {
	zeroAccessPaths: [
		".env",
		".env.local",
		".env.development",
		".env.production",
		".env.staging",
		".env.test",
		".env.*.local",
		"*.env",
		"~/.ssh/",
		"~/.gnupg/",
		"~/.aws/",
		"~/.config/gcloud/",
		"*-credentials.json",
		"*serviceAccount*.json",
		"*service-account*.json",
		"~/.azure/",
		"~/.kube/",
		"kubeconfig",
		"*-secret.yaml",
		"secrets.yaml",
		"~/.docker/",
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
		"~/.netrc",
		"~/.npmrc",
		"~/.pypirc",
		"~/.git-credentials",
		".git-credentials",
		// Remote URLs in the repo git config can embed access tokens, and .git
		// is hidden from grep/find but not from direct reads without this entry.
		".git/config",
		// Clio's own provider secret store. The literal covers a repo-level file
		// of the same name on purpose; the expanded clioConfigDir() form is
		// appended at policy construction (policy-engine.ts), since this static
		// list cannot call config helpers.
		"credentials.yaml",
		"dump.sql",
		"backup.sql",
		"*.dump",
	],
	readOnlyPaths: [
		// Clio's own operator-authority files in the project. `safety.yaml` is the
		// policy that gates the model's tools, and `verifiers.yaml` is an argv
		// catalog that verify() executes; a model that can author either one can
		// widen its own permissions in two tool calls. Both are authored by the
		// operator through the CLI (`clio-coder verifiers author` lands nothing
		// before `--yes`), so model-side writes and deletes are refused.
		".clio-coder/safety.yaml",
		".clio-coder/verifiers.yaml",
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
