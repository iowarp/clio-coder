import { normalizeIntentExpectedOutputs, normalizeIntentVerification } from "../domains/dispatch/intent.js";
import type { UserTaskAcceptance } from "../domains/user-tasks/acceptance.js";
import { formatUserTaskHandoff } from "../domains/user-tasks/handoff.js";
import { createUserTasksStore } from "../domains/user-tasks/store.js";
import { packageDeclaredCheck } from "../tools/verify/catalog.js";
import { discoverDeclaredChecksAtRoot, discoverDeclaredProjectEntriesAtRoot } from "../tools/verify/scripts.js";
import { jsonDocument, writeCliFailure } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";

/** Operator flags use the same bounds and normalization as dispatch intent. */
export function acceptanceFromTaskFlags(
	cwd: string,
	expectedOutputs: string[],
	verify: string[],
): UserTaskAcceptance | undefined {
	if (expectedOutputs.length === 0 && verify.length === 0) return undefined;
	const discovery = discoverDeclaredChecksAtRoot(cwd, undefined);
	if (!discovery.ok) throw new Error(discovery.reason);
	const checks = new Map(
		discovery.sources.flatMap((source) => source.checks.map((check) => [check.id, check] as const)),
	);
	for (const entry of discoverDeclaredProjectEntriesAtRoot(cwd)) {
		if (entry.kind === "package-script" && !checks.has(entry.id))
			checks.set(entry.id, packageDeclaredCheck(entry.id, entry.path, ".", []));
	}
	const verification = verify.map((value) => {
		const suffix = checks.has(value) ? null : /^(.*):([0-9]+)$/.exec(value);
		const check = suffix?.[1] ?? value;
		if (!checks.has(check))
			throw new Error(
				`Unknown verification check '${check}'. Known ids: ${[...checks.keys()].sort().join(", ") || "(none)"}`,
			);
		return { check, ...(suffix ? { timeout_ms: Number(suffix[2]) } : {}) };
	});
	const outputs = normalizeIntentExpectedOutputs(expectedOutputs);
	if (!Array.isArray(outputs)) throw new Error(outputs.ok ? "invalid expected outputs" : outputs.message);
	const normalized = normalizeIntentVerification(verification, checks);
	if (!Array.isArray(normalized)) throw new Error(normalized.ok ? "invalid verification" : normalized.message);
	return { expectedOutputs: outputs, verification: normalized };
}

const USAGE = `Usage:
  clio-coder tasks [list] [--json]
  clio-coder tasks add [--expect <path>] [--verify <checkId>[:timeoutMs]] [--json] <text>
  clio-coder tasks hand|done|drop <uN> [--json]
`;

const HELP = `${USAGE}
--expect and --verify are repeatable. Check ids must be declared in package.json or .clio-coder/verifiers.yaml.
list, hand, done and drop always print JSON; --json is accepted on them for uniformity. add prints
{"version":1,"task":{...}} with --json and one line without it.`;

const VERBS = new Set(["add", "list", "hand", "done", "drop"]);

class TasksUsageError extends Error {
	constructor(
		message: string,
		readonly slug: ErrorSlug = "usage",
	) {
		super(message);
	}
}

function unexpected(arg: string): TasksUsageError {
	return arg.startsWith("-")
		? new TasksUsageError(`unknown flag: ${arg}`, "unknown_flag")
		: new TasksUsageError(`unexpected argument: ${arg}`);
}

export function runTasksCommand(argv: string[]): number {
	// `--json` is a flag of every leaf, not task text, unless it follows "--".
	const end = argv.indexOf("--");
	const options = end === -1 ? argv : argv.slice(0, end);
	const json = options.includes("--json");
	const args = json ? [...options.filter((arg) => arg !== "--json"), ...(end === -1 ? [] : argv.slice(end))] : argv;
	const path = ["tasks", ...(VERBS.has(args[0] ?? "list") ? [args[0] ?? "list"] : [])];
	try {
		if (options.includes("--help") || options.includes("-h")) {
			console.log(HELP);
			return 0;
		}
		const store = createUserTasksStore({ cwd: process.cwd() });
		const [action = "list", ...rest] = args;
		if (action === "add") {
			const expected: string[] = [],
				verify: string[] = [],
				title: string[] = [];
			for (let index = 0; index < rest.length; index++) {
				const token = rest[index] ?? "";
				if (token === "--") {
					title.push(...rest.slice(index + 1));
					break;
				}
				if (token === "--expect" || token === "--verify") {
					const value = rest[++index];
					if (!value || value.startsWith("--")) throw new TasksUsageError(`${token} requires a value`);
					(token === "--expect" ? expected : verify).push(value);
				} else if (token.startsWith("--")) throw unexpected(token);
				else title.push(token);
			}
			if (title.join(" ").trim().length === 0) throw new TasksUsageError("tasks add requires the task text");
			const task = store.add(title.join(" "), undefined, acceptanceFromTaskFlags(process.cwd(), expected, verify));
			if (json) console.log(JSON.stringify(jsonDocument({ task })));
			else console.log(`logged operator task ${task.id}: ${task.title}`);
		} else if (action === "list") {
			if (rest[0] !== undefined) throw unexpected(rest[0]);
			console.log(JSON.stringify(store.snapshot(), null, 2));
		} else if (action === "hand" || action === "done" || action === "drop") {
			const [id, extra] = rest;
			if (id === undefined) throw new TasksUsageError(`tasks ${action} requires a task id (uN)`);
			if (id.startsWith("-")) throw unexpected(id);
			if (extra !== undefined) throw unexpected(extra);
			let task: ReturnType<(typeof store)[typeof action]>;
			try {
				task = store[action](id);
			} catch (error) {
				writeCliFailure({ path, slug: "not_found", message: error instanceof Error ? error.message : String(error), json });
				return 1;
			}
			console.log(JSON.stringify(task, null, 2));
			if (action === "hand") {
				console.error(
					"CLI hand records the inbox state only; it does not start a session or submit the interactive /tasks hand turn. " +
						"Pass this pickup prompt to clio-coder run in the same project:\n" +
						formatUserTaskHandoff(task),
				);
			}
		} else
			throw action.startsWith("-")
				? new TasksUsageError(`unknown flag: ${action}`, "unknown_flag")
				: new TasksUsageError(`unknown tasks command: ${action}`, "unknown_command");
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof TasksUsageError) {
			writeCliFailure({ path, slug: error.slug, message, json });
			return 2;
		}
		writeCliFailure({ path, slug: "io", message, json });
		return 1;
	}
}
