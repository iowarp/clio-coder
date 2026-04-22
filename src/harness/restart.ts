import { spawn } from "node:child_process";

export interface RestartPlan {
	execPath: string;
	argv: string[];
	env: NodeJS.ProcessEnv;
}

export interface RestartPlanInput {
	execPath: string;
	argv: ReadonlyArray<string>;
	env: NodeJS.ProcessEnv;
	sessionId: string | null;
}

/**
 * Pure helper that computes the spawn arguments for a self-restart. Extracted
 * from executeRestart so it can be unit-tested without spawning a child.
 */
export function buildRestartPlan(input: RestartPlanInput): RestartPlan {
	const argv = input.argv.slice(1);
	const env: NodeJS.ProcessEnv = { ...input.env, CLIO_SELF_DEV: "1" };
	if (input.sessionId) {
		env.CLIO_RESUME_SESSION_ID = input.sessionId;
	}
	return { execPath: input.execPath, argv, env };
}

export interface ExecuteRestartDeps {
	sessionId: string | null;
	shutdown: (code?: number) => Promise<void>;
}

/**
 * Spawns a detached replacement process and triggers the existing 4-phase
 * shutdown on the parent. The child inherits stdio so the TTY transitions
 * seamlessly when the parent exits.
 */
export async function executeRestart(deps: ExecuteRestartDeps): Promise<void> {
	const plan = buildRestartPlan({
		execPath: process.execPath,
		argv: process.argv,
		env: process.env,
		sessionId: deps.sessionId,
	});
	const child = spawn(plan.execPath, plan.argv, {
		stdio: "inherit",
		detached: true,
		env: plan.env,
	});
	child.unref();
	await deps.shutdown(0);
}
