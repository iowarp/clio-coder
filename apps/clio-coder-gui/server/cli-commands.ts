import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ArenaChoice, ArenaMatchId, ArenaNote, ArenaStartRequest } from "../contracts/arena.js";
import { Id } from "../contracts/common.js";
import { MachineAdd, MachineId } from "../contracts/machines.js";
import { ResearchCampaignId, ResearchStartRequest } from "../contracts/research.js";
import { AppProblem } from "./services/problem.js";

const closed = { additionalProperties: false };
export const CliCommand = Type.Union([
	Type.Object({ kind: Type.Literal("machines.list") }, closed),
	Type.Object({ kind: Type.Literal("machines.add"), machine: MachineAdd }, closed),
	Type.Object({ kind: Type.Literal("machines.remove"), id: MachineId }, closed),
	Type.Object({ kind: Type.Literal("machines.check"), id: MachineId }, closed),
	Type.Object({ kind: Type.Literal("library.agents") }, closed),
	Type.Object({ kind: Type.Literal("library.verifiers") }, closed),
	Type.Object({ kind: Type.Literal("usage.report") }, closed),
	Type.Object({ kind: Type.Literal("run.verify"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.list") }, closed),
	Type.Object({ kind: Type.Literal("targets.probe"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.use"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.remove"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.signout"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("routing.models") }, closed),
	Type.Object({ kind: Type.Literal("routing.profiles") }, closed),
	Type.Object({ kind: Type.Literal("routing.bindings") }, closed),
	Type.Object({ kind: Type.Literal("arena.list") }, closed),
	Type.Object({ kind: Type.Literal("arena.standings"), suite: Type.Optional(Id) }, closed),
	Type.Object({ kind: Type.Literal("arena.show"), matchId: ArenaMatchId }, closed),
	Type.Object(
		{
			kind: Type.Literal("arena.vote"),
			matchId: ArenaMatchId,
			choice: ArenaChoice,
			note: Type.Optional(ArenaNote),
			replace: Type.Boolean(),
		},
		closed,
	),
	Type.Object({ kind: Type.Literal("arena.run"), request: ArenaStartRequest }, closed),
	Type.Object({ kind: Type.Literal("research.list") }, closed),
	Type.Object({ kind: Type.Literal("research.status"), id: ResearchCampaignId }, closed),
	Type.Object({ kind: Type.Literal("research.report"), id: ResearchCampaignId }, closed),
	Type.Object({ kind: Type.Literal("research.start"), request: ResearchStartRequest }, closed),
]);
export type CliCommand = Static<typeof CliCommand>;
/** The only admitted CLI argv. There is no generic command or extra-arguments escape hatch. */
export function commandPlan(input: unknown, cwd?: string): { argv: string[]; output: "json" | "exit" } {
	if (!Value.Check(CliCommand, input))
		throw new AppProblem("validation", "CLI command is outside the supported command table.");
	switch (input.kind) {
		case "machines.list":
			return { argv: ["fleet", "nodes", "list", "--json"], output: "json" };
		case "machines.add": {
			const node = input.machine;
			return {
				argv: [
					"fleet",
					"nodes",
					"add",
					node.id,
					"--host",
					node.host,
					"--max-workers",
					String(node.maxWorkers),
					...(node.user ? ["--user", node.user] : []),
					...(node.port !== undefined ? ["--port", String(node.port)] : []),
					...(node.labels.length ? ["--labels", node.labels.join(",")] : []),
				],
				output: "exit",
			};
		}
		case "machines.remove":
			return { argv: ["fleet", "nodes", "remove", input.id], output: "exit" };
		case "machines.check":
			return { argv: ["fleet", "nodes", "test", input.id, "--record", "--json"], output: "json" };
		case "library.agents":
			return { argv: ["agents", "--json"], output: "json" };
		case "library.verifiers":
			return { argv: ["verifiers", "inspect", "--json"], output: "json" };
		case "usage.report":
			if (!cwd) throw new AppProblem("validation", "A canonical workspace is required for usage.");
			return { argv: ["usage", "report", "--repo", cwd, "--days", "30", "--json"], output: "json" };
		case "run.verify":
			return { argv: ["fleet", "verify", input.id, "--json"], output: "json" };
		case "targets.list":
			return { argv: ["targets", "--json"], output: "json" };
		case "targets.probe":
			return { argv: ["targets", "--json", "--probe", "--target", input.id], output: "json" };
		case "targets.use":
			return { argv: ["targets", "use", input.id], output: "exit" };
		case "targets.remove":
			return { argv: ["targets", "remove", input.id], output: "exit" };
		case "targets.signout":
			return { argv: ["auth", "logout", input.id], output: "exit" };
		case "routing.models":
			return { argv: ["models", "--json", "--offline"], output: "json" };
		case "routing.profiles":
			return { argv: ["targets", "profile", "list", "--json"], output: "json" };
		case "routing.bindings":
			return { argv: ["targets", "profile", "bindings", "--json"], output: "json" };
		case "arena.list":
			return { argv: ["arena", "list", "--json"], output: "json" };
		case "arena.standings":
			return { argv: ["arena", "standings", "--json", ...(input.suite ? ["--suite", input.suite] : [])], output: "json" };
		case "arena.show":
			return { argv: ["arena", "show", input.matchId, "--json"], output: "json" };
		case "arena.vote":
			return {
				argv: [
					"arena",
					"vote",
					input.matchId,
					input.choice,
					"--json",
					...(input.note ? ["--note", input.note] : []),
					...(input.replace ? ["--replace"] : []),
				],
				output: "json",
			};
		case "arena.run": {
			const request = input.request;
			// The prompt follows "--", so text that starts with a dash can never read as an option.
			return {
				argv: [
					"arena",
					"run",
					"--json",
					"--timeout",
					String(request.timeoutSeconds),
					...request.contenders.flatMap((contender) => ["--contender", `${contender.target}/${contender.model}`]),
					...(request.suite ? ["--suite", request.suite] : []),
					...(request.check ? ["--check", request.check] : []),
					"--",
					request.prompt,
				],
				output: "json",
			};
		}
		case "research.list":
			return { argv: ["research", "list", "--json"], output: "json" };
		case "research.status":
			return { argv: ["research", "status", input.id, "--json"], output: "json" };
		case "research.report":
			return { argv: ["research", "report", input.id, "--json"], output: "json" };
		case "research.start": {
			const request = input.request;
			// Every value follows its own option; the contract keeps scope globs and the goal from starting with a dash.
			return {
				argv: [
					"research",
					"start",
					"--json",
					"--check",
					request.check,
					"--metric",
					request.metric,
					"--direction",
					request.direction,
					"--max-iterations",
					String(request.maxIterations),
					...(request.minImprovement !== undefined ? ["--min-improvement", String(request.minImprovement)] : []),
					...(request.trials !== undefined ? ["--trials", String(request.trials)] : []),
					...request.gates.flatMap((gate) => ["--gate", gate]),
					...request.scope.flatMap((glob) => ["--scope", glob]),
					...(request.maxWallMinutes !== undefined ? ["--max-wall-minutes", String(request.maxWallMinutes)] : []),
					...(request.maxCostUsd !== undefined ? ["--max-cost-usd", String(request.maxCostUsd)] : []),
					...(request.allowUnpriced ? ["--allow-unpriced"] : []),
					...(request.goal ? ["--goal", request.goal] : []),
					...(request.target ? ["--target", request.target] : []),
					...(request.model ? ["--model", request.model] : []),
				],
				output: "json",
			};
		}
	}
}
