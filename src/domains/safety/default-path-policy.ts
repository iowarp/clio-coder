import type { PathPolicyInput } from "./path-policy.js";

/**
 * Source-level damage-control path defaults adapted from the reference
 * extension. These apply even when a project has no `.clio/safety.yaml`, so the
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
		"dump.sql",
		"backup.sql",
		"*.dump",
	],
	readOnlyPaths: [
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
	noDeletePaths: ["~/.claude/", "CLAUDE.md", "LICENSE", "LICENSE.*", "COPYING", "COPYING.*", "NOTICE", "PATENTS", "README.md", "README.*"],
};

export function mergePathPolicyInputs(base: PathPolicyInput, override: PathPolicyInput): PathPolicyInput {
	return {
		zeroAccessPaths: [...(base.zeroAccessPaths ?? []), ...(override.zeroAccessPaths ?? [])],
		readOnlyPaths: [...(base.readOnlyPaths ?? []), ...(override.readOnlyPaths ?? [])],
		noDeletePaths: [...(base.noDeletePaths ?? []), ...(override.noDeletePaths ?? [])],
	};
}
