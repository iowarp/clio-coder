/**
 * Fixed machine-readable projection of this project's verification checks.
 *
 * `verifiers discover` renders an authoring preview and `verifiers validate`
 * prints one sentence, so neither is a transport a GUI host can invoke. This
 * command takes no identifier and no flag beyond `--json`, writes nothing, and
 * runs no check: `verifiers dry-run` executes the production verify path and is
 * a deliberate operator action, not something a browser refresh should trigger.
 *
 * What crosses is the shape of the check plane: which checks exist, where each
 * was declared, which toolchain it drives, whether its argv is fixed, and
 * whether the project catalog parses at all.
 *
 * What does not cross is the argv itself. A catalog check's `command` is an
 * exact argument vector whose entries the schema permits to be absolute paths,
 * so no width of projection makes it safe, and the executable is therefore
 * classified against a closed set of toolchains rather than quoted. That is the
 * same call trace event payloads and process command lines got: count and
 * classify instead of projecting less. The declared `cwd`, the source file
 * path, and every discovery diagnostic stay host-side for the same reason.
 */

import { isProjectVerifierCheckId } from "../core/verification-scripts.js";
import {
	type AuthoringCheck,
	discoverVerifierAuthoring,
	type VerifierProposalAuthority,
	type VerifierSignalKind,
} from "../tools/verify/authoring.js";
import { loadProjectVerifierCatalog, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH } from "../tools/verify/catalog.js";

/** Wire bound on the emitted check list, independent of the catalog's own 128-check cap. */
export const MAX_VERIFIERS_INSPECT_CHECKS = 64;

const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REJECTION_LOCATION_PATTERN = /^(root|checks\[\d{1,3}\])(\.[a-zA-Z]{1,32}(\[\d{1,3}\])?)?$/;

/**
 * Where a check was declared, and therefore how much of it the operator wrote.
 *
 * The domain's own `AuthoringCheck.state` also carries `manual`, which only the
 * interactive authoring flow mints. Discovery cannot produce it, so it is not in
 * this set: carrying a value this read can never emit would state a distinction
 * it never establishes.
 */
export const VERIFIER_ORIGINS = ["package-script", "catalog", "proposed"] as const;
export type VerifierOrigin = (typeof VERIFIER_ORIGINS)[number];

/**
 * The toolchain a check drives, classified from `command[0]`.
 *
 * The catalog schema already guarantees the executable is a single token and
 * refuses every shell, so this is a classification over a constrained value
 * rather than a redaction of an arbitrary one. `other` is a real answer: the
 * operator still learns a check exists and how it is bound, just not which
 * program outside this list it starts.
 */
export const VERIFIER_RUNNERS = [
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"node",
	"cargo",
	"go",
	"make",
	"just",
	"cmake",
	"ctest",
	"ninja",
	"python",
	"pytest",
	"uv",
	"tox",
	"nox",
	"dotnet",
	"gradle",
	"maven",
	"rake",
	"swift",
	"other",
] as const;
export type VerifierRunner = (typeof VERIFIER_RUNNERS)[number];

const RUNNER_ALIASES = new Map<string, VerifierRunner>([
	["python3", "python"],
	["python2", "python"],
	["py", "python"],
	["mvn", "maven"],
	["gradlew", "gradle"],
	["mvnw", "maven"],
	["npx", "npm"],
	["pnpx", "pnpm"],
	["go-test", "go"],
]);

/** Why discovery could not enumerate the check plane at all. */
export const VERIFIER_BLOCKS = ["catalog-rejected", "id-collision", "unclassified"] as const;
export type VerifierBlock = (typeof VERIFIER_BLOCKS)[number];

/**
 * Why the production parser refused the project catalog.
 *
 * The parser's diagnostics quote the offending value, the workspace path, and
 * the schema cap that was passed, so the sentence itself never crosses. The
 * classification says what went wrong and `rejectedAt` says where, which is the
 * pair an operator needs to find the line without being handed its contents.
 */
export const VERIFIER_REJECTIONS = [
	"unreadable",
	"invalid-yaml",
	"unsupported-version",
	"unknown-field",
	"missing-field",
	"duplicate-id",
	"shell-command",
	"too-large",
	"invalid-cwd",
	"invalid-value",
	"unclassified",
] as const;
export type VerifierRejection = (typeof VERIFIER_REJECTIONS)[number];

export interface VerifiersInspectCheck {
	readonly id: string;
	readonly description: string;
	readonly origin: VerifierOrigin;
	/** The declaration the harness read this check out of. */
	readonly signal: VerifierSignalKind;
	readonly authority: VerifierProposalAuthority;
	/** The toolchain `command[0]` starts. The arguments themselves stay host-side. */
	readonly runner: VerifierRunner;
	/** How many arguments follow the executable, so an operator can see a bare invocation from a long one. */
	readonly argumentCount: number;
	/** True when the check runs at the repository root. A subdirectory's name does not cross. */
	readonly runsAtRepositoryRoot: boolean;
	/**
	 * True when verify fixes argv, cwd, and timeout through safe-exec.
	 *
	 * A package-script check runs npm with the declared script name and may
	 * accept explicit extra argv, so it is the one origin whose effective
	 * command is not pinned by the declaration. That is a trust difference and
	 * the reason this is reported rather than left to be inferred.
	 */
	readonly argvFixed: boolean;
	readonly timeoutMs: number;
	readonly tags: readonly string[];
}

export interface VerifiersInspectSnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	/** Whether the project catalog file exists at all. Its path stays host-side. */
	readonly catalogPresent: boolean;
	/** Whether the production parser accepted it; null when there is nothing to parse. */
	readonly catalogValid: boolean | null;
	readonly rejection: VerifierRejection | null;
	/** The schema location the rejection named, such as `checks[3].command[0]`. */
	readonly rejectedAt: string | null;
	/** Whether the check plane could be enumerated. */
	readonly discovery: "complete" | "blocked";
	readonly blockedBy: VerifierBlock | null;
	readonly checks: readonly VerifiersInspectCheck[];
	readonly checksTruncated: boolean;
	/** How many discovery diagnostics were raised. Each one quotes a path, so the text stays host-side. */
	readonly diagnosticCount: number;
}

/**
 * A codepoint scan rather than a regex, because the whole point is the control
 * range and a character class over it is exactly what a linter refuses.
 */
function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function runnerOf(executable: string | undefined): VerifierRunner {
	if (executable === undefined) return "other";
	const separator = Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\"));
	const base = executable
		.slice(separator + 1)
		.toLowerCase()
		.replace(/\.(exe|cmd|bat|ps1)$/u, "");
	const alias = RUNNER_ALIASES.get(base);
	if (alias !== undefined) return alias;
	return (VERIFIER_RUNNERS as ReadonlyArray<string>).includes(base) ? (base as VerifierRunner) : "other";
}

function rejectionMessage(reason: string): string {
	const prefix = `${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}: `;
	return reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

function rejectionLocation(message: string): string | null {
	const match = /^(?:root|checks\[\d{1,3}\])(?:\.[a-zA-Z]{1,32}(?:\[\d{1,3}\])?)?/u.exec(message);
	const candidate = match?.[0];
	if (candidate === undefined) return null;
	return REJECTION_LOCATION_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Classify the parser's sentence instead of quoting it.
 *
 * The order is the discriminating one, not the declaration one: a cap failure
 * is a cap failure wherever it happened, and the cwd bucket is guarded on the
 * location so a NUL byte in an argv entry does not read as a bad directory.
 */
function classifyRejection(reason: string): { rejection: VerifierRejection; rejectedAt: string | null } {
	const message = rejectionMessage(reason);
	const rejectedAt = rejectionLocation(message);
	const has = (fragment: string): boolean => message.includes(fragment);
	const rejection: VerifierRejection = has("invalid YAML")
		? "invalid-yaml"
		: has("cannot read catalog") || has("must be a regular file") || has("must resolve inside the workspace root")
			? "unreadable"
			: has("unsupported version")
				? "unsupported-version"
				: has("has unknown field(s)")
					? "unknown-field"
					: has(" is required")
						? "missing-field"
						: has("duplicates '") || has("contains duplicate tag")
							? "duplicate-id"
							: has("may not invoke shell executable") ||
									has("must be one executable token") ||
									has("shell command strings are not allowed")
								? "shell-command"
								: has("exceeds the")
									? "too-large"
									: rejectedAt?.endsWith(".cwd") === true
										? "invalid-cwd"
										: has("must be") || has("must match") || has("must not contain") || has("uses reserved")
											? "invalid-value"
											: "unclassified";
	return { rejection, rejectedAt };
}

function classifyBlock(reason: string): VerifierBlock {
	if (reason.includes(`${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}: `)) return "catalog-rejected";
	if (reason.includes("duplicate declared check id ")) return "id-collision";
	return "unclassified";
}

/**
 * Re-enforce the shapes the catalog schema already guarantees.
 *
 * The ids and tags reaching here came through the production parser, so this is
 * belt and braces rather than the first line of defence. It is worth the lines
 * because a package.json script name is not held to the catalog's id rule, and
 * because whatever wrote the declaration, the strings that cross carry no path,
 * quote, space, or control byte.
 */
function projectCheck(check: AuthoringCheck): VerifiersInspectCheck | null {
	// `manual` is only minted inside the interactive authoring flow, so a check
	// carrying it here means this read was handed a draft rather than a discovery.
	if (check.state === "manual") return null;
	if (!isProjectVerifierCheckId(check.id) || check.id.length > 64) return null;
	if (check.description.trim() !== check.description || check.description.length === 0) return null;
	if (hasControlCharacter(check.description) || check.description.length > 512) return null;
	const tags = check.tags.filter((tag) => TAG_PATTERN.test(tag) && tag.length <= 32);
	if (tags.length !== check.tags.length) return null;
	const origin: VerifierOrigin =
		check.state === "active" ? "package-script" : check.state === "existing" ? "catalog" : "proposed";
	return {
		id: check.id,
		description: check.description,
		origin,
		signal: check.provenance.kind,
		authority: check.provenance.authority,
		runner: runnerOf(check.command[0]),
		argumentCount: Math.max(check.command.length - 1, 0),
		runsAtRepositoryRoot: check.cwd === ".",
		argvFixed: origin !== "package-script",
		timeoutMs: check.timeoutMs,
		tags,
	};
}

const ORIGIN_RANK: Record<VerifierOrigin, number> = { "package-script": 0, catalog: 1, proposed: 2 };

export function verifiersInspectSnapshot(
	now: () => number = Date.now,
	workspaceRoot: string = process.cwd(),
): VerifiersInspectSnapshot {
	const generatedAt = new Date(now()).toISOString();
	// The catalog is loaded on its own rather than inferred from discovery,
	// because discovery also fails on an id collision between package.json and
	// the catalog, and "your catalog is broken" and "two declarations claim the
	// same id" are different operator states with different repairs.
	const catalog = loadProjectVerifierCatalog(workspaceRoot);
	const catalogPresent = catalog.ok ? catalog.source !== null : true;
	const classified = catalog.ok ? null : classifyRejection(catalog.reason);
	const discovery = discoverVerifierAuthoring(workspaceRoot);
	const base = {
		version: 1,
		generatedAt,
		catalogPresent,
		catalogValid: catalog.ok ? (catalog.source === null ? null : true) : false,
		rejection: classified?.rejection ?? null,
		rejectedAt: classified?.rejectedAt ?? null,
	} as const;
	if (!discovery.ok) {
		return {
			...base,
			discovery: "blocked",
			blockedBy: classifyBlock(discovery.reason),
			checks: [],
			checksTruncated: false,
			diagnosticCount: 0,
		};
	}
	const projected = [...discovery.activeChecks, ...discovery.existingChecks, ...discovery.proposals]
		.map(projectCheck)
		.filter((check): check is VerifiersInspectCheck => check !== null)
		.sort((left, right) =>
			ORIGIN_RANK[left.origin] !== ORIGIN_RANK[right.origin]
				? ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin]
				: left.id < right.id
					? -1
					: left.id > right.id
						? 1
						: 0,
		);
	const checks = projected.slice(0, MAX_VERIFIERS_INSPECT_CHECKS);
	return {
		...base,
		discovery: "complete",
		blockedBy: null,
		checks,
		checksTruncated: checks.length < projected.length,
		diagnosticCount: discovery.diagnostics.length,
	};
}

export function runVerifiersInspect(args: ReadonlyArray<string>): number {
	if (args.length !== 1 || args[0] !== "--json") {
		process.stderr.write("clio-coder verifiers inspect: usage: clio-coder verifiers inspect --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(verifiersInspectSnapshot(), null, 2)}\n`);
	return 0;
}
