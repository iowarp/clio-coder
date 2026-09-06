import { normalizeIntentExpectedOutputs, normalizeIntentVerification } from "../domains/dispatch/intent.js";
import type { UserTaskAcceptance } from "../domains/user-tasks/acceptance.js";
import { formatUserTaskHandoff } from "../domains/user-tasks/handoff.js";
import { createUserTasksStore } from "../domains/user-tasks/store.js";
import { packageDeclaredCheck } from "../tools/verify/catalog.js";
import { discoverDeclaredChecksAtRoot, discoverDeclaredProjectEntriesAtRoot } from "../tools/verify/scripts.js";
import { printError } from "./argv.js";

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

const HELP = `Usage:
  clio-coder tasks [list]
  clio-coder tasks add [--expect <path>] [--verify <checkId>[:timeoutMs]] <text>
  clio-coder tasks hand|done|drop <uN>

--expect and --verify are repeatable. Check ids must be declared in package.json or .clio-coder/verifiers.yaml.`;

export function runTasksCommand(args: string[]): number {
	try {
		if (args.includes("--help") || args.includes("-h")) {
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
					if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
					(token === "--expect" ? expected : verify).push(value);
				} else if (token.startsWith("--")) throw new Error(`Unknown flag ${token}`);
				else title.push(token);
			}
			const task = store.add(title.join(" "), undefined, acceptanceFromTaskFlags(process.cwd(), expected, verify));
			console.log(`logged operator task ${task.id}: ${task.title}`);
		} else if (action === "list" && rest.length === 0) {
			console.log(JSON.stringify(store.snapshot(), null, 2));
		} else if ((action === "hand" || action === "done" || action === "drop") && rest.length === 1) {
			const task = store[action](rest[0] ?? "");
			console.log(JSON.stringify(task, null, 2));
			if (action === "hand") {
				console.error(
					"CLI hand records the inbox state only; it does not start a session or submit the interactive /tasks hand turn. " +
						"Pass this pickup prompt to clio-coder run in the same project:\n" +
						formatUserTaskHandoff(task),
				);
			}
		} else throw new Error(HELP);
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
