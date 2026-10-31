/**
 * R7 declarations for every hash a v21 receipt can carry (#434). A receipt
 * names this set in its sealed `hashSet` field instead of repeating the
 * declarations, so receipts stay small and the set is versioned like any other
 * serialization contract. Sealing refuses a hash-shaped field without a
 * declaration, so a new hash cannot ship unlabelled.
 *
 * `commitment` means Clio does not retain the preimage: the hash can confirm a
 * candidate preimage but cannot produce one. `resolvable` names the store that
 * holds the preimage. No receipt hash resolves through session `objects/` yet:
 * worker prompts, briefings and steering are never persisted.
 */
import type { ReceiptHashCanonicalization, ReceiptHashSubject } from "../../core/telemetry/run-vocabulary.js";
import type { RunHash } from "../../core/telemetry/schemas.js";

export const RECEIPT_HASH_SET = "clio-coder.receipt-hashes/1" as const;

export type { ReceiptHashCanonicalization, ReceiptHashSubject };

export interface ReceiptHashDeclaration {
	label: "commitment" | "resolvable";
	function: "sha256";
	canonicalization: ReceiptHashCanonicalization;
	subject: ReceiptHashSubject;
	/** Where a resolvable preimage lives. */
	store?: "run-receipts" | "context-seeds";
}

interface DeclarationRow {
	/** Matches the receipt path with array indices removed, e.g. `steering[].contentHash`. */
	path: RegExp;
	declaration: ReceiptHashDeclaration;
	/** The headless main agent hashes a different preimage under the same field name. */
	mainAgent?: ReceiptHashDeclaration;
}

const commitment = (
	subject: ReceiptHashSubject,
	canonicalization: ReceiptHashCanonicalization,
): ReceiptHashDeclaration => ({ label: "commitment", function: "sha256", canonicalization, subject });
const resolvable = (
	subject: ReceiptHashSubject,
	canonicalization: ReceiptHashCanonicalization,
	store: NonNullable<ReceiptHashDeclaration["store"]>,
): ReceiptHashDeclaration => ({ label: "resolvable", function: "sha256", canonicalization, subject, store });

const systemPrompt = commitment("compiled-system-prompt", "utf8-text");

const DECLARATIONS: ReadonlyArray<DeclarationRow> = [
	{
		path: /^compiledPromptHash$/u,
		declaration: commitment("worker-prompt", "trimmed-parts-v1"),
		mainAgent: systemPrompt,
	},
	{ path: /^promptSignature$/u, declaration: commitment("worker-prompt", "trimmed-parts-v1"), mainAgent: systemPrompt },
	{ path: /^(?:staticCompositionHash|sessionShellHash|staticShellHash)$/u, declaration: systemPrompt },
	{ path: /^personaOverride\.promptHash$/u, declaration: systemPrompt },
	{ path: /^dynamicHash$/u, declaration: commitment("dynamic-messages", "trimmed-parts-v1") },
	{
		path: /^toolSignature$/u,
		declaration: commitment("tool-names", "json-insertion-order"),
		mainAgent: commitment("tool-schemas", "json-insertion-order"),
	},
	{ path: /^briefing\.contentHash$/u, declaration: commitment("briefing", "utf8-text") },
	{ path: /^steering\[\]\.contentHash$/u, declaration: commitment("steering", "utf8-text") },
	{
		path: /^workerContext\.snapshotHash$/u,
		declaration: commitment("worker-context-snapshot", "json-sorted-prefixed-v1"),
	},
	{
		path: /^workerContext\.contentHash$/u,
		declaration: resolvable("worker-context-seed", "json-sorted-prefixed-v1", "context-seeds"),
	},
	{ path: /^projectContext\.contentHash$/u, declaration: commitment("project-context", "hash-lines-v1") },
	{
		path: /^plan\.(?:hash|approvalCarry\.(?:approved|rewritten)PlanHash)$/u,
		declaration: commitment("plan-text", "utf8-text"),
	},
	{ path: /^plan\.source\.executionPlanHash$/u, declaration: commitment("execution-plan", "json-insertion-order") },
	{ path: /^plan\.source\.receiptDigest$/u, declaration: resolvable("run-receipt", "artifact-digest", "run-receipts") },
	{ path: /^gate\.subjects\[\]\.digest$/u, declaration: resolvable("run-receipt", "artifact-digest", "run-receipts") },
	{
		path: /^quality\.typedValidations\[\]\.validatorDigest$/u,
		declaration: commitment("validation-result", "json-sorted-v1"),
	},
	{ path: /^quality\.responseSchema\.schemaDigest$/u, declaration: commitment("response-schema", "json-sorted-v1") },
	{ path: /^quality\.resultContract\.validatorDigest$/u, declaration: commitment("result-contract", "json-sorted-v1") },
	{
		path: /^reproducibility\.safetyPolicy\.rulePackHash$/u,
		declaration: commitment("safety-rule-pack", "json-insertion-order"),
	},
	{
		path:
			/^(?:reproducibility\.safetyPolicy\.projectPolicyHash|safety\.flowRestrictions\.restrictions\[\]\.policyHash)$/u,
		declaration: commitment("project-safety-policy", "utf8-text"),
	},
	{ path: /^reproducibility\.git\.statusHash$/u, declaration: commitment("checkout-tree", "json-insertion-order") },
	{
		path: /^safety\.protectedArtifacts\.stateHash$/u,
		declaration: commitment("protected-artifacts", "json-insertion-order"),
	},
	{ path: /^safety\.permit\.digest$/u, declaration: commitment("worker-permit", "json-sorted-prefixed-v1") },
	{ path: /^safety\.permit\..*\.digest$/u, declaration: commitment("mcp-server", "json-insertion-order") },
	{
		path: /^hostVerification\.checks\[\]\.tree\.fingerprint$/u,
		declaration: commitment("checkout-tree", "json-insertion-order"),
	},
	{ path: /^hostVerification\.checks\[\]\.report\..*\.sha256$/u, declaration: commitment("check-payload", "utf8-text") },
	{ path: /^worktree\.diffHash$/u, declaration: commitment("task-diff", "task-diff-v1") },
	{ path: /^routeDecision\.decisionHash$/u, declaration: commitment("route-decision", "json-insertion-order") },
	{ path: /^routeDecision\..*\.specFingerprint$/u, declaration: commitment("agent-spec", "json-insertion-order") },
	{ path: /^routeDecision\..*\.toolSignature$/u, declaration: commitment("tool-names", "json-insertion-order") },
	{
		path: /^routeDecision\..*\.promptCompositionHash$/u,
		declaration: commitment("route-prompt-composition", "json-insertion-order"),
	},
	{ path: /^routeDecision\..*\.endpointIdentityHash$/u, declaration: commitment("endpoint", "json-sorted-prefixed-v1") },
	{ path: /^routeDecision\..*\.settingsFingerprint$/u, declaration: commitment("settings", "json-sorted-prefixed-v1") },
	{ path: /^skillActivations\[\]\.hash$/u, declaration: commitment("skill-file", "utf8-text") },
	{
		path: /^skillActivations\[\]\.owner\.(?:digest|envelopeDigest)$/u,
		declaration: commitment("package-provenance", "json-sorted-v1"),
	},
	// Legacy fields with no current writer; a receipt that carries one still names what it was.
	{
		path: /^attestation\.(?:settingsFingerprint|specDigest|endpointIdentityHash|toolSignature)$/u,
		declaration: commitment("settings", "json-sorted-prefixed-v1"),
	},
	{ path: /^fleetGate\.pathHash$/u, declaration: commitment("checkout-tree", "utf8-text") },
	{ path: /^ledgerContribution\.digest$/u, declaration: commitment("run-receipt", "json-sorted-v1") },
];

const HASH_KEY = /(?:Hash|hash|Digest|digest|Signature|Fingerprint|fingerprint|^sha256)$/u;

/**
 * Subtrees a receipt seals verbatim from another process or a model: the ACP
 * peer's `initialize` capabilities, the inputs of the tool calls it made, and
 * the worker's validated structured result, whose keys the model chose (a
 * report naming a `commitHash`, say). Their keys are not Clio's hashes, so R7
 * does not bind them and the walk skips them instead of refusing the seal (#434).
 */
const OPAQUE_SUBTREES: ReadonlyArray<RegExp> = [
	/^delegation\.agentCapabilities$/u,
	/^delegation\.toolCallLog\[\]\.arguments$/u,
	/^output\.structured\.data$/u,
];

/** The declaration for one normalized receipt path, or null when the set does not declare it. */
function receiptHashDeclaration(path: string, agentId: string): ReceiptHashDeclaration | null {
	const row = DECLARATIONS.find((candidate) => candidate.path.test(path));
	if (!row) return null;
	return agentId === "main-agent" && row.mainAgent ? row.mainAgent : row.declaration;
}

/** Hash-shaped string fields a draft carries without a declaration; `integrity` is declared by its own type. */
export function undeclaredReceiptHashes(draft: object, agentId: string): string[] {
	const undeclared = new Set<string>();
	const visit = (value: unknown, path: string) => {
		if (OPAQUE_SUBTREES.some((subtree) => subtree.test(path))) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, `${path}[]`);
			return;
		}
		if (value === null || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			const childPath = path === "" ? key : `${path}.${key}`;
			if (path === "" && key === "integrity") continue;
			if (typeof child === "string" && HASH_KEY.test(key) && receiptHashDeclaration(childPath, agentId) === null)
				undeclared.add(childPath);
			else visit(child, childPath);
		}
	};
	visit(draft, "");
	return [...undeclared].sort();
}

/**
 * Every declared hash a finished run carries, labelled, in field order: the `hashes` a run.settled records (#434).
 * Array indices stay in the field name so two steering hashes stay two entries.
 */
export function labelledRunHashes(draft: object, agentId: string): RunHash[] {
	const hashes: RunHash[] = [];
	const visit = (value: unknown, path: string, pattern: string) => {
		if (OPAQUE_SUBTREES.some((subtree) => subtree.test(pattern))) return;
		if (Array.isArray(value)) {
			for (const [index, item] of value.entries()) visit(item, `${path}[${index}]`, `${pattern}[]`);
			return;
		}
		if (value === null || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			const childPath = path === "" ? key : `${path}.${key}`;
			const childPattern = pattern === "" ? key : `${pattern}.${key}`;
			if (pattern === "" && key === "integrity") continue;
			const declaration =
				typeof child === "string" && child !== "" && HASH_KEY.test(key)
					? receiptHashDeclaration(childPattern, agentId)
					: null;
			if (declaration !== null && typeof child === "string")
				hashes.push({ field: childPath, ...declaration, hash: child });
			else visit(child, childPath, childPattern);
		}
	};
	visit(draft, "", "");
	return hashes;
}
