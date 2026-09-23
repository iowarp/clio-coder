import type { CommandCatalog, CommandDescriptor, CommandRequest } from "../../contracts/steering.js";

/** Only the engine's advertised commands can be selected; no slash line is sent to the model. */
export function commandOptions(catalog: CommandCatalog | undefined): readonly CommandDescriptor[] {
	return catalog?.commands ?? [];
}

export type CommandFields = Readonly<Record<string, string | boolean>>;
export type CommandPlan = { readonly request: CommandRequest; readonly description: string };
export type CommandPlanResult =
	| { readonly plan: CommandPlan; readonly error?: never }
	| { readonly error: string; readonly plan?: never };

const invalid = (error: string): CommandPlanResult => ({ error });
const fieldValue = (fields: CommandFields, key: string): string => {
	const value = fields[key];
	return typeof value === "string" ? value.trim() : "";
};

/** The ACP command bridge joins argv without quoting. Only a final rest field can contain spaces. */
function validToken(value: string, rest: boolean): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: reject command-line control characters at the browser edge.
	return value !== "" && !/[\u0000-\u001f\u007f"']/u.test(value) && (rest || !/\s/u.test(value));
}

export function planCommand(command: CommandDescriptor, fields: CommandFields): CommandPlanResult {
	const subcommands = command.args.subcommands;
	const selected = fieldValue(fields, "subcommand");
	if (command.requiresSubcommand && (!subcommands || !Object.hasOwn(subcommands, selected)))
		return invalid("Choose an available action first.");
	if (selected && (!subcommands || !Object.hasOwn(subcommands, selected)))
		return invalid("This action is not available.");
	const args = selected ? subcommands?.[selected] : command.args;
	if (!args) return invalid("This action is not available.");
	const argv: string[] = selected ? [selected] : [];
	const flags: string[] = [];
	for (const flag of args.flags ?? []) {
		const raw = fields[`flag:${flag.name}`];
		if (!flag.takesValue) {
			if (raw === true) flags.push(flag.name);
			continue;
		}
		const values = flag.repeatable
			? fieldValue(fields, `flag:${flag.name}`)
					.split("\n")
					.map((v) => v.trim())
					.filter(Boolean)
			: [fieldValue(fields, `flag:${flag.name}`)];
		for (const value of values) {
			if (!value) continue;
			if (!validToken(value, false) || value.startsWith("--") || new TextEncoder().encode(value).length > 4096)
				return invalid(`${flag.name} needs a single value without quotes, whitespace or control characters.`);
			if (flag.values && !flag.values.includes(value)) return invalid(`Choose a listed value for ${flag.name}.`);
			flags.push(flag.name, value);
		}
	}
	argv.push(...flags);
	let skipped = false;
	for (const [index, positional] of (args.positionals ?? []).entries()) {
		const value = fieldValue(fields, `pos:${index}`);
		if (!value) {
			if (positional.required) return invalid(`${positional.name} is required.`);
			skipped = true;
			continue;
		}
		if (skipped) return invalid("Fill earlier fields before later ones.");
		if (positional.rest && index !== (args.positionals?.length ?? 0) - 1)
			return invalid("The command grammar has a non-final text field.");
		if (
			!validToken(value, positional.rest === true) ||
			value.startsWith("--") ||
			new TextEncoder().encode(value).length > 4096
		)
			return invalid(`${positional.name} cannot contain quotes, control characters or unexpected spaces.`);
		if (positional.values && !positional.values.includes(value)) return invalid(`Choose a listed ${positional.name}.`);
		argv.push(value);
	}
	if (argv.length > 32) return invalid("This request has too many arguments (32 maximum).");
	return {
		plan: {
			request: { command: command.name, argv },
			description: `/${command.name}${argv.length ? ` ${argv.join(" ")}` : ""}`,
		},
	};
}
