/**
 * Declarative flag parsing for a CLI leaf (CLI conventions C4 and C5).
 *
 * - Every value flag accepts `--flag value` and `--flag=value`.
 * - A value flag never takes a token starting with `--` as its value unless the
 *   flag is declared free text (`run --verify`).
 * - A flag the leaf does not declare is an `unknown_flag` error, never ignored.
 * - `--` ends the flags; `-` alone is a positional (stdin by convention).
 *
 * Errors come back as values; the caller prints them with `writeCliFailure`.
 * Leaf of the CLI kit: imports only other kit modules.
 */
import { type DurationUnit, parseDuration } from "./duration.js";
import type { ErrorSlug } from "./slugs.js";

interface FlagBase {
	/** A one-letter alias such as `y` for `-y`. */
	readonly short?: string;
}

export type FlagDeclaration =
	| (FlagBase & { readonly kind: "boolean" })
	| (FlagBase & { readonly kind: "value"; readonly freeText?: boolean; readonly repeatable?: boolean })
	| (FlagBase & { readonly kind: "duration"; readonly bareUnit: DurationUnit; readonly allowZero?: boolean });

/** Declarations keyed by long name without dashes: `{ json: { kind: "boolean" } }` declares `--json`. */
export type FlagDeclarations = Readonly<Record<string, FlagDeclaration>>;

type FlagValue<F extends FlagDeclaration> = F extends { readonly kind: "boolean" }
	? boolean
	: F extends { readonly kind: "duration" }
		? number
		: F extends { readonly repeatable: true }
			? string[]
			: string;

/** Parsed values keyed like the declarations; an absent flag is absent. Durations are whole milliseconds. */
export type FlagValues<D extends FlagDeclarations> = { [K in keyof D]?: FlagValue<D[K]> };

export type FlagParseResult<D extends FlagDeclarations> =
	| { readonly ok: true; readonly flags: FlagValues<D>; readonly positional: string[] }
	| { readonly ok: false; readonly slug: ErrorSlug; readonly message: string };

export function parseCommandFlags<const D extends FlagDeclarations>(
	argv: ReadonlyArray<string>,
	declarations: D,
): FlagParseResult<D> {
	const values: Record<string, boolean | number | string | string[]> = {};
	const positional: string[] = [];
	const byShort = new Map<string, string>();
	for (const [name, declaration] of Object.entries(declarations)) {
		if (declaration.short !== undefined) byShort.set(declaration.short, name);
	}
	const usage = (message: string): FlagParseResult<D> => ({ ok: false, slug: "usage", message });

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] as string;
		if (token === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (token === "-" || !token.startsWith("-")) {
			positional.push(token);
			continue;
		}
		const isLong = token.startsWith("--");
		const equals = isLong ? token.indexOf("=") : -1;
		const spelled = equals === -1 ? token : token.slice(0, equals);
		const name = isLong ? spelled.slice(2) : byShort.get(spelled.slice(1));
		const declaration = name === undefined ? undefined : declarations[name];
		if (name === undefined || declaration === undefined) {
			return { ok: false, slug: "unknown_flag", message: `unknown flag: ${spelled}` };
		}
		if (declaration.kind === "boolean") {
			if (equals !== -1) return usage(`${spelled} takes no value`);
			values[name] = true;
			continue;
		}
		let raw: string;
		if (equals !== -1) raw = token.slice(equals + 1);
		else {
			const next = argv[i + 1];
			const freeText = declaration.kind === "value" && declaration.freeText === true;
			if (next === undefined || (next.startsWith("--") && !freeText)) return usage(`${spelled} requires a value`);
			raw = next;
			i += 1;
		}
		const repeatable = declaration.kind === "value" && declaration.repeatable === true;
		const previous = values[name];
		if (previous !== undefined && !repeatable) return usage(`${spelled} given more than once`);
		if (declaration.kind === "duration") {
			const duration = parseDuration(raw, {
				bareUnit: declaration.bareUnit,
				...(declaration.allowZero !== undefined ? { allowZero: declaration.allowZero } : {}),
			});
			if (!duration.ok) return usage(`${spelled}: ${duration.message}`);
			values[name] = duration.ms;
		} else if (repeatable) {
			values[name] = [...(Array.isArray(previous) ? previous : []), raw];
		} else {
			values[name] = raw;
		}
	}
	return { ok: true, flags: values as FlagValues<D>, positional };
}
