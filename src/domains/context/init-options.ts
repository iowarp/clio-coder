import type { RunBootstrapInput } from "./bootstrap.js";

export interface ContextInitOptions {
	preview?: boolean;
	adopt?: boolean;
	applyClioMd?: boolean;
	rewriteClioMd?: boolean;
	proposeClioMd?: boolean;
	includeGlobalImports?: boolean;
	heuristic?: boolean;
}

export interface ContextInitFlag {
	flag: string;
	aliases?: ReadonlyArray<string>;
	field: keyof ContextInitOptions;
}

export const CONTEXT_INIT_FLAG_TABLE: ReadonlyArray<ContextInitFlag> = [
	{ flag: "--preview", field: "preview" },
	{ flag: "--adopt", field: "adopt" },
	{ flag: "--apply", field: "applyClioMd" },
	{ flag: "--rewrite", field: "rewriteClioMd" },
	{ flag: "--propose", field: "proposeClioMd" },
	{ flag: "--global", aliases: ["--include-global"], field: "includeGlobalImports" },
	{ flag: "--heuristic", aliases: ["--no-generate"], field: "heuristic" },
];

/** The ONE place the rewrite => apply implication lives. */
export function applyInitImplications(options: ContextInitOptions): ContextInitOptions {
	if (options.applyClioMd === true || options.rewriteClioMd === true) {
		return { ...options, applyClioMd: true };
	}
	return { ...options };
}

/** Conflict validation. Returns a usage-error string or null. */
export function validateInitOptions(options: ContextInitOptions): string | null {
	if (
		options.proposeClioMd === true &&
		(options.adopt === true || options.applyClioMd === true || options.rewriteClioMd === true)
	) {
		return "clio context init: --propose cannot be combined with --adopt, --apply, or --rewrite";
	}
	return null;
}

type BootstrapInitInput = Pick<
	RunBootstrapInput,
	"preview" | "adopt" | "applyClioMd" | "rewriteClioMd" | "proposeClioMd" | "includeGlobalImports"
>;

export function bootstrapInputFromInitOptions(options: ContextInitOptions): BootstrapInitInput {
	const implied = applyInitImplications(options);
	const input: BootstrapInitInput = {};
	for (const field of [
		"preview",
		"adopt",
		"applyClioMd",
		"rewriteClioMd",
		"proposeClioMd",
		"includeGlobalImports",
	] as const) {
		if (implied[field] !== undefined) {
			input[field] = implied[field];
		}
	}
	return input;
}
