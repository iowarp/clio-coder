/**
 * Live reconnaissance eval: the two behaviors only a real model can show.
 *
 * L1 stale-wiki. A workspace whose codewiki was indexed before the answer
 * changed. Passes iff the model performs a live source read after its
 * `code_nav mode=wiki` lookup (`wiki.staleAcknowledged`), instead of
 * answering from the stale wiki alone.
 *
 * L2 Scout routing. A natural "orient me" request against a temporary copy of
 * this repository. Passes iff the main model dispatches Scout rather than
 * doing repo-wide reads itself (`dispatch.scoutCount >= 1`).
 *
 * Both run through `clio-coder eval run --suite`, so the suite, its metrics,
 * the per-item state isolation, and the cost ceiling are the product's own.
 * This driver only seeds the stale-wiki fixture, which needs `context refresh`
 * at the old commit before the source moves on.
 *
 *   npm run live:recon -- --target <id> [--model <id>] [--thinking <level>] [--max-cost-usd 0.50] [--keep]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import {
	CLI_ENTRY,
	clio,
	LiveUsageError,
	parseLiveArgs,
	REPO_ROOT,
	rejectUnknown,
	requireBuild,
	runDriver,
	takeFlag,
	withLiveHome,
} from "./live-target.js";

const USAGE = `usage: npm run live:recon -- --target <id> [--model <wireId>] [--thinking <level>] [--max-cost-usd <usd>] [--keep]

Runs the stale-wiki and Scout-routing scenarios through clio-coder eval against a
configured target. Needs dist/ (npm run build). Default cost ceiling is $0.50.
`;

function seedStaleWiki(root: string, env: NodeJS.ProcessEnv): string {
	const dir = mkdtempSync(join(root, "stale-wiki-"));
	const git = (args: string[]): void => {
		execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	};
	const answer = (value: string): void => {
		writeFileSync(
			join(dir, "src", "answer.js"),
			`/** Source of truth for the live stale-wiki scenario. */\nexport function currentAnswer() {\n\treturn "${value}";\n}\n`,
		);
	};
	git(["init", "--quiet"]);
	git(["config", "user.email", "eval@clio.local"]);
	git(["config", "user.name", "Clio Live Eval"]);
	mkdirSync(join(dir, "src"), { recursive: true });
	answer("OLD-ANSWER");
	writeFileSync(join(dir, "README.md"), "# stale-wiki fixture\n\nsrc/answer.js holds currentAnswer().\n");
	git(["add", "-A"]);
	git(["commit", "--quiet", "-m", "seed: old answer"]);
	// Index the codewiki at the old state (offline, no model), then move on.
	execFileSync(process.execPath, [CLI_ENTRY, "context", "refresh"], { cwd: dir, env, stdio: "pipe" });
	answer("NEW-ANSWER");
	git(["add", "-A"]);
	git(["commit", "--quiet", "-m", "change: new answer after wiki indexing"]);
	return dir;
}

await runDriver(USAGE, async () => {
	requireBuild();
	const args = parseLiveArgs(process.argv.slice(2));
	const maxCostUsd = Number.parseFloat(takeFlag(args.rest, "--max-cost-usd") ?? "0.50");
	if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new LiveUsageError("--max-cost-usd must be positive");
	rejectUnknown(args.rest);

	return withLiveHome(args, { prefix: "clio-live-recon-", autonomy: "full-auto" }, async (home) => {
		process.stdout.write(
			`live recon: target=${home.target.id} model=${home.model} thinking=${home.thinking} maxCostUsd=${maxCostUsd}\n`,
		);
		try {
			// Under home.dir, so the home's cleanup owns it whatever happens below.
			const staleWikiDir = seedStaleWiki(home.dir, home.env);
			const suite = {
				version: 2,
				suite: {
					id: "recon-live",
					title: "Bounded reconnaissance live suite",
					visibility: "local",
					description: "L1 stale-wiki grounding and L2 proactive Scout routing; operator-run, cost-bounded.",
				},
				matrix: { targets: [{ id: home.target.id, model: home.model }], repeats: 1, maxCostUsd },
				tasks: [
					{
						id: "stale-wiki",
						tags: ["live", "recon"],
						workspace: { kind: "local", path: staleWikiDir },
						runner: {
							kind: "clio-run",
							prompt:
								"Orient with code_nav mode=wiki first, then answer: what exact string does currentAnswer() in src/answer.js return?",
						},
						verify: { assertions: [{ metric: "wiki.staleAcknowledged", op: "eq", value: true }] },
						metrics: { collect: ["wiki.staleAcknowledged", "tools.totalCalls", "tokens.total", "cost.usd"] },
						timeoutMs: 120_000,
					},
					{
						id: "scout-routing",
						tags: ["live", "recon"],
						workspace: {
							kind: "temp-copy",
							path: REPO_ROOT,
							excludes: ["node_modules", "dist", ".git", ".clio-coder", ".superpowers", "coverage"],
						},
						runner: {
							kind: "clio-run",
							prompt:
								"Let's just explore this repo and context. Give me a concise orientation to its structure and key entry points.",
						},
						verify: {
							assertions: [
								{ metric: "dispatch.count", op: "gte", value: 1 },
								{ metric: "dispatch.scoutCount", op: "gte", value: 1 },
							],
						},
						metrics: { collect: ["dispatch.count", "dispatch.scoutCount", "tools.totalCalls", "tokens.total", "cost.usd"] },
						timeoutMs: 180_000,
					},
				],
			};
			const suitePath = join(home.dir, "recon-live.yaml");
			writeFileSync(suitePath, stringify(suite), "utf8");

			const startedAt = Date.now();
			const run = await clio(home, ["eval", "run", "--suite", suitePath, "--clio-coder-entry", CLI_ENTRY], {
				timeoutMs: 420_000,
			});
			process.stdout.write(home.redact(run.stdout));
			if (run.stderr.trim()) process.stderr.write(home.redact(run.stderr));

			const evalId = /eval: (eval-\S+)/.exec(run.stdout)?.[1];
			if (evalId) {
				const report = await clio(home, ["eval", "report", evalId, "--format", "json"], { timeoutMs: 60_000 });
				const artifact = JSON.parse(report.stdout) as {
					results?: Array<{
						taskId: string;
						pass: boolean;
						failureClass?: string | null;
						metrics?: Record<string, unknown>;
					}>;
				};
				let totalCost = 0;
				for (const result of artifact.results ?? []) {
					const cost = typeof result.metrics?.["cost.usd"] === "number" ? (result.metrics["cost.usd"] as number) : 0;
					totalCost += cost;
					process.stdout.write(
						`[recon-live] ${result.taskId}: pass=${result.pass} failureClass=${result.failureClass ?? "none"} ` +
							`staleAcknowledged=${String(result.metrics?.["wiki.staleAcknowledged"] ?? "n/a")} ` +
							`dispatchCount=${String(result.metrics?.["dispatch.count"] ?? "n/a")} ` +
							`scoutCount=${String(result.metrics?.["dispatch.scoutCount"] ?? "n/a")} costUsd=${cost}\n`,
					);
				}
				process.stdout.write(
					`[recon-live] duration=${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
						`totalKnownCostUsd=$${totalCost.toFixed(4)} ceiling=$${maxCostUsd} ` +
						`artifact=${join(home.dataDir, "evals", `${evalId}.json`)}\n`,
				);
			}
			return run.code === 0;
		} catch (error) {
			process.stderr.write(`live recon: FAIL: ${home.redact(error instanceof Error ? error.message : String(error))}\n`);
			return false;
		}
	});
});
