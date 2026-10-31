import { readSettings } from "../core/config.js";
import { executeTaskLand, listLandableTasks, planTaskLand, type TaskLandMode } from "../tools/task-land.js";
import { allowedWorktreeParents } from "../tools/worktree-root.js";

const HELP = `clio-coder fleet land [<run id or clio-coder/task/<run id> branch>] [options]

  (no run)                 list task branches finished runs left to land
  <run>                    preview: commits, changes, destination and conflicts
  --yes                    land it, then remove its branch, worktree and claim
  --squash                 land one commit instead of the branch's history
  --message <text>         message for the landing commit
  --keep                   keep the branch and worktree after landing
  --plan <id>              refuse unless the landing still matches that preview
  --json                   print the plan or the list as JSON

The run lands on the branch it was dispatched from, which must be checked out.
The preview changes no ref, index or worktree; it may write dangling Git
objects, which git gc removes. Conflicts are found before anything changes. The only step that touches the
checkout is a fast-forward, which Git refuses when it would overwrite a local
change. Uncommitted work in a kept worktree is committed onto its task branch
first, and only with --yes.
`;

function parentsFor(root: string): string[] | undefined {
	try {
		return allowedWorktreeParents(readSettings().fleet.worktrees.root, root);
	} catch {
		// Unreadable settings fall back to the project-root location, which always holds the claims.
		return undefined;
	}
}

export async function runFleetLand(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (["--yes", "--squash", "--keep", "--json"].includes(arg)) flags.add(arg);
		else if (arg === "--message" || arg === "--plan") {
			const value = args[++i];
			if (value === undefined || value.startsWith("--")) return usage(`${arg} needs a value`);
			values.set(arg, value);
		} else if (arg.startsWith("-")) return usage(`unknown flag: ${arg}`);
		else positional.push(arg);
	}
	if (positional.length > 1) return usage("land takes one run id");
	const cwd = process.cwd();
	try {
		const ref = positional[0];
		if (ref === undefined) {
			const tasks = listLandableTasks(cwd, parentsFor(cwd));
			if (flags.has("--json")) process.stdout.write(`${JSON.stringify({ tasks }, null, 2)}\n`);
			else if (tasks.length === 0) process.stdout.write("No task branches to land.\n");
			else {
				for (const task of tasks)
					process.stdout.write(
						`${task.runId}  ${task.state}  ${task.commits ?? "?"} commit(s)  worktree ${task.worktreePresent ? "present" : "gone"}  ${task.reason}\n`,
					);
				process.stdout.write("Preview one: clio-coder fleet land <run id>\n");
			}
			return 0;
		}
		const mode: TaskLandMode = flags.has("--squash") ? "squash" : "merge";
		const root = cwd;
		const plan = planTaskLand({ root, ref, mode, ...withParents(parentsFor(root)) });
		if (flags.has("--json")) {
			const { worktree, ...rest } = plan;
			process.stdout.write(`${JSON.stringify({ ...rest, worktree: worktree?.path ?? null }, null, 2)}\n`);
		} else {
			const how = plan.alreadyLanded
				? "already landed"
				: plan.mode === "squash"
					? "squash into one commit"
					: plan.fastForward
						? "fast-forward"
						: "merge commit";
			process.stdout.write(`${plan.branch} onto ${plan.destination} (${how}), plan ${plan.planId}\n`);
			for (const line of plan.commits) process.stdout.write(`  ${line}\n`);
			if (plan.uncommitted > 0)
				process.stdout.write(`  plus ${plan.uncommitted} uncommitted path(s) in ${plan.worktree?.path}\n`);
			process.stdout.write(`  changes: ${plan.changed}\n`);
			if (plan.refusal !== null) process.stdout.write(`  cannot land: ${plan.refusal}\n`);
		}
		if (plan.refusal !== null) return 1;
		const expected = values.get("--plan");
		if (expected !== undefined && expected !== plan.planId) {
			process.stderr.write(
				`clio-coder fleet land: the landing changed since plan ${expected} (now ${plan.planId}); preview it again\n`,
			);
			return 1;
		}
		if (!flags.has("--yes")) {
			process.stdout.write(
				`Land it: clio-coder fleet land ${plan.runId} --yes --plan ${plan.planId}${mode === "squash" ? " --squash" : ""}\n`,
			);
			return 0;
		}
		const message = values.get("--message");
		const result = executeTaskLand(plan, {
			...(message !== undefined ? { message } : {}),
			keep: flags.has("--keep"),
		});
		process.stdout.write(
			`${result.landed !== null ? `Landed ${result.landed.slice(0, 9)} on ${plan.destination}` : `Nothing new to land on ${plan.destination}`}; ${result.detail}.\n`,
		);
		return 0;
	} catch (error) {
		process.stderr.write(`clio-coder fleet land: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

function withParents(parents: string[] | undefined): { allowedParents?: string[] } {
	return parents !== undefined ? { allowedParents: parents } : {};
}

function usage(message: string): number {
	process.stderr.write(`clio-coder fleet land: ${message}\n${HELP}`);
	return 2;
}
