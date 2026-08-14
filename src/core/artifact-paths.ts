/**
 * Where the terminal `artifact` tool writes when the caller names no path.
 *
 * The repo working tree holds files a human asked for. Everything Clio
 * generates on its own goes to the project-local `.clio-coder/` directory,
 * which is gitignored, so a turn that decides to write a report cannot litter
 * the tree a person is working in. An explicit `path` argument still writes
 * wherever the caller says, inside the workspace.
 *
 * The default is a pure function of the artifact kind, and it has to stay that
 * way: the action classifier, the policy engine's write-root check, and the
 * protected-artifacts guard all predict the path a pathless `artifact` call
 * will write to, from the arguments alone. A default keyed on session id or a
 * timestamp would make that prediction impossible, and the safety layer would
 * be checking a path the tool never writes. One artifact per kind is therefore
 * the contract; keep several by passing explicit paths.
 *
 * See docs/artifact-placement.md for the full taxonomy.
 */

/** Project-local directory holding everything Clio generates for one repo. */
export const CLIO_PROJECT_DIR = ".clio-coder";

/** Landing zone for terminal artifacts written without an explicit path. */
export const CLIO_ARTIFACT_DIR = `${CLIO_PROJECT_DIR}/artifacts`;

const KIND_FILENAMES: Record<string, string> = {
	plan: "PLAN.md",
	review: "REVIEW.md",
	report: "REPORT.md",
};

const DEFAULT_FILENAME = KIND_FILENAMES.plan as string;

/**
 * Workspace-relative path a pathless `artifact` call writes to. An unknown or
 * missing kind resolves to the plan path, matching the tool's own fallback, so
 * the safety layer and the tool never disagree about a malformed call.
 */
export function artifactDefaultPath(kind: unknown): string {
	const filename = typeof kind === "string" ? (KIND_FILENAMES[kind] ?? DEFAULT_FILENAME) : DEFAULT_FILENAME;
	return `${CLIO_ARTIFACT_DIR}/${filename}`;
}
