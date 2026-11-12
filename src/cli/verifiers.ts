import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { readSettings } from "../core/config.js";
import { resolveSafeCwd, SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../core/safe-exec.js";
import { hostVerificationSandbox } from "../domains/dispatch/host-verification.js";
import {
	createVerifierDraft,
	discoverVerifierAuthoring,
	previewVerifierDraft,
	runVerifierAuthoringWorkflow,
	type VerifierRevision,
} from "../tools/verify/authoring.js";
import {
	DECLARED_CHECK_KINDS,
	type DeclaredCheckKind,
	loadProjectVerifierCatalog,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
} from "../tools/verify/catalog.js";
import { verifyTool } from "../tools/verify/index.js";
import { normalizeNumericTolerance } from "../tools/verify/numeric.js";
import { type DeclaredReproduce, normalizeReproduce } from "../tools/verify/reproduce.js";
import { discoverDeclaredChecksAtRoot, recordPerfBaseline } from "../tools/verify/scripts.js";
import { printError, printOk } from "./argv.js";
import { runVerifiersInspect } from "./verifiers-inspect.js";

const HELP = `Project verifier authoring

Usage:
  clio-coder verifiers discover
  clio-coder verifiers inspect --json
  clio-coder verifiers author [--exclude <id>] [--rename <old>=<new>] [--dry-run <id>] [--yes]
  clio-coder verifiers validate
  clio-coder verifiers dry-run <id>
  clio-coder verifiers add --id <id> --description <text> --command <json-argv> [fields] [--yes]
  clio-coder verifiers edit <id> [--description <text>] [--command <json-argv>] [fields] [--yes]
  clio-coder verifiers rename <old> <new> [--yes]
  clio-coder verifiers remove <id> [--yes]
  clio-coder verifiers baseline <id>

Fields:
  --cwd <path>            repository-relative working directory (default .)
  --timeout-ms <number>   bounded timeout in milliseconds (default 120000)
  --tags <a,b>            comma-separated catalog tags
  --kind <kind>           command (default), numeric-compare, perf-budget, or reproduce
  --reference <path>      numeric-compare: repository-relative reference JSON of string -> number | number[];
                          reproduce: reference metrics JSON in the command's own output format
  --tolerance <json>      numeric-compare: {"relative"?,"absolute"?,"ulp"?,"combine"?:all|any,"nonFinite"?:fail|match}, at least one numeric bound;
                          perf-budget with --baseline: {"relative"} headroom over the baseline
  --budget-ms <number>    perf-budget: wall-time bound in milliseconds
  --budget-relative <r>   perf-budget with --budget-ms: fractional headroom over the bound
  --baseline <path>       perf-budget: repository-relative baseline JSON written by 'verifiers baseline <id>'
  --input <path>[=<sha>]  reproduce, repeatable: pinned input file; without =<sha> the current file's sha256 is pinned
  --compare twice         reproduce: run twice in two clean environments instead of --reference
  --environment <env>     reproduce: worktree (default, detached worktree of HEAD) or copy (only the inputs)
  --seed <NAME>=<value>   reproduce: environment variable set for every run
  --units <json>          reproduce: {"metric": "units"} each metric must report beside its value
  --shapes <json>         reproduce: {"metric": [dims]} nested-array shape each metric must have

baseline runs a perf-budget check once and records its wall time at the check's
baseline path; a failing or timed-out command records nothing.

Discovery and every preview are read-only. Mutating commands write only with
--yes after printing the exact argv, cwd, timeout, tags, source provenance, and
effective execution authority. dry-run invokes the production verify path.

inspect is the fixed machine-readable read a GUI host may run. It takes no other
argument, runs no check, and carries no argv, cwd, source path, or diagnostic
text: the toolchain each check drives is classified, and the arguments stay here.
`;

const VALUE_OPTIONS = new Set([
	"--id",
	"--description",
	"--command",
	"--cwd",
	"--timeout-ms",
	"--tags",
	"--exclude",
	"--rename",
	"--dry-run",
	"--kind",
	"--reference",
	"--tolerance",
	"--budget-ms",
	"--budget-relative",
	"--baseline",
	"--input",
	"--compare",
	"--environment",
	"--seed",
	"--units",
	"--shapes",
]);

interface ParsedAuthoringArgs {
	yes: boolean;
	help: boolean;
	positional: string[];
	values: Map<string, string[]>;
	error?: string;
}

function parseAuthoringArgs(argv: ReadonlyArray<string>): ParsedAuthoringArgs {
	const positional: string[] = [];
	const values = new Map<string, string[]>();
	let yes = false;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--yes") {
			yes = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg?.startsWith("--") === true) {
			if (!VALUE_OPTIONS.has(arg)) return { yes, help, positional, values, error: `unknown option: ${arg}` };
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				return { yes, help, positional, values, error: `${arg} requires a value` };
			}
			const prior = values.get(arg) ?? [];
			prior.push(value);
			values.set(arg, prior);
			index += 1;
			continue;
		}
		if (arg !== undefined) positional.push(arg);
	}
	return { yes, help, positional, values };
}

function oneValue(parsed: ParsedAuthoringArgs, option: string): string | undefined {
	return parsed.values.get(option)?.at(-1);
}

function parseCommand(value: string | undefined): string[] | Error {
	if (value === undefined) return new Error("--command is required and must be a JSON argv array");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch (error) {
		return new Error(`--command must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((entry) => typeof entry !== "string")) {
		return new Error("--command must be a non-empty JSON string array");
	}
	return parsed as string[];
}

function parseTimeout(value: string | undefined): number | Error {
	if (value === undefined) return SAFE_EXEC_DEFAULT_TIMEOUT_MS;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) return new Error("--timeout-ms must be a positive integer");
	return parsed;
}

function tags(value: string | undefined): string[] {
	return value === undefined
		? []
		: value
				.split(",")
				.map((tag) => tag.trim())
				.filter((tag) => tag.length > 0);
}

type KindFields = Pick<Extract<VerifierRevision, { kind: "add" }>["check"], "kind" | "numeric" | "perf" | "reproduce">;

const REPRODUCE_OPTIONS = ["--input", "--compare", "--environment", "--seed", "--units", "--shapes"] as const;

/** SHA-256 of a repository file, read in chunks so a large data file is never held whole. */
function pinnedDigest(relative: string): string | Error {
	let resolved: string;
	try {
		resolved = resolveSafeCwd(relative, process.cwd());
	} catch (error) {
		return new Error(`--input ${relative}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let fd: number;
	try {
		fd = openSync(resolved, "r");
	} catch (error) {
		return new Error(`--input ${relative} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		if (!fstatSync(fd).isFile()) return new Error(`--input ${relative} is not a regular file`);
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(1024 * 1024);
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			hash.update(buffer.subarray(0, read));
		}
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

/** The reproduce declaration from the option set, through the catalog's own normalizer. */
function reproduceFromArgs(parsed: ParsedAuthoringArgs): DeclaredReproduce | Error {
	const inputs: Array<{ path: string; sha256: string }> = [];
	for (const entry of parsed.values.get("--input") ?? []) {
		const separator = entry.lastIndexOf("=");
		const pinPath = separator > 0 ? entry.slice(0, separator) : entry;
		const digest = separator > 0 ? entry.slice(separator + 1) : pinnedDigest(entry);
		if (digest instanceof Error) return digest;
		inputs.push({ path: pinPath, sha256: digest });
	}
	const record: Record<string, unknown> = { inputs };
	const compare = oneValue(parsed, "--compare");
	const reference = oneValue(parsed, "--reference");
	if ((compare === undefined) === (reference === undefined)) {
		return new Error("--kind reproduce requires exactly one of --compare twice or --reference <path>");
	}
	if (compare !== undefined) {
		if (compare !== "twice") return new Error("--compare takes twice; use --reference <path> to compare with a file");
		record.compare = "twice";
	} else {
		record.compare = { reference };
	}
	const toleranceValue = oneValue(parsed, "--tolerance");
	if (toleranceValue === undefined) return new Error("--tolerance is required for --kind reproduce");
	const tolerance = parseJsonObject(toleranceValue, "--tolerance");
	if (tolerance instanceof Error) return tolerance;
	record.tolerance = tolerance;
	const environment = oneValue(parsed, "--environment");
	if (environment !== undefined) record.environment = environment;
	const seed = oneValue(parsed, "--seed");
	if (seed !== undefined) {
		const separator = seed.indexOf("=");
		if (separator <= 0) return new Error("--seed must be NAME=value");
		record.seed = { env: seed.slice(0, separator), value: seed.slice(separator + 1) };
	}
	for (const [option, field] of [
		["--units", "units"],
		["--shapes", "shapes"],
	] as const) {
		const value = oneValue(parsed, option);
		if (value === undefined) continue;
		const json = parseJsonObject(value, option);
		if (json instanceof Error) return json;
		record[field] = json;
	}
	const spec = normalizeReproduce(record, "reproduce", (value, location) =>
		typeof value === "string" && value.length > 0 ? value : new Error(`${location} must be a non-empty path`),
	);
	return spec instanceof Error ? new Error(`--kind reproduce: ${spec.message}`) : spec;
}

function parseJsonObject(value: string, option: string): Record<string, unknown> | Error {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return new Error(`${option} must be a JSON object`);
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		return new Error(`${option} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * The kind and its parameters from the option set. Returns `{}` when no kind
 * option was given so a plain command check keeps the version-1 shape, and an
 * Error when the options disagree with the kind the way the catalog parser
 * would refuse them, so the operator reads one message here instead of a
 * rejected preview.
 */
function kindFieldsFromArgs(parsed: ParsedAuthoringArgs): KindFields | Error {
	const kindValue = oneValue(parsed, "--kind") ?? "command";
	if (!(DECLARED_CHECK_KINDS as ReadonlyArray<string>).includes(kindValue)) {
		return new Error(`--kind must be one of ${DECLARED_CHECK_KINDS.join(", ")}`);
	}
	const kind = kindValue as DeclaredCheckKind;
	const reference = oneValue(parsed, "--reference");
	const toleranceValue = oneValue(parsed, "--tolerance");
	const budgetMs = oneValue(parsed, "--budget-ms");
	const budgetRelative = oneValue(parsed, "--budget-relative");
	const baseline = oneValue(parsed, "--baseline");
	const reproduceOptions = REPRODUCE_OPTIONS.filter((option) => oneValue(parsed, option) !== undefined);
	if (kind === "reproduce") {
		if (budgetMs !== undefined || budgetRelative !== undefined || baseline !== undefined) {
			return new Error("--budget-ms, --budget-relative, and --baseline belong to --kind perf-budget");
		}
		const reproduce = reproduceFromArgs(parsed);
		return reproduce instanceof Error ? reproduce : { kind, reproduce };
	}
	if (reproduceOptions.length > 0) return new Error(`${reproduceOptions.join(", ")} belong to --kind reproduce`);
	if (kind === "command") {
		const stray = [
			["--reference", reference],
			["--tolerance", toleranceValue],
			["--budget-ms", budgetMs],
			["--budget-relative", budgetRelative],
			["--baseline", baseline],
		].filter(([, value]) => value !== undefined);
		if (stray.length > 0)
			return new Error(
				`${stray.map(([name]) => name).join(", ")} require --kind numeric-compare, perf-budget, or reproduce`,
			);
		return {};
	}
	if (kind === "numeric-compare") {
		if (budgetMs !== undefined || budgetRelative !== undefined || baseline !== undefined) {
			return new Error("--budget-ms, --budget-relative, and --baseline belong to --kind perf-budget");
		}
		if (reference === undefined) return new Error("--reference is required for --kind numeric-compare");
		if (toleranceValue === undefined) return new Error("--tolerance is required for --kind numeric-compare");
		const toleranceJson = parseJsonObject(toleranceValue, "--tolerance");
		if (toleranceJson instanceof Error) return toleranceJson;
		const tolerance = normalizeNumericTolerance(toleranceJson);
		if (tolerance instanceof Error) return new Error(`--tolerance ${tolerance.message}`);
		return { kind, numeric: { reference, tolerance } };
	}
	if (reference !== undefined) return new Error("--reference belongs to --kind numeric-compare");
	if ((budgetMs === undefined) === (baseline === undefined)) {
		return new Error("--kind perf-budget requires exactly one of --budget-ms or --baseline");
	}
	if (budgetMs !== undefined) {
		if (toleranceValue !== undefined) return new Error("use --budget-relative for headroom over --budget-ms");
		const wallTimeMs = Number(budgetMs);
		if (!Number.isFinite(wallTimeMs) || wallTimeMs <= 0) return new Error("--budget-ms must be a positive number");
		const budget: NonNullable<KindFields["perf"]>["budget"] = { wallTimeMs };
		if (budgetRelative !== undefined) {
			const relative = Number(budgetRelative);
			if (!Number.isFinite(relative) || relative < 0) return new Error("--budget-relative must be a non-negative number");
			budget.tolerance = { relative };
		}
		return { kind, perf: { budget } };
	}
	if (budgetRelative !== undefined)
		return new Error("--budget-relative belongs with --budget-ms; use --tolerance with --baseline");
	const perf: NonNullable<KindFields["perf"]> = { baseline: baseline as string };
	if (toleranceValue !== undefined) {
		const toleranceJson = parseJsonObject(toleranceValue, "--tolerance");
		if (toleranceJson instanceof Error) return toleranceJson;
		const relative = toleranceJson.relative;
		if (typeof relative !== "number" || !Number.isFinite(relative) || relative < 0) {
			return new Error('--tolerance for a baseline must be {"relative": <non-negative number>}');
		}
		perf.tolerance = { relative };
	}
	return { kind, perf };
}

function requiredValue(parsed: ParsedAuthoringArgs, option: string): string | Error {
	const value = oneValue(parsed, option);
	return value === undefined || value.length === 0 ? new Error(`${option} is required`) : value;
}

function authorRevisions(parsed: ParsedAuthoringArgs): VerifierRevision[] | Error {
	const revisions: VerifierRevision[] = [];
	for (const id of parsed.values.get("--exclude") ?? []) revisions.push({ kind: "remove", id });
	for (const rename of parsed.values.get("--rename") ?? []) {
		const separator = rename.indexOf("=");
		if (separator <= 0 || separator === rename.length - 1) {
			return new Error("--rename must use <old>=<new>");
		}
		revisions.push({ kind: "rename", id: rename.slice(0, separator), newId: rename.slice(separator + 1) });
	}
	return revisions;
}

function addRevision(parsed: ParsedAuthoringArgs): VerifierRevision | Error {
	const id = requiredValue(parsed, "--id");
	if (id instanceof Error) return id;
	const description = requiredValue(parsed, "--description");
	if (description instanceof Error) return description;
	const command = parseCommand(oneValue(parsed, "--command"));
	if (command instanceof Error) return command;
	const timeoutMs = parseTimeout(oneValue(parsed, "--timeout-ms"));
	if (timeoutMs instanceof Error) return timeoutMs;
	const kindFields = kindFieldsFromArgs(parsed);
	if (kindFields instanceof Error) return kindFields;
	return {
		kind: "add",
		check: {
			id,
			description,
			command,
			cwd: oneValue(parsed, "--cwd") ?? ".",
			timeoutMs,
			tags: tags(oneValue(parsed, "--tags")),
			...kindFields,
		},
	};
}

function editRevision(parsed: ParsedAuthoringArgs): VerifierRevision | Error {
	const id = parsed.positional[1];
	if (id === undefined) return new Error("edit requires a check ID");
	const changes: Extract<VerifierRevision, { kind: "edit" }>["changes"] = {};
	const description = oneValue(parsed, "--description");
	if (description !== undefined) changes.description = description;
	const commandValue = oneValue(parsed, "--command");
	if (commandValue !== undefined) {
		const command = parseCommand(commandValue);
		if (command instanceof Error) return command;
		changes.command = command;
	}
	const cwd = oneValue(parsed, "--cwd");
	if (cwd !== undefined) changes.cwd = cwd;
	const timeoutValue = oneValue(parsed, "--timeout-ms");
	if (timeoutValue !== undefined) {
		const timeoutMs = parseTimeout(timeoutValue);
		if (timeoutMs instanceof Error) return timeoutMs;
		changes.timeoutMs = timeoutMs;
	}
	const tagValue = oneValue(parsed, "--tags");
	if (tagValue !== undefined) changes.tags = tags(tagValue);
	if (oneValue(parsed, "--kind") !== undefined) {
		const kindFields = kindFieldsFromArgs(parsed);
		if (kindFields instanceof Error) return kindFields;
		changes.kind = kindFields.kind ?? "command";
		if (kindFields.numeric !== undefined) changes.numeric = kindFields.numeric;
		if (kindFields.perf !== undefined) changes.perf = kindFields.perf;
		if (kindFields.reproduce !== undefined) changes.reproduce = kindFields.reproduce;
	}
	if (Object.keys(changes).length === 0) return new Error("edit requires at least one changed field");
	return { kind: "edit", id, changes };
}

function mutationRevision(parsed: ParsedAuthoringArgs): VerifierRevision | Error {
	const command = parsed.positional[0];
	if (command === "add") return addRevision(parsed);
	if (command === "edit") return editRevision(parsed);
	if (command === "rename") {
		const id = parsed.positional[1];
		const newId = parsed.positional[2];
		if (id === undefined || newId === undefined) return new Error("rename requires <old> and <new> IDs");
		return { kind: "rename", id, newId };
	}
	if (command === "remove") {
		const id = parsed.positional[1];
		if (id === undefined) return new Error("remove requires a check ID");
		return { kind: "remove", id };
	}
	return new Error(`unknown verifiers command: ${command ?? "(none)"}`);
}

/**
 * Run a check as the verify tool does in a session: its command runs project code, which a model may have written (an
 * arena contender's worktree is scored this way), so it runs in the sandbox host verification uses for the project.
 */
function dryRunCheck(id: string): ReturnType<typeof verifyTool.run> {
	const shellSandbox = hostVerificationSandbox(readSettings(), process.cwd());
	return verifyTool.run({ check: id }, shellSandbox !== undefined ? { shellSandbox } : undefined);
}

function printDryRun(id: string, result: Awaited<ReturnType<typeof verifyTool.run>>): number {
	if (result.kind === "error") {
		printError(`dry-run '${id}' failed: ${result.message}`);
		return 1;
	}
	process.stdout.write(`Dry run '${id}':\n${result.output}${result.output.endsWith("\n") ? "" : "\n"}`);
	return 0;
}

async function executeWorkflow(
	parsed: ParsedAuthoringArgs,
	options: { includeProposals: boolean; revisions: VerifierRevision[] },
): Promise<number> {
	let printedPreview = false;
	const dryRunCheckIds = parsed.values.get("--dry-run") ?? [];
	const result = await runVerifierAuthoringWorkflow({
		includeProposals: options.includeProposals,
		initialRevisions: options.revisions,
		runCheck: dryRunCheck,
		confirmed: parsed.yes,
		decide(context) {
			process.stdout.write(`${context.preview}\n`);
			printedPreview = true;
			if (!parsed.yes || (context.draft.checks.length === 0 && options.revisions.length === 0)) {
				return { kind: "reject" };
			}
			return { kind: "confirm", dryRunCheckIds };
		},
	});
	if (result.status === "invalid") {
		if (!printedPreview && result.preview !== undefined) process.stdout.write(`${result.preview}\n`);
		printError(result.reason);
		if (result.wrote && result.path !== undefined) {
			process.stderr.write(`  ${result.path} was written; repair or remove it before running a check.\n`);
		}
		return 1;
	}
	if (result.status === "rejected") {
		if (!parsed.yes) {
			process.stdout.write("Review complete. Nothing changed; rerun the same command with --yes to write this preview.\n");
		} else {
			process.stdout.write(
				"Nothing changed because the preview contains no catalog checks. Package checks remain active; unsupported commands can be added with `clio-coder verifiers add`.\n",
			);
		}
		return 0;
	}
	printOk(`wrote ${result.path}; production parser accepted the catalog`);
	let code = 0;
	for (const dryRun of result.dryRuns) code = Math.max(code, printDryRun(dryRun.id, dryRun.result));
	return code;
}

async function baselineCommand(id: string | undefined): Promise<number> {
	if (id === undefined) {
		printError("baseline requires a check ID");
		return 2;
	}
	const loaded = loadProjectVerifierCatalog(process.cwd());
	if (!loaded.ok) {
		printError(`production catalog parser rejected ${loaded.reason}`);
		return 1;
	}
	const check = loaded.source?.checks.find((candidate) => candidate.id === id);
	if (check === undefined) {
		printError(`no catalog check '${id}' in ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}`);
		return 1;
	}
	const recorded = await recordPerfBaseline(check);
	if (!recorded.ok) {
		printError(`baseline '${id}' not recorded: ${recorded.message}`);
		return 1;
	}
	printOk(`recorded baseline for '${id}': ${Math.round(recorded.wallTimeMs)}ms at ${recorded.path}`);
	return 0;
}

async function discoverCommand(): Promise<number> {
	const discovery = discoverVerifierAuthoring();
	if (!discovery.ok) {
		printError(discovery.reason);
		process.stderr.write(`${discovery.manualEntry}\n`);
		return 1;
	}
	process.stdout.write(`${previewVerifierDraft(createVerifierDraft(discovery))}\n`);
	return 0;
}

function validateCommand(): number {
	const loaded = loadProjectVerifierCatalog(process.cwd());
	if (!loaded.ok) {
		printError(`production catalog parser rejected ${loaded.reason}`);
		return 1;
	}
	if (loaded.source === null) {
		process.stdout.write(`No ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH} exists. Run \`clio-coder verifiers author\`.\n`);
		return 0;
	}
	// A catalog the parser accepts can still leave dispatch with no checks: production
	// discovery merges it with package.json scripts and refuses the whole plane on a
	// duplicate id. Report what dispatch will actually see, not only what parsed.
	const discovery = discoverDeclaredChecksAtRoot(process.cwd(), undefined);
	if (!discovery.ok) {
		printError(
			`production catalog parser accepted ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}, but check discovery is blocked: ${discovery.reason}`,
		);
		return 1;
	}
	printOk(
		`production catalog parser accepted ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH} (${loaded.source.checks.length} check${loaded.source.checks.length === 1 ? "" : "s"})`,
	);
	return 0;
}

export async function runVerifiersCommand(argv: string[]): Promise<number> {
	// Routed before the authoring parser so the fixed read stays exactly fixed. No
	// authoring flag can reach it, and no flag it does not name can be spent on it.
	if (argv[0] === "inspect") return runVerifiersInspect(argv.slice(1));
	const parsed = parseAuthoringArgs(argv);
	if (parsed.error !== undefined) {
		printError(parsed.error);
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help || parsed.positional.length === 0) {
		process.stdout.write(HELP);
		return 0;
	}
	const command = parsed.positional[0];
	if (command === "discover") return discoverCommand();
	if (command === "validate") return validateCommand();
	if (command === "baseline") return baselineCommand(parsed.positional[1]);
	if (command === "dry-run") {
		const id = parsed.positional[1];
		if (id === undefined) {
			printError("dry-run requires a check ID");
			return 2;
		}
		return printDryRun(id, await dryRunCheck(id));
	}
	if (command === "author") {
		const revisions = authorRevisions(parsed);
		if (revisions instanceof Error) {
			printError(revisions.message);
			return 2;
		}
		return executeWorkflow(parsed, { includeProposals: true, revisions });
	}
	if (["add", "edit", "rename", "remove"].includes(command ?? "")) {
		const revision = mutationRevision(parsed);
		if (revision instanceof Error) {
			printError(revision.message);
			return 2;
		}
		return executeWorkflow(parsed, { includeProposals: false, revisions: [revision] });
	}
	printError(`unknown verifiers command: ${command}`);
	process.stderr.write(HELP);
	return 2;
}
