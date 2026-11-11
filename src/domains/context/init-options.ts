import type { RunBootstrapInput } from "./bootstrap.js";
import type { BootstrapDepth } from "./bootstrap-evidence.js";

export interface ContextInitOptions {
	preview?: boolean;
	adopt?: boolean;
	applyClioMd?: boolean;
	rewriteClioMd?: boolean;
	proposeClioMd?: boolean;
	includeGlobalImports?: boolean;
	heuristic?: boolean;
	depth?: BootstrapDepth;
	/** Write a reviewed proposal instead of generating: the newest, or `acceptRef`. */
	accept?: boolean;
	acceptRef?: string;
}

export interface ContextInitFlag {
	flag: string;
	aliases?: ReadonlyArray<string>;
	field: Exclude<keyof ContextInitOptions, "depth" | "acceptRef">;
}

export const CONTEXT_INIT_FLAG_TABLE: ReadonlyArray<ContextInitFlag> = [
	{ flag: "--preview", field: "preview" },
	{ flag: "--adopt", field: "adopt" },
	{ flag: "--apply", field: "applyClioMd" },
	{ flag: "--rewrite", field: "rewriteClioMd" },
	{ flag: "--propose", field: "proposeClioMd" },
	{ flag: "--global", aliases: ["--include-global"], field: "includeGlobalImports" },
	{ flag: "--heuristic", field: "heuristic" },
	{ flag: "--accept", field: "accept" },
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
	if (options.accept === true) {
		const others = CONTEXT_INIT_FLAG_TABLE.filter(({ field }) => field !== "accept" && options[field] === true);
		if (others.length > 0 || options.depth !== undefined)
			return `clio-coder context init: --accept takes only a proposal path or id, not ${[...others.map(({ flag }) => flag), ...(options.depth ? ["--depth"] : [])].join(" ")}`;
	} else if (options.acceptRef !== undefined) {
		return `clio-coder context init: unexpected argument: ${options.acceptRef}`;
	}
	if (
		options.proposeClioMd === true &&
		(options.adopt === true || options.applyClioMd === true || options.rewriteClioMd === true)
	) {
		return "clio-coder context init: --propose cannot be combined with --adopt, --apply, or --rewrite";
	}
	return null;
}

type BootstrapInitInput = Pick<
	RunBootstrapInput,
	"preview" | "adopt" | "applyClioMd" | "rewriteClioMd" | "proposeClioMd" | "includeGlobalImports" | "depth"
>;

export function bootstrapInputFromInitOptions(options: ContextInitOptions): BootstrapInitInput {
	const implied = applyInitImplications(options);
	const input: BootstrapInitInput = {};
	if (implied.depth !== undefined) input.depth = implied.depth;
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
