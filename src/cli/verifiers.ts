import { SAFE_EXEC_DEFAULT_TIMEOUT_MS } from "../core/safe-exec.js";
import {
	createVerifierDraft,
	discoverVerifierAuthoring,
	previewVerifierDraft,
	runVerifierAuthoringWorkflow,
	type VerifierRevision,
} from "../tools/verify/authoring.js";
import { loadProjectVerifierCatalog, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH } from "../tools/verify/catalog.js";
import { verifyTool } from "../tools/verify/index.js";
import { printError, printOk } from "./argv.js";

const HELP = `Project verifier authoring

Usage:
  clio-coder verifiers discover
  clio-coder verifiers author [--exclude <id>] [--rename <old>=<new>] [--dry-run <id>] [--yes]
  clio-coder verifiers validate
  clio-coder verifiers dry-run <id>
  clio-coder verifiers add --id <id> --description <text> --command <json-argv> [fields] [--yes]
  clio-coder verifiers edit <id> [--description <text>] [--command <json-argv>] [fields] [--yes]
  clio-coder verifiers rename <old> <new> [--yes]
  clio-coder verifiers remove <id> [--yes]

Fields:
  --cwd <path>            repository-relative working directory (default .)
  --timeout-ms <number>   bounded timeout in milliseconds (default 120000)
  --tags <a,b>            comma-separated catalog tags

Discovery and every preview are read-only. Mutating commands write only with
--yes after printing the exact argv, cwd, timeout, tags, source provenance, and
effective execution authority. dry-run invokes the production verify path.
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
	return {
		kind: "add",
		check: {
			id,
			description,
			command,
			cwd: oneValue(parsed, "--cwd") ?? ".",
			timeoutMs,
			tags: tags(oneValue(parsed, "--tags")),
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
	printOk(
		`production catalog parser accepted ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH} (${loaded.source.checks.length} check${loaded.source.checks.length === 1 ? "" : "s"})`,
	);
	return 0;
}

export async function runVerifiersCommand(argv: string[]): Promise<number> {
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
	if (command === "dry-run") {
		const id = parsed.positional[1];
		if (id === undefined) {
			printError("dry-run requires a check ID");
			return 2;
		}
		return printDryRun(id, await verifyTool.run({ check: id }));
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
