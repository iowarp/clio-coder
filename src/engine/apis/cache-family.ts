import { createHash } from "node:crypto";

/** The stable head of one worker request: what its provider can serve from a prefix cache. */
export interface CacheFamilyInput {
	api: string;
	provider: string;
	modelId: string;
	/** The Responses APIs render the reasoning effort ahead of the whole input, so two levels never share a prefix. */
	thinkingLevel: string;
	systemPrompt: string;
	tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
	/** The dispatcher's lane for this run among the live workers of this head. */
	lane: number;
}

/**
 * APIs whose backend routes a request to its prefix cache by the session id Pi sends, as measured: the Codex
 * `session-id` header. Anthropic, Copilot and the chat-completions engines look a prefix up by its content alone.
 * The public Responses API takes `prompt_cache_key` as a routing hint too, but it is unmeasured here and stays out.
 */
const SESSION_ROUTED_APIS: ReadonlySet<string> = new Set(["openai-codex-responses"]);

/**
 * The session id workers with one stable head and lane take on a session-routed API, or undefined where the id plays
 * no part in cache lookup. A random id per worker routed each worker on its own there, so a worker rarely read the
 * head an identical earlier worker had written (FL-17).
 *
 * Measured on gpt-6-luna, 2026-11-20: two requests with identical leading items read 0 of 4,614 prompt tokens under
 * different `session-id` headers whatever the body `prompt_cache_key` said, and 4,480 under one header. The backend
 * reuses whole leading input items only, so the id covers exactly the items every member sends first: the tool
 * declarations and the system prompt. A request sent within about one second of the first one that wrote the head
 * still reads nothing.
 *
 * The id is a routing affinity, not a partition: a few requests miss under one id and a few hit across ids. Live
 * conversations that share an id lose their own history more often, so the dispatcher gives each live member a lane
 * of its own (`claimCacheLane`) and the lane is part of the id.
 *
 * The id is content, not a session: workers of a later session reuse the head while the backend still holds it, and
 * the parent session's own affinity carries none of its workers' traffic.
 */
export function workerCacheFamilyId(input: CacheFamilyInput): string | undefined {
	if (!SESSION_ROUTED_APIS.has(input.api)) return undefined;
	// At most 64 characters, the length Pi clamps a prompt cache key to.
	return `clio-coder-w-${headDigest(input)}-${input.lane % 1_000_000}`;
}

/**
 * The session id a tool-free side call (memory retention and review, judges) takes on a session-routed API, or
 * undefined where the id plays no part in cache lookup (OI-6). Without one Pi sends no `session-id` header, so each
 * side call is routed on its own and never reads the system prompt an identical earlier call wrote. A side call has
 * no history of its own, so calls of one head share the id without a lane: each sends its full input, and the
 * backend reuses only the leading items they have in common.
 */
export function sideCallCacheFamilyId(input: Omit<CacheFamilyInput, "tools" | "lane">): string | undefined {
	if (!SESSION_ROUTED_APIS.has(input.api)) return undefined;
	return `clio-coder-s-${headDigest({ ...input, tools: [] })}`;
}

function headDigest(input: Omit<CacheFamilyInput, "lane">): string {
	const head = JSON.stringify([
		input.api,
		input.provider,
		input.modelId,
		input.thinkingLevel,
		input.systemPrompt,
		input.tools.map((tool) => [tool.name, tool.description, tool.parameters]),
	]);
	return createHash("sha256").update(head).digest("hex").slice(0, 40);
}
