/**
 * Lightweight information-flow policy: operator-approved source rules decide
 * which exact destinations content read from a restricted source may reach.
 *
 * A source rule names paths under the project policy root (path-policy
 * semantics: a plain path covers its subtree, `*` and `**` patterns are
 * supported) and named tools (`mcp:<server>`, `mcp:<server>/<tool>`, or a
 * registry tool name), and lists the recipients their content may be sent
 * to. A recipient is one of:
 *
 * - `target:<id>`: a configured inference target, pinned by the policy's
 *   `informationFlow.targets.<id>` binding to one runtime and one endpoint.
 *   The live target must still match both; changing the URL behind the id
 *   revokes the approval until the binding is updated.
 * - `endpoint:<url>`: one exact outbound URL identity (see
 *   {@link flowEndpointIdentity}).
 * - `origin:<scheme://host[:port]>`: every URL on that origin.
 * - `mcp:<server>`: a declared MCP server, pinned by the policy's
 *   `informationFlow.mcp.<server>` binding to the exact command and
 *   arguments it is launched with. The live declaration must still match.
 * - `group:<name>`: a group from `informationFlow.recipients`.
 *
 * An empty recipient list forbids every transfer. A restriction carried on
 * content is a reference to the rule plus the recipients it allowed when the
 * content was read, never the content. Model-inferred annotations ride along
 * as `advisory` and never produce a verdict.
 *
 * While the project policy is untrusted or changed, its source rules still
 * label what they name, with no recipients: an unapproved edit can forbid
 * more but never approve a destination. A rule an unapproved edit removed is
 * not recoverable here; the trust notice is the operator's signal to review.
 *
 * The evaluator is pure. `permitted` never grants the underlying permission
 * to read, write, or call anything; it only says the policy does not forbid
 * the transfer. `blocked` is an explicit operator violation and survives every
 * autonomy level. `unresolved` means the destination identity itself could
 * not be established while a restriction applies; callers must not transmit
 * on it, and it creates no approval.
 */
import path from "node:path";
import type { PathWalkMemo } from "../../core/path-canonical.js";
import { canonicalizePath, canonicalizeRawPath, createPathWalkMemo } from "../../core/path-canonical.js";
import { isMcpToolName, ToolNames } from "../../core/tool-names.js";
import { expandPath } from "../../tools/path-utils.js";
import type { CompiledPathPolicy } from "./path-policy.js";
import { compilePathPolicy, evaluatePathPolicy, isSameOrDescendant } from "./path-policy.js";

/** One restriction carried on content: a reference to the rule, never the content. */
export interface FlowRestriction {
	/** `informationFlow.sources[].id` in the trusted project safety policy. */
	readonly ruleId: string;
	/** sha256 of the policy bytes that defined the rule when the content was read. */
	readonly policyHash: string;
	/** Canonical path or tool name that matched. Evidence for the operator, not content. */
	readonly sourceRef: string;
	/**
	 * Exact recipient identities the rule allowed at read time, groups and
	 * target bindings already expanded. The restriction stays enforceable from
	 * this snapshot when the live policy later drops or rewrites the rule.
	 */
	readonly recipients: ReadonlyArray<string>;
}

/**
 * Compact, durable restriction metadata attached to context, artifacts, and
 * worker inputs. `advisory` holds model-inferred annotations; they are carried
 * for display and never enforced.
 */
export interface FlowRestrictionSet {
	readonly version: 1;
	readonly restrictions: ReadonlyArray<FlowRestriction>;
	readonly advisory?: ReadonlyArray<string>;
}

export type FlowDestination =
	| {
			readonly kind: "model";
			readonly targetId: string;
			readonly runtime: string;
			/** Exact endpoint identity, or null when the runtime sends through no URL (an SDK or a CLI). */
			readonly endpoint: string | null;
			readonly model: string | null;
			/** True when the target has a URL that could not be turned into an identity. */
			readonly endpointUnresolved?: boolean;
	  }
	| {
			readonly kind: "tool";
			readonly tool: string;
			/** Exact endpoint identity of the URL the tool was asked for, or null when it names none. */
			readonly endpoint: string | null;
			readonly endpointUnresolved?: boolean;
			/** Pinned launch identity of the MCP server behind the tool, from {@link mcpTransportIdentity}. */
			readonly mcp?: string | null;
	  };

export type FlowVerdictKind = "permitted" | "blocked" | "unresolved";

export interface InformationFlowVerdict {
	readonly kind: FlowVerdictKind;
	/** Actionable sentence naming the rule and the destination. Carries no restricted content. */
	readonly reason: string;
	readonly ruleIds: ReadonlyArray<string>;
	readonly evidence: ReadonlyArray<string>;
}

/** Operator-authored shape, after schema validation and before path compilation. */
export interface FlowSourceRuleInput {
	readonly id: string;
	/** Relative to the policy root; path-policy semantics (subtree, `*`, `**`). */
	readonly paths: ReadonlyArray<string>;
	/** Exact registry tool names, `mcp:<server>` for every tool of a server, or `mcp:<server>/<tool>`. */
	readonly tools: ReadonlyArray<string>;
	/** Recipient references; empty forbids every transfer. */
	readonly recipients: ReadonlyArray<string>;
}

/** The operator's pin of what a `target:<id>` recipient means. */
export interface FlowTargetBinding {
	readonly runtime: string;
	/** Endpoint identity, or "none" for a runtime that has no URL. */
	readonly endpoint: string;
}

/**
 * The operator's pin of what an `mcp:<server>` recipient means: the exact
 * launch vector. `cwd` is relative to the policy root and defaults to it;
 * `env` defaults to none. The declaration's environment and working
 * directory can change where a server connects, so both are part of the
 * identity.
 */
export interface FlowMcpBinding {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface InformationFlowPolicyInput {
	readonly groups: Readonly<Record<string, ReadonlyArray<string>>>;
	readonly targets: Readonly<Record<string, FlowTargetBinding>>;
	readonly mcp: Readonly<Record<string, FlowMcpBinding>>;
	readonly sources: ReadonlyArray<FlowSourceRuleInput>;
}

export const EMPTY_INFORMATION_FLOW_INPUT: InformationFlowPolicyInput = { groups: {}, targets: {}, mcp: {}, sources: [] };

/** Own-property lookup so a name like `constructor` cannot resolve an inherited entry. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

interface CompiledSourceRule {
	readonly id: string;
	/** The policy bytes this rule was compiled from: the approved snapshot's or the live text's. */
	readonly policyHash: string;
	readonly paths: CompiledPathPolicy | null;
	readonly tools: ReadonlyArray<string>;
	/** Flattened, exact recipient identities; groups and target bindings are expanded here. */
	readonly recipients: ReadonlyArray<string>;
	/** Recipient references that could not be expanded; a rule with any of these forbids transfer to them. */
	readonly dangling: ReadonlyArray<string>;
}

export interface InformationFlowPolicy {
	readonly policyHash: string | null;
	readonly trusted: boolean;
	readonly rules: ReadonlyArray<CompiledSourceRule>;
	/**
	 * Why this policy cannot vouch for any transfer right now: the approved
	 * snapshot it depends on is unavailable, or the one it promised could not
	 * be written. Every evaluation then refuses, whatever the rules say.
	 */
	readonly refusal: string | null;
}

export const EMPTY_INFORMATION_FLOW_POLICY: InformationFlowPolicy = {
	policyHash: null,
	trusted: false,
	rules: [],
	refusal: null,
};

export interface InformationFlowInput {
	readonly restrictions: FlowRestrictionSet | ReadonlyArray<FlowRestrictionSet>;
	readonly destination: FlowDestination;
	/** The live, trust-gated policy. Used only to narrow a snapshot, never to widen it. */
	readonly policy: InformationFlowPolicy;
}

const RECIPIENT_PREFIXES = ["target:", "endpoint:", "origin:", "mcp:", "group:"] as const;

export function isFlowRecipientRef(value: string): boolean {
	return RECIPIENT_PREFIXES.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);
}

/**
 * Exact outbound URL identity for authorization: lower-cased scheme and
 * host, default port dropped, credentials and fragment dropped, path and
 * query kept exactly as given (an empty path is `/`). Two URLs that differ
 * in path or query are two resources. Null for anything that is not an
 * absolute http(s) URL.
 */
export function flowEndpointIdentity(raw: string | null | undefined): string | null {
	if (typeof raw !== "string" || raw.trim().length === 0) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const host = url.hostname.toLowerCase();
	const defaultPort = url.protocol === "https:" ? "443" : "80";
	const port = url.port === "" || url.port === defaultPort ? "" : `:${url.port}`;
	const pathname = url.pathname === "" ? "/" : url.pathname;
	return `${url.protocol}//${host}${port}${pathname}${url.search}`;
}

/** `scheme://host[:port]` of an endpoint identity, for `origin:` recipients. */
export function flowEndpointOrigin(identity: string): string | null {
	try {
		const url = new URL(identity);
		const defaultPort = url.protocol === "https:" ? "443" : "80";
		const port = url.port === "" || url.port === defaultPort ? "" : `:${url.port}`;
		return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
	} catch {
		return null;
	}
}

/** The pinned, exact form a `target:<id>` recipient expands to: a JSON tuple, so no component can forge a delimiter. */
export function pinnedTargetRef(targetId: string, runtime: string, endpoint: string | null): string {
	return `target:${JSON.stringify([targetId, runtime, endpoint])}`;
}

/** The exact launch identity of a declared MCP server, as the policy pins it and as the gateway reports it. */
export function mcpTransportIdentity(
	server: string,
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	env: Readonly<Record<string, string>>,
): string {
	const sortedEnv = Object.keys(env)
		.sort()
		.map((key) => [key, env[key]]);
	return `mcp:${JSON.stringify([server, command, [...args], cwd, sortedEnv])}`;
}

export function isFlowRestrictionSet(value: unknown): value is FlowRestrictionSet {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const set = value as Record<string, unknown>;
	if (set.version !== 1 || !Array.isArray(set.restrictions)) return false;
	if (set.advisory !== undefined && (!Array.isArray(set.advisory) || set.advisory.some((a) => typeof a !== "string")))
		return false;
	return set.restrictions.every((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const r = entry as Record<string, unknown>;
		return (
			typeof r.ruleId === "string" &&
			typeof r.policyHash === "string" &&
			typeof r.sourceRef === "string" &&
			Array.isArray(r.recipients) &&
			r.recipients.every((ref) => typeof ref === "string")
		);
	});
}

/** Union of restriction sets, deduplicated by rule, policy, and evidence. Null when nothing is restricted. */
export function mergeFlowRestrictions(
	...sets: ReadonlyArray<FlowRestrictionSet | null | undefined>
): FlowRestrictionSet | null {
	const seen = new Set<string>();
	const restrictions: FlowRestriction[] = [];
	const advisory = new Set<string>();
	for (const set of sets) {
		if (!set) continue;
		for (const r of set.restrictions) {
			const key = `${r.ruleId}\0${r.policyHash}\0${r.sourceRef}`;
			if (seen.has(key)) continue;
			seen.add(key);
			restrictions.push({ ruleId: r.ruleId, policyHash: r.policyHash, sourceRef: r.sourceRef, recipients: [...r.recipients] });
		}
		for (const a of set.advisory ?? []) advisory.add(a);
	}
	if (restrictions.length === 0 && advisory.size === 0) return null;
	return { version: 1, restrictions, ...(advisory.size > 0 ? { advisory: [...advisory] } : {}) };
}

/**
 * Expand recipient references to exact identities. A group is followed once
 * per distinct name. A reference that cannot be expanded (unknown group,
 * target without a binding, malformed endpoint) is reported as dangling and
 * admits nothing, so a typo narrows rather than widens.
 */
function expandRecipients(
	refs: ReadonlyArray<string>,
	input: InformationFlowPolicyInput,
	policyRoot: string,
	memo: PathWalkMemo,
	visited: Set<string> = new Set(),
): { recipients: string[]; dangling: string[] } {
	const recipients: string[] = [];
	const dangling: string[] = [];
	for (const ref of refs) {
		if (ref.startsWith("group:")) {
			const name = ref.slice("group:".length);
			if (visited.has(name)) continue;
			visited.add(name);
			const members = own(input.groups, name);
			if (members === undefined) {
				dangling.push(ref);
				continue;
			}
			const nested = expandRecipients(members, input, policyRoot, memo, visited);
			recipients.push(...nested.recipients);
			dangling.push(...nested.dangling);
			continue;
		}
		if (ref.startsWith("target:")) {
			const id = ref.slice("target:".length);
			const binding = own(input.targets, id);
			if (binding === undefined) {
				dangling.push(ref);
				continue;
			}
			const endpoint = binding.endpoint === "none" ? null : flowEndpointIdentity(binding.endpoint);
			if (binding.endpoint !== "none" && endpoint === null) {
				dangling.push(ref);
				continue;
			}
			recipients.push(pinnedTargetRef(id, binding.runtime, endpoint));
			continue;
		}
		if (ref.startsWith("mcp:")) {
			const server = ref.slice("mcp:".length);
			const binding = own(input.mcp, server);
			if (binding === undefined) dangling.push(ref);
			else {
				const cwd = canonicalizePath(path.resolve(policyRoot, binding.cwd ?? "."), memo) ?? path.resolve(policyRoot, binding.cwd ?? ".");
				recipients.push(mcpTransportIdentity(server, binding.command, binding.args, cwd, binding.env ?? {}));
			}
			continue;
		}
		if (ref.startsWith("endpoint:")) {
			const identity = flowEndpointIdentity(ref.slice("endpoint:".length));
			if (identity === null) dangling.push(ref);
			else recipients.push(`endpoint:${identity}`);
			continue;
		}
		if (ref.startsWith("origin:")) {
			const identity = flowEndpointIdentity(ref.slice("origin:".length));
			const origin = identity === null ? null : flowEndpointOrigin(identity);
			if (origin === null) dangling.push(ref);
			else recipients.push(`origin:${origin}`);
			continue;
		}
		recipients.push(ref);
	}
	return { recipients: [...new Set(recipients)], dangling: [...new Set(dangling)] };
}

/**
 * Compile the policy once. Paths reuse the path-policy compiler so a source
 * rule matches exactly what a `zeroAccessPaths` entry would. An untrusted
 * policy keeps its sources and loses every recipient: it can still label a
 * restricted read, and nothing it says approves a destination. A policy
 * without a hash (none on disk, or unreadable) compiles to no rules.
 */
export function compileInformationFlowPolicy(
	input: InformationFlowPolicyInput,
	policyRoot: string,
	policyHash: string | null,
	trusted: boolean,
	/** The last approved section, consulted only while the live policy is not trusted. */
	approved?: { readonly policyHash: string; readonly informationFlow: InformationFlowPolicyInput } | null,
	/** Why durable protection cannot be promised (snapshot unavailable or unwritable), or null. */
	refusal: string | null = null,
): InformationFlowPolicy {
	const memo = createPathWalkMemo();
	const compileRules = (
		source: InformationFlowPolicyInput,
		hash: string,
		withRecipients: boolean,
	): CompiledSourceRule[] =>
		source.sources.map((rule): CompiledSourceRule => {
			const expanded = withRecipients
				? expandRecipients(rule.recipients, source, policyRoot, memo)
				: { recipients: [], dangling: [] };
			return {
				id: rule.id,
				policyHash: hash,
				paths: rule.paths.length === 0 ? null : compilePathPolicy({ zeroAccessPaths: rule.paths }, policyRoot),
				tools: rule.tools,
				recipients: expanded.recipients,
				dangling: expanded.dangling,
			};
		});
	if (trusted && policyHash !== null) {
		return { policyHash, trusted: true, rules: compileRules(input, policyHash, true), refusal };
	}
	// Not trusted: the approved rules govern as approved, and the unapproved
	// text can only add sources that forbid every transfer. An approved rule the
	// edit removed therefore still labels the files it named.
	const approvedRules = approved ? compileRules(approved.informationFlow, approved.policyHash, true) : [];
	const approvedIds = new Set(approvedRules.map((rule) => rule.id));
	const unapprovedRules =
		policyHash === null ? [] : compileRules(input, policyHash, false).filter((rule) => !approvedIds.has(rule.id));
	return {
		policyHash: policyHash ?? approved?.policyHash ?? null,
		trusted: false,
		rules: [...approvedRules, ...unapprovedRules],
		refusal,
	};
}

function toolMatches(pattern: string, tool: string): boolean {
	if (pattern === tool) return true;
	if (!pattern.startsWith("mcp:") || !isMcpToolName(tool)) return false;
	const spec = pattern.slice("mcp:".length);
	const slash = spec.indexOf("/");
	const server = slash === -1 ? spec : spec.slice(0, slash);
	const name = slash === -1 ? null : spec.slice(slash + 1);
	const prefix = `mcp_${server}__`;
	if (!tool.startsWith(prefix)) return false;
	return name === null || tool.slice(prefix.length) === name;
}

/** Path-taking read-class tools and the argument field that names the path. */
const READ_PATH_TOOLS: ReadonlyMap<string, string> = new Map([
	[ToolNames.Read, "path"],
	[ToolNames.Ls, "path"],
	[ToolNames.Grep, "path"],
	[ToolNames.Find, "path"],
	[ToolNames.Data, "path"],
]);

/** Tools that walk a directory: a restricted entry below the walked path is read through them. */
const WALK_TOOLS: ReadonlySet<string> = new Set([ToolNames.Ls, ToolNames.Grep, ToolNames.Find]);

/** The fixed directory a compiled entry starts under; a pattern's prefix before its first wildcard. */
function entryPrefix(entryPath: string): string {
	const wildcard = entryPath.indexOf("*");
	if (wildcard === -1) return entryPath;
	const separator = entryPath.lastIndexOf(path.sep, wildcard);
	return separator === -1 ? entryPath : entryPath.slice(0, separator);
}

export interface FlowSourceCall {
	readonly tool: string;
	readonly args?: Record<string, unknown> | undefined;
	readonly cwd: string;
}

/**
 * Restrictions a tool call's result will carry, decided before the call runs.
 * Path tools are judged by the path they open, physically and lexically, the
 * way the path policy judges a read. A tool that walks a directory (ls, grep,
 * find) also carries every rule whose entries sit below the walked path,
 * conservatively: the walk may surface any of them, and the result is not
 * split per file. Named tools are judged by registry name. Null when no rule
 * matches, which is the baseline for a project without rules.
 */
export function flowRestrictionsForCall(policy: InformationFlowPolicy, call: FlowSourceCall): FlowRestrictionSet | null {
	if (policy.rules.length === 0) return null;
	const restrictions: FlowRestriction[] = [];
	const pathField = READ_PATH_TOOLS.get(call.tool);
	const rawPath = pathField !== undefined ? call.args?.[pathField] : undefined;
	let target: string | null = null;
	if (typeof rawPath === "string" && rawPath.length > 0) target = expandPath(rawPath);
	else if (WALK_TOOLS.has(call.tool)) target = call.cwd;
	const memo = createPathWalkMemo();
	const physical =
		target === null
			? null
			: (canonicalizeRawPath(target, call.cwd, memo) ??
				canonicalizePath(path.resolve(call.cwd, target), memo) ??
				path.resolve(call.cwd, target));
	for (const rule of policy.rules) {
		let evidence: string | null = null;
		if (target !== null && physical !== null && rule.paths !== null) {
			const decision = evaluatePathPolicy(rule.paths, "read", target, call.cwd, memo);
			if (decision.kind === "block") evidence = physical;
			else if (WALK_TOOLS.has(call.tool)) {
				const below = rule.paths.entries.find((entry) => isSameOrDescendant(entryPrefix(entry.path), physical));
				if (below !== undefined) evidence = `${physical} (walks ${below.source})`;
			}
		}
		if (evidence === null && rule.tools.some((pattern) => toolMatches(pattern, call.tool))) evidence = call.tool;
		if (evidence === null) continue;
		restrictions.push({
			ruleId: rule.id,
			policyHash: rule.policyHash,
			sourceRef: evidence,
			recipients: [...rule.recipients],
		});
	}
	return restrictions.length === 0 ? null : { version: 1, restrictions };
}

function describeDestination(destination: FlowDestination): string {
	if (destination.kind === "tool") {
		return destination.endpoint === null ? `tool ${destination.tool}` : `tool ${destination.tool} -> ${destination.endpoint}`;
	}
	return `target ${destination.targetId} (${destination.runtime}, ${destination.endpoint ?? "no endpoint"})`;
}

function recipientAdmits(ref: string, destination: FlowDestination): boolean {
	if (destination.kind === "model") {
		return ref === pinnedTargetRef(destination.targetId, destination.runtime, destination.endpoint);
	}
	if (ref.startsWith("mcp:")) return destination.mcp !== undefined && destination.mcp !== null && ref === destination.mcp;
	if (destination.endpoint === null) return false;
	if (ref.startsWith("endpoint:")) return ref === `endpoint:${destination.endpoint}`;
	if (ref.startsWith("origin:")) return ref === `origin:${flowEndpointOrigin(destination.endpoint) ?? ""}`;
	return false;
}

/**
 * The recipients one restriction allows now: the read-time snapshot, narrowed
 * by the live trusted rule of the same id when the policy has changed since.
 * A later policy can therefore tighten what already-read content may reach
 * but never widen it; widening applies to content read after the change.
 */
function effectiveRecipients(restriction: FlowRestriction, policy: InformationFlowPolicy): ReadonlyArray<string> {
	if (!policy.trusted || policy.policyHash === null || policy.policyHash === restriction.policyHash) {
		return restriction.recipients;
	}
	// A restriction labeled under an untrusted policy carries no recipients and stays that way.
	const live = policy.rules.find((rule) => rule.id === restriction.ruleId);
	if (live === undefined) return restriction.recipients;
	return restriction.recipients.filter((ref) => live.recipients.includes(ref));
}

/**
 * Combine every carried restriction with one exact destination. Every
 * restriction must admit the destination: recipients intersect across rules,
 * so the most restrictive source governs. All rules are evaluated; an
 * explicit violation wins over an unresolved destination, and the reason
 * names the first violated rule. Advisory annotations never decide.
 */
export function evaluateInformationFlow(input: InformationFlowInput): InformationFlowVerdict {
	const carried = Array.isArray(input.restrictions)
		? mergeFlowRestrictions(...(input.restrictions as ReadonlyArray<FlowRestrictionSet>))
		: (input.restrictions as FlowRestrictionSet);
	const restrictions = carried?.restrictions ?? [];
	const where = describeDestination(input.destination);
	// A policy that cannot vouch refuses every transfer, restricted context or
	// not: unlabeled restricted content may already be in context.
	if (input.policy.refusal !== null) {
		return { kind: "unresolved", reason: `${input.policy.refusal}; transfer to ${where} is refused`, ruleIds: [], evidence: [] };
	}
	if (restrictions.length === 0) {
		return { kind: "permitted", reason: "no restricted source in context", ruleIds: [], evidence: [] };
	}
	const ruleIds = [...new Set(restrictions.map((r) => r.ruleId))];
	const evidence = [...new Set(restrictions.map((r) => r.sourceRef))];
	const destinationUnresolved = input.destination.endpointUnresolved === true;
	let blocked: string | null = null;
	let unresolved: string | null = null;
	for (const restriction of restrictions) {
		const recipients = effectiveRecipients(restriction, input.policy);
		if (recipients.length === 0) {
			blocked ??= `information-flow rule '${restriction.ruleId}' forbids any transfer of ${restriction.sourceRef}; destination ${where}`;
			continue;
		}
		if (recipients.some((ref) => recipientAdmits(ref, input.destination))) continue;
		if (destinationUnresolved) {
			unresolved ??= `information-flow rule '${restriction.ruleId}' restricts ${restriction.sourceRef} and the endpoint of ${where} could not be identified; transfer is not approved`;
			continue;
		}
		blocked ??= `information-flow rule '${restriction.ruleId}' restricts ${restriction.sourceRef} to ${recipients.join(", ")}; destination ${where} is not among them`;
	}
	if (blocked !== null) return { kind: "blocked", reason: blocked, ruleIds, evidence };
	if (unresolved !== null) return { kind: "unresolved", reason: unresolved, ruleIds, evidence };
	return { kind: "permitted", reason: `every information-flow rule in context admits ${where}`, ruleIds, evidence };
}

/**
 * Identity of a configured inference target as bytes would leave: the target
 * id, its runtime, and the exact endpoint identity of its URL. No locality
 * is inferred from the address or the runtime; a `target:<id>` recipient is
 * approved only through the operator's binding of all three.
 */
export function resolveModelDestination(input: {
	readonly targetId: string;
	readonly runtimeId: string;
	readonly url: string | null | undefined;
	readonly model: string | null | undefined;
}): FlowDestination {
	const endpoint = flowEndpointIdentity(input.url);
	const hasUrl = typeof input.url === "string" && input.url.trim().length > 0;
	return {
		kind: "model",
		targetId: input.targetId,
		runtime: input.runtimeId,
		endpoint,
		model: input.model ?? null,
		...(hasUrl && endpoint === null ? { endpointUnresolved: true } : {}),
	};
}

/**
 * Identity of a mediated outbound tool call: a fetch names the URL it was
 * asked for, an MCP tool names itself. Only the requested URL is known here;
 * a redirect hop is a new destination and is judged by the fetch loop with
 * the same evaluator. Null for a tool that sends nothing outward.
 */
export function resolveToolDestination(
	tool: string,
	args: Record<string, unknown> | undefined,
	/** The gateway's pinned launch identity for an MCP tool, or null when it cannot name one. */
	mcpTransport?: (tool: string) => string | null,
): FlowDestination | null {
	if (tool === ToolNames.WebFetch || tool === ToolNames.WebRead) {
		const url = typeof args?.url === "string" ? args.url : null;
		const endpoint = flowEndpointIdentity(url);
		return { kind: "tool", tool, endpoint, ...(endpoint === null ? { endpointUnresolved: true } : {}) };
	}
	if (isMcpToolName(tool)) return { kind: "tool", tool, endpoint: null, mcp: mcpTransport?.(tool) ?? null };
	return null;
}
