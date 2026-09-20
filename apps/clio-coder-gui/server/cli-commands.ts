import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { Id } from "../contracts/common.js";
import { AppProblem } from "./services/problem.js";

const closed = { additionalProperties: false };
export const CliCommand = Type.Union([
	Type.Object({ kind: Type.Literal("library.agents") }, closed),
	Type.Object({ kind: Type.Literal("library.verifiers") }, closed),
	Type.Object({ kind: Type.Literal("usage.report") }, closed),
	Type.Object({ kind: Type.Literal("evidence.build"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("receipt.verify"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.list") }, closed),
	Type.Object({ kind: Type.Literal("targets.probe"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.use"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.remove"), id: Id }, closed),
	Type.Object(
		{
			kind: Type.Literal("targets.add"),
			id: Id,
			runtime: Id,
			url: Type.Optional(Type.String({ maxLength: 2048, pattern: "^(https?|wss?)://[^\\s]+$" })),
			model: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$" })),
			apiKeyEnv: Type.Optional(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" })),
			useForChat: Type.Optional(Type.Boolean()),
		},
		closed,
	),
	Type.Object({ kind: Type.Literal("routing.models") }, closed),
	Type.Object({ kind: Type.Literal("routing.profiles") }, closed),
	Type.Object({ kind: Type.Literal("routing.bindings") }, closed),
]);
export type CliCommand = Static<typeof CliCommand>;
/** The only admitted CLI argv. There is no generic command or extra-arguments escape hatch. */
export function commandPlan(
	input: unknown,
	cwd?: string,
): { argv: string[]; output: "json" | "jsonl" | "exit"; explain?: true } {
	if (!Value.Check(CliCommand, input))
		throw new AppProblem("validation", "CLI command is outside the supported command table.");
	switch (input.kind) {
		case "library.agents":
			return { argv: ["agents", "--json"], output: "json" };
		case "library.verifiers":
			return { argv: ["verifiers", "inspect", "--json"], output: "json" };
		case "usage.report":
			if (!cwd) throw new AppProblem("validation", "A canonical workspace is required for usage.");
			return { argv: ["usage", "report", "--repo", cwd, "--days", "30", "--json"], output: "jsonl" };
		case "evidence.build":
			return { argv: ["evidence", "build", "--run", input.id], output: "exit" };
		case "receipt.verify":
			return { argv: ["fleet", "verify", input.id, "--json"], output: "json" };
		case "targets.list":
			return { argv: ["targets", "--json"], output: "json" };
		case "targets.probe":
			return { argv: ["targets", "--json", "--probe", "--target", input.id], output: "json" };
		case "targets.use":
			return { argv: ["targets", "use", input.id], output: "exit" };
		case "targets.remove":
			return { argv: ["targets", "remove", input.id], output: "exit" };
		case "targets.add":
			// No credential flag exists here on purpose: a key never travels through the browser or an argv.
			return {
				argv: [
					"configure",
					"--id",
					input.id,
					"--runtime",
					input.runtime,
					...(input.url ? ["--url", input.url] : []),
					...(input.model ? ["--model", input.model] : []),
					...(input.apiKeyEnv ? ["--api-key-env", input.apiKeyEnv] : []),
					...(input.useForChat ? ["--set-orchestrator"] : []),
				],
				output: "exit",
				explain: true,
			};
		case "routing.models":
			return { argv: ["models", "--json", "--offline"], output: "json" };
		case "routing.profiles":
			return { argv: ["targets", "profile", "list", "--json"], output: "json" };
		case "routing.bindings":
			return { argv: ["targets", "profile", "bindings", "--json"], output: "json" };
	}
}
