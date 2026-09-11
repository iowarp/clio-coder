import { type CliCommand, commandPlan } from "../cli-commands.js";
import { runClioCommand, stopClioCommand } from "../process-policy.js";
import { AppProblem } from "./problem.js";

export class CliCancelled extends Error {}
export class CliRunner {
	private jobs = new Map<AbortController, Promise<unknown>>();
	private closed = false;
	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly timeoutMs = 60_000,
	) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
			throw new TypeError("CLI timeout must be 1–60000 ms.");
	}
	get activeCount() {
		return this.jobs.size;
	}
	run(command: CliCommand, cwd: string, signal?: AbortSignal): Promise<unknown> {
		const plan = commandPlan(command);
		if (this.closed || this.jobs.size >= 4)
			return Promise.reject(new AppProblem("unavailable", "CLI runner is full or stopping. Retry shortly."));
		if (signal?.aborted) return Promise.reject(new CliCancelled());
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const job = this.execute(command, cwd, plan.output, controller.signal).finally(() => {
			signal?.removeEventListener("abort", abort);
			this.jobs.delete(controller);
		});
		this.jobs.set(controller, job);
		return job;
	}
	private async execute(
		command: CliCommand,
		cwd: string,
		output: "json" | "exit",
		signal: AbortSignal,
	): Promise<unknown> {
		const { child, birthToken } = await runClioCommand(command, cwd, this.env);
		return new Promise((resolve, reject) => {
			let failure: Error | undefined;
			let stdoutBytes = 0,
				stderrBytes = 0;
			const chunks: Buffer[] = [];
			let kill: NodeJS.Timeout | undefined;
			const stop = (error: Error) => {
				failure ??= error;
				if (child.pid && child.exitCode === null && child.signalCode === null)
					stopClioCommand(child, birthToken, "SIGTERM");
				kill ??= setTimeout(() => {
					if (child.pid && child.exitCode === null && child.signalCode === null)
						stopClioCommand(child, birthToken, "SIGKILL");
				}, 1000);
			};
			const abort = () => stop(new CliCancelled());
			const timer = setTimeout(
				() => stop(new AppProblem("operation_failed", "CLI command exceeded its time limit.")),
				this.timeoutMs,
			);
			signal.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > 8 * 1024 * 1024) stop(new AppProblem("operation_failed", "CLI stdout exceeded 8 MiB."));
				else if (!failure && output === "json") chunks.push(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes > 256 * 1024) stop(new AppProblem("operation_failed", "CLI stderr exceeded 256 KiB."));
			});
			child.on("error", () => {
				failure ??= new AppProblem("operation_failed", "CLI process could not start.");
			});
			child.on("close", (code, termination) => {
				clearTimeout(timer);
				if (kill) clearTimeout(kill);
				signal.removeEventListener("abort", abort);
				if (failure) {
					reject(failure);
					return;
				}
				if (code !== 0) {
					reject(
						new AppProblem(
							"operation_failed",
							`CLI command exited with ${code === null ? `signal ${termination ?? "unknown"}` : `exit code ${code}`}.`,
						),
					);
					return;
				}
				if (output === "exit") {
					resolve({ exitCode: 0 });
					return;
				}
				try {
					resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
				} catch {
					reject(new AppProblem("operation_failed", "CLI command returned invalid UTF-8 or JSON."));
				}
			});
			if (signal.aborted) abort();
		});
	}
	async close() {
		this.closed = true;
		for (const controller of this.jobs.keys()) controller.abort();
		await Promise.allSettled(this.jobs.values());
	}
}
