import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { Id } from "../contracts/common.js";
import { AppProblem } from "./services/problem.js";

const closed = { additionalProperties: false };
export const CliCommand = Type.Union([
	Type.Object({ kind: Type.Literal("evidence.build"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("receipt.verify"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.list") }, closed),
	Type.Object({ kind: Type.Literal("targets.probe"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.use"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("targets.remove"), id: Id }, closed),
	Type.Object({ kind: Type.Literal("routing.models") }, closed),
	Type.Object({ kind: Type.Literal("routing.profiles") }, closed),
	Type.Object({ kind: Type.Literal("routing.bindings") }, closed),
]);
export type CliCommand = Static<typeof CliCommand>;
/** The only admitted CLI argv. There is no generic command or extra-arguments escape hatch. */
export function commandPlan(input: unknown): { argv: string[]; output: "json" | "exit" } {
	if (!Value.Check(CliCommand, input))
		throw new AppProblem("validation", "CLI command is outside the supported command table.");
	switch (input.kind) {
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
		case "routing.models":
			return { argv: ["models", "--json", "--offline"], output: "json" };
		case "routing.profiles":
			return { argv: ["targets", "profile", "list", "--json"], output: "json" };
		case "routing.bindings":
			return { argv: ["targets", "profile", "bindings", "--json"], output: "json" };
	}
}
