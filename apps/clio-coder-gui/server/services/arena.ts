import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	ArenaMatch,
	ArenaMatches,
	ArenaStandings,
	type ArenaStartRequest,
	ArenaVote,
	type ArenaVoteRequest,
} from "../../contracts/arena.js";
import { runClioCommand, stopClioCommand } from "../process-policy.js";
import type { CliRunner } from "./cli-runner.js";
import { fingerprint, type OperationRegistry } from "./operations.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

/** Past the match's own timeout, the CLI still diffs, checks and removes worktrees before it exits. */
const SETTLE_MS = 120_000;
/** A stopped `arena run` aborts its contenders and cleans up; SIGKILL comes only if that stalls. */
const KILL_GRACE_MS = 15_000;
const STDOUT_LIMIT = 8 * 1024 * 1024;
const STARTED = /^clio-coder arena: match ([0-9]{8}-[0-9]{6}-[0-9a-f]{4}) started$/;

type ToolResult = { id: string; message: string };

function checked<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	if (!Value.Check(schema, value)) throw new AppProblem("operation_failed", `Clio returned an invalid arena ${what}.`);
	return value as Static<T>;
}

/**
 * Reads go through the shared CLI runner. A match outlives its 60-second ceiling, so `arena run`
 * is its own owned child: started and stopped only through process policy, bounded by the match
 * timeout, cancelled with its operation, and stopped by `close()` when the GUI shuts down.
 */
export class ArenaService {
	private runs = new Set<AbortController>();
	private settled = new Set<Promise<unknown>>();
	private closed = false;
	constructor(
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
		private readonly operations: OperationRegistry,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {}
	async list(workspaceId: string, signal?: AbortSignal): Promise<ArenaMatches> {
		const workspace = await this.workspaces.get(workspaceId);
		return checked(ArenaMatches, await this.runner.run({ kind: "arena.list" }, workspace.path, signal), "match list");
	}
	async show(workspaceId: string, matchId: string, signal?: AbortSignal): Promise<ArenaMatch> {
		const workspace = await this.workspaces.get(workspaceId);
		return checked(ArenaMatch, await this.runner.run({ kind: "arena.show", matchId }, workspace.path, signal), "match");
	}
	async standings(workspaceId: string, suite: string | undefined, signal?: AbortSignal): Promise<ArenaStandings> {
		const workspace = await this.workspaces.get(workspaceId);
		const command = suite ? { kind: "arena.standings" as const, suite } : { kind: "arena.standings" as const };
		return checked(ArenaStandings, await this.runner.run(command, workspace.path, signal), "standings");
	}
	async vote(workspaceId: string, matchId: string, request: ArenaVoteRequest): Promise<ArenaVote> {
		const workspace = await this.workspaces.get(workspaceId);
		try {
			const vote = await this.runner.run({ kind: "arena.vote", matchId, ...request }, workspace.path);
			return checked(ArenaVote, vote, "vote");
		} catch (error) {
			// The runner keeps no stderr, so the reasons `arena vote` exits 1 are named here.
			if (error instanceof AppProblem && /exit code 1\b/.test(error.message))
				throw new AppProblem(
					"conflict",
					request.replace
						? "Clio refused the vote: the match is missing, still running, or has fewer contenders than that label."
						: "Clio refused the vote: the match already has one (replace it explicitly), is still running, or has fewer contenders than that label.",
				);
			throw error;
		}
	}
	async start(workspaceId: string, request: ArenaStartRequest, key: string): Promise<string> {
		const workspace = await this.workspaces.get(workspaceId);
		if (this.closed) throw new AppProblem("unavailable", "The GUI is stopping; no new arena match starts.");
		return this.operations.create({
			kind: "arena.run",
			scope: workspaceId,
			key,
			fingerprint: fingerprint({ workspaceId, request }),
			cancellable: true,
			run: (progress, signal) => this.execute(workspace.path, request, progress, signal),
		});
	}
	private execute(
		cwd: string,
		request: ArenaStartRequest,
		progress: (message: string) => void,
		signal: AbortSignal,
	): Promise<ToolResult> {
		if (this.closed) return Promise.reject(new AppProblem("unavailable", "The GUI is stopping."));
		const controller = new AbortController();
		const forward = () => controller.abort();
		signal.addEventListener("abort", forward, { once: true });
		this.runs.add(controller);
		const job = this.spawn(cwd, request, progress, controller.signal).finally(() => {
			signal.removeEventListener("abort", forward);
			this.runs.delete(controller);
		});
		const settled = job.catch(() => undefined);
		this.settled.add(settled);
		void settled.finally(() => this.settled.delete(settled));
		return job;
	}
	private async spawn(
		cwd: string,
		request: ArenaStartRequest,
		progress: (message: string) => void,
		signal: AbortSignal,
	): Promise<ToolResult> {
		if (signal.aborted) throw new AppProblem("operation_failed", "Arena match was cancelled before it started.");
		const { child, birthToken } = await runClioCommand({ kind: "arena.run", request }, cwd, this.env);
		progress(`Clio is running ${request.contenders.length} contenders on one prompt.`);
		return new Promise((resolve, reject) => {
			let failure: Error | undefined;
			let matchId: string | undefined;
			let stdoutBytes = 0;
			const chunks: Buffer[] = [];
			let pending = "";
			let kill: NodeJS.Timeout | undefined;
			const alive = () => !!child.pid && child.exitCode === null && child.signalCode === null;
			const stop = (error: Error) => {
				failure ??= error;
				if (alive()) stopClioCommand(child, birthToken, "SIGTERM");
				kill ??= setTimeout(() => {
					if (alive()) stopClioCommand(child, birthToken, "SIGKILL");
				}, KILL_GRACE_MS);
			};
			const abort = () => stop(new AppProblem("operation_failed", "Arena match was cancelled."));
			const timer = setTimeout(
				() => stop(new AppProblem("operation_failed", "Arena match exceeded its time limit.")),
				request.timeoutSeconds * 1000 + SETTLE_MS,
			);
			signal.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > STDOUT_LIMIT) stop(new AppProblem("operation_failed", "Arena output exceeded 8 MiB."));
				else chunks.push(chunk);
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				pending = (pending + chunk).slice(-65_536);
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					const started = STARTED.exec(line);
					if (started?.[1]) matchId = started[1];
					if (line.startsWith("clio-coder arena: ")) progress(line.slice("clio-coder arena: ".length).slice(0, 2000));
				}
			});
			child.on("error", () => {
				failure ??= new AppProblem("operation_failed", "Arena run could not start.");
			});
			child.on("close", (code, termination) => {
				clearTimeout(timer);
				if (kill) clearTimeout(kill);
				signal.removeEventListener("abort", abort);
				if (failure) {
					reject(failure);
					return;
				}
				let match: ArenaMatch | undefined;
				try {
					const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
					const parsed: unknown = JSON.parse(decoded);
					if (Value.Check(ArenaMatch, parsed)) match = parsed;
				} catch {
					match = undefined;
				}
				// A failed match still exits 1 with its record, which stays viewable under its id.
				if (match && (code === 0 || code === 1)) {
					resolve({
						id: match.id,
						message:
							match.status === "complete"
								? `Match ${match.id} is ready for a blind vote.`
								: `Match ${match.id} ended ${match.status}${match.error ? `: ${match.error}` : ""}.`,
					});
					return;
				}
				reject(
					new AppProblem(
						"operation_failed",
						`Arena run exited with ${code === null ? `signal ${termination ?? "unknown"}` : `exit code ${code}`}${matchId ? ` (match ${matchId})` : ""}.`,
					),
				);
			});
			if (signal.aborted) abort();
		});
	}
	/** Stops every live match child and waits for it to settle, so shutdown leaves no orphan run. */
	async close() {
		this.closed = true;
		for (const controller of this.runs) controller.abort();
		await Promise.allSettled([...this.settled]);
	}
}
