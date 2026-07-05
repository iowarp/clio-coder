/**
 * Directory names excluded from codewiki indexing and fingerprint drift.
 *
 * Covers VCS metadata, dependency and build output, language caches, and the
 * gitignored scratch areas that local agent tooling writes into the working
 * tree (.superpowers, .codex, .claude, .clio-benchmark). Both the codewiki
 * walker and the fingerprint walker share this policy so a scratch write never
 * pollutes the index or registers as source drift.
 */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
	".git",
	".hg",
	".svn",
	".clio",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	"target",
	"vendor",
	".superpowers",
	".codex",
	".claude",
	".clio-benchmark",
]);
