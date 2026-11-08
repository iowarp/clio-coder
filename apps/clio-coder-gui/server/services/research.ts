import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	ResearchCampaign,
	type ResearchCampaignSummary,
	type ResearchCampaigns,
	ResearchCliList,
	ResearchReport,
	type ResearchStartRequest,
} from "../../contracts/research.js";
import { renderUsdLimit, renderUsdSpend } from "../clio/http-shims.js";
import { runClioCommand, stopClioCommand } from "../process-policy.js";
import type { CliRunner } from "./cli-runner.js";
import { fingerprint, type OperationRegistry } from "./operations.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

/** A campaign without a wall cap is still bounded here; past it the GUI stops the campaign like Ctrl-C would. */
const DEFAULT_CEILING_MINUTES = 12 * 60;
/** Past the wall cap the CLI still finishes the iteration it is grading, journals and removes worktrees. */
const SETTLE_MS = 5 * 60_000;
/** A stopped `research start` archives the iteration `interrupted` and cleans up; SIGKILL comes only if that stalls. */
const KILL_GRACE_MS = 15_000;
const STDOUT_LIMIT = 8 * 1024 * 1024;
const LINE = /^research (r[0-9]{8}-[0-9]{6}-[0-9a-f]{4}): (.*)$/;

type ToolResult = { id: string; message: string };

function checked<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	if (!Value.Check(schema, value))
		throw new AppProblem("operation_failed", `Clio returned an invalid research ${what}.`);
	return value as Static<T>;
}

/** The list row the page needs, newest first; a campaign whose files cannot be read keeps its id and the reason. */
/** The view's money in the words `research status` prints, rendered by Clio's canonical renderer. */
export function withDisplay<T extends ResearchCampaign | ResearchReport>(view: T): T {
	const { spend } = view;
	const known = renderUsdSpend(spend.usd, { estimated: spend.estimated, unpriced: spend.unknownRuns > 0 });
	const { maxCostUsd } = view.campaign.budget;
	return {
		...view,
		display: {
			spend:
				spend.unknownRuns > 0
					? `${known}; ${spend.unknownRuns} ${spend.unknownRuns === 1 ? "run" : "runs"} had unknown spend`
					: known,
			...(maxCostUsd !== undefined ? { cap: renderUsdLimit(maxCostUsd) } : {}),
			costs: view.iterations.map(({ cost }) =>
				cost === null
					? "not recorded"
					: cost.kind === "free" || cost.kind === "unknown"
						? cost.kind
						: renderUsdSpend(cost.usd, { estimated: cost.kind === "estimated", unpriced: false }),
			),
		},
	};
}

export function summarizeCampaigns(list: ResearchCliList): ResearchCampaigns {
	const campaigns: ResearchCampaignSummary[] = list.campaigns.map((entry) =>
		"error" in entry
			? { id: entry.id, error: entry.error }
			: {
					id: entry.id,
					createdAt: entry.campaign.createdAt,
					state: entry.state,
					objective: {
						check: entry.campaign.objective.check,
						metric: entry.campaign.objective.metric,
						direction: entry.campaign.objective.direction,
					},
					stop: entry.stop?.reason ?? null,
					iterations: entry.iterations.length,
					ratchets: entry.ratchets,
				},
	);
	return { campaigns: campaigns.reverse() };
}

/**
 * Reads go through the shared CLI runner. A campaign runs for minutes to hours, so `research start` is its own owned
 * child: started and stopped only through process policy, bounded by the campaign's wall cap, cancelled with its
 * operation (SIGTERM, which the CLI turns into a journaled `stopped` with worktrees removed), and stopped by `close()`
 * when the GUI shuts down.
 */
export class ResearchService {
	private runs = new Set<AbortController>();
	/** One campaign per workspace: concurrent benchmarks in one repository distort each other's measurements. */
	private active = new Map<string, { operationId: string; key: string }>();
	private settled = new Set<Promise<unknown>>();
	private closed = false;
	constructor(
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
		private readonly operations: OperationRegistry,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {}
	async list(workspaceId: string, signal?: AbortSignal): Promise<ResearchCampaigns> {
		const workspace = await this.workspaces.get(workspaceId);
		const list = checked(
			ResearchCliList,
			await this.runner.run({ kind: "research.list" }, workspace.path, signal),
			"list",
		);
		const running = this.active.get(workspaceId);
		return { ...summarizeCampaigns(list), ...(running ? { runningOperationId: running.operationId } : {}) };
	}
	async status(workspaceId: string, id: string, signal?: AbortSignal): Promise<ResearchCampaign> {
		const workspace = await this.workspaces.get(workspaceId);
		try {
			const view = await this.runner.run({ kind: "research.status", id }, workspace.path, signal);
			return withDisplay(checked(ResearchCampaign, view, "campaign"));
		} catch (error) {
			throw missing(error, id);
		}
	}
	/** Regrades every measurement from its raw samples; a disagreement is a result, not a failure. */
	async report(workspaceId: string, id: string, signal?: AbortSignal): Promise<ResearchReport> {
		const workspace = await this.workspaces.get(workspaceId);
		try {
			const report = await this.runner.run({ kind: "research.report", id }, workspace.path, signal);
			return withDisplay(checked(ResearchReport, report, "report"));
		} catch (error) {
			throw missing(error, id);
		}
	}
	async start(workspaceId: string, request: ResearchStartRequest, key: string): Promise<string> {
		const workspace = await this.workspaces.get(workspaceId);
		if (this.closed) throw new AppProblem("unavailable", "The GUI is stopping; no new research campaign starts.");
		const running = this.active.get(workspaceId);
		// A replay of the running start's own key still resolves to its operation through the registry.
		if (running && running.key !== key)
			throw new AppProblem(
				"conflict",
				"A research campaign is already running in this workspace; stop it before starting another.",
			);
		let operationId = "";
		operationId = this.operations.create({
			kind: "research.start",
			scope: workspaceId,
			key,
			fingerprint: fingerprint({ workspaceId, request }),
			cancellable: true,
			run: (progress, signal) =>
				this.execute(workspace.path, request, progress, signal).finally(() => {
					if (this.active.get(workspaceId)?.operationId === operationId) this.active.delete(workspaceId);
				}),
		});
		if (!running) this.active.set(workspaceId, { operationId, key });
		return operationId;
	}
	private execute(
		cwd: string,
		request: ResearchStartRequest,
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
		request: ResearchStartRequest,
		progress: (message: string) => void,
		signal: AbortSignal,
	): Promise<ToolResult> {
		if (signal.aborted) throw new AppProblem("operation_failed", "Research campaign was cancelled before it started.");
		const { child, birthToken } = await runClioCommand({ kind: "research.start", request }, cwd, this.env);
		progress(`Clio is opening a campaign on ${request.check}/${request.metric}.`);
		return new Promise((resolve, reject) => {
			let failure: Error | undefined;
			let campaignId: string | undefined;
			let stdoutBytes = 0;
			const chunks: Buffer[] = [];
			let pending = "";
			let lastError = "";
			let kill: NodeJS.Timeout | undefined;
			const alive = () => !!child.pid && child.exitCode === null && child.signalCode === null;
			const stop = (error: Error) => {
				failure ??= error;
				if (alive()) stopClioCommand(child, birthToken, "SIGTERM");
				kill ??= setTimeout(() => {
					if (alive()) stopClioCommand(child, birthToken, "SIGKILL");
				}, KILL_GRACE_MS);
			};
			const abort = () => stop(new AppProblem("operation_failed", "Research campaign was cancelled."));
			const timer = setTimeout(
				() => stop(new AppProblem("operation_failed", "Research campaign exceeded its time limit.")),
				(request.maxWallMinutes ?? DEFAULT_CEILING_MINUTES) * 60_000 + SETTLE_MS,
			);
			signal.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > STDOUT_LIMIT) stop(new AppProblem("operation_failed", "Research output exceeded 8 MiB."));
				else chunks.push(chunk);
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				pending = (pending + chunk).slice(-65_536);
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) {
					const match = LINE.exec(line);
					if (match?.[1]) {
						campaignId ??= match[1];
						progress(line.slice(0, 2000));
					} else if (line.trim()) lastError = line.trim().slice(0, 500);
				}
			});
			child.on("error", () => {
				failure ??= new AppProblem("operation_failed", "Research campaign could not start.");
			});
			child.on("close", (code, termination) => {
				clearTimeout(timer);
				if (kill) clearTimeout(kill);
				signal.removeEventListener("abort", abort);
				if (failure) {
					reject(campaignId ? new AppProblem("operation_failed", `${failure.message} (campaign ${campaignId})`) : failure);
					return;
				}
				let view: ResearchCampaign | undefined;
				try {
					const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
					if (Value.Check(ResearchCampaign, parsed)) view = parsed;
				} catch {
					view = undefined;
				}
				// A campaign that stopped noisy, on unenforceable spend or on an error exits 1 with its record.
				if (view && (code === 0 || code === 1)) {
					resolve({
						id: view.id,
						message: `Campaign ${view.id} stopped${view.stop ? ` (${view.stop.reason}: ${view.stop.detail})` : ""} with ${view.ratchets} ${view.ratchets === 1 ? "ratchet" : "ratchets"}.`,
					});
					return;
				}
				reject(
					new AppProblem(
						"operation_failed",
						`Research campaign exited with ${code === null ? `signal ${termination ?? "unknown"}` : `exit code ${code}`}${campaignId ? ` (campaign ${campaignId})` : ""}${lastError ? `: ${lastError}` : "."}`,
					),
				);
			});
			if (signal.aborted) abort();
		});
	}
	/** Stops every live campaign child and waits for it to settle, so shutdown leaves no orphan run or worktree. */
	async close() {
		this.closed = true;
		for (const controller of this.runs) controller.abort();
		await Promise.allSettled([...this.settled]);
	}
}

/** The runner keeps no stderr, so the usual reason `research status|report` fails is named here. */
function missing(error: unknown, id: string): unknown {
	if (error instanceof AppProblem && /exit code 1\b|invalid UTF-8 or JSON/.test(error.message))
		return new AppProblem("not_found", `Clio could not read research campaign ${id} in this workspace.`);
	return error;
}
