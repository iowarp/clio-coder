import type { FragmentTable, LoadedFragment } from "./fragment-loader.js";
import { canonicalJson, sha256 } from "./hash.js";

export interface CompileInputs {
	identity: string;
	mode: string;
	safety: string;
	providers: string;
	session: string;
	dynamicInputs: DynamicInputs;
}

export interface DynamicInputs {
	provider?: string | null;
	model?: string | null;
	contextWindow?: number | null;
	thinkingBudget?: string | null;
	sessionNotes?: string;
	turnCount?: number;
	clioVersion?: string;
	piMonoVersion?: string;
}

export interface FragmentManifestEntry {
	id: string;
	relPath: string;
	contentHash: string;
	dynamic: boolean;
}

export interface CompileResult {
	text: string;
	staticCompositionHash: string;
	renderedPromptHash: string;
	fragmentManifest: ReadonlyArray<FragmentManifestEntry>;
	dynamicInputs: Readonly<DynamicInputs>;
}

const allowedPlaceholders: ReadonlySet<keyof DynamicInputs> = new Set<keyof DynamicInputs>([
	"provider",
	"model",
	"contextWindow",
	"thinkingBudget",
	"sessionNotes",
	"turnCount",
	"clioVersion",
	"piMonoVersion",
]);

const placeholderRegex = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

function lookupFragment(table: FragmentTable, id: string, role: string): LoadedFragment {
	const frag = table.byId.get(id);
	if (!frag) {
		throw new Error(`prompts/compiler: ${role} fragment id "${id}" not found`);
	}
	return frag;
}

function requireStatic(fragment: LoadedFragment, role: string): void {
	if (fragment.dynamic) {
		throw new Error(`prompts/compiler: ${role} fragment "${fragment.id}" must be static`);
	}
	if (/\{\{[A-Za-z][A-Za-z0-9]*\}\}/.test(fragment.body)) {
		throw new Error(`prompts/compiler: ${role} fragment "${fragment.id}" contains template placeholders`);
	}
}

function requireDynamic(fragment: LoadedFragment, role: string): void {
	if (!fragment.dynamic) {
		throw new Error(`prompts/compiler: ${role} fragment "${fragment.id}" must be dynamic`);
	}
}

function renderDynamic(fragment: LoadedFragment, inputs: DynamicInputs): string {
	return fragment.body.replace(placeholderRegex, (_match, rawName: string) => {
		const name = rawName as keyof DynamicInputs;
		if (!allowedPlaceholders.has(name)) {
			throw new Error(`prompts/compiler: fragment "${fragment.id}" references unknown placeholder "{{${rawName}}}"`);
		}
		const value = inputs[name];
		if (value === undefined || value === null) return "";
		return String(value);
	});
}

/**
 * Compile a Clio prompt from the supplied fragment table and inputs.
 *
 * Static fragments (identity, mode, safety) inject verbatim. Dynamic fragments
 * (providers, session) render by substituting `{{placeholder}}` with values
 * from `inputs.dynamicInputs`; missing values collapse to empty string, and
 * unknown placeholders throw.
 *
 * Two reproducibility hashes travel with the rendered text:
 *   - `staticCompositionHash` fingerprints the three static fragments by id,
 *     relPath, and contentHash via canonical JSON + sha256. It is invariant
 *     under dynamic input changes.
 *   - `renderedPromptHash` is sha256 over the final rendered text and therefore
 *     changes whenever dynamic inputs change the output.
 */
export function compile(table: FragmentTable, inputs: CompileInputs): CompileResult {
	const identity = lookupFragment(table, inputs.identity, "identity");
	const mode = lookupFragment(table, inputs.mode, "mode");
	const safety = lookupFragment(table, inputs.safety, "safety");
	const providers = lookupFragment(table, inputs.providers, "providers");
	const session = lookupFragment(table, inputs.session, "session");

	requireStatic(identity, "identity");
	requireStatic(mode, "mode");
	requireStatic(safety, "safety");
	requireDynamic(providers, "providers");
	requireDynamic(session, "session");

	const providersRendered = renderDynamic(providers, inputs.dynamicInputs);
	const sessionRendered = renderDynamic(session, inputs.dynamicInputs);

	const text = [identity.body, mode.body, safety.body, providersRendered, sessionRendered].join("\n\n");

	const staticComposition = {
		fragments: [identity, mode, safety].map((f) => ({
			id: f.id,
			relPath: f.relPath,
			contentHash: f.contentHash,
		})),
	};
	const staticCompositionHash = sha256(canonicalJson(staticComposition));
	const renderedPromptHash = sha256(text);

	const fragmentManifest: FragmentManifestEntry[] = [identity, mode, safety, providers, session].map((f) => ({
		id: f.id,
		relPath: f.relPath,
		contentHash: f.contentHash,
		dynamic: f.dynamic,
	}));

	return {
		text,
		staticCompositionHash,
		renderedPromptHash,
		fragmentManifest,
		dynamicInputs: { ...inputs.dynamicInputs },
	};
}
