/**
 * Default system prompt for the summarization call. Kept inline so a
 * session with no `compaction.systemPrompt` override still produces stable
 * output. `COMPACTION_USER_PROMPT_TEMPLATE` is the structured format string
 * appended after the serialized conversation.
 */
export const COMPACTION_SYSTEM_PROMPT = [
	"You are a context summarization assistant.",
	"Read the supplied conversation between a user and an AI coding assistant,",
	"then emit a structured summary in the exact format shown in the user message.",
	"Do NOT continue the conversation. Do NOT answer any questions in it.",
].join(" ");

export const COMPACTION_USER_PROMPT_TEMPLATE = `The messages above are a conversation to summarize. Create a structured context checkpoint another LLM will use to continue the work.

When a <previous-context> block is present, it is the canonical checkpoint and retained suffix from an earlier compaction. Produce one cumulative replacement checkpoint: preserve every still-relevant constraint, decision, active skill, unresolved task, exact identifier, and file-state detail from that block while incorporating the newer conversation.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by the user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.

Copy every literal the user stated verbatim into Constraints & Preferences or Critical Context: codewords, passphrases, names, numbers, versions, paths, URLs, identifiers, and decisions the user made. This holds even when the assistant declined to store the value as memory or called it conversation-only. A literal the user asked to be remembered is never droppable.`;

export const COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE = `The messages above are the beginning of the currently active user turn. They will be removed from the live context because the retained suffix starts in the middle of that turn.

When a <previous-context> block is present, it is canonical context from an earlier compaction. Carry its still-relevant constraints, decisions, active skills, unresolved work, exact identifiers, and file state into this checkpoint in addition to the active-turn details below. Do not discard it as unrelated older history.

In addition to that carried-forward context, summarize ONLY the active-turn details needed for another LLM to continue the same request:

- the user's active request
- tool calls already made in this turn
- tool results, file paths, commands, errors, and decisions already observed
- what should happen next
- every literal the user stated verbatim (codewords, names, numbers, paths, decisions), including any the assistant declined to store as memory

Do NOT answer the user. Do NOT summarize unrelated older history.`;

function buildPreviousContextPrefix(previousContextText: string): string {
	const trimmed = previousContextText.trim();
	return trimmed.length > 0 ? `<previous-context>\n${trimmed}\n</previous-context>\n\n` : "";
}

/**
 * Manual `/compact <text>` instructions. A trailing "Additional focus" line
 * after the split-turn template's "summarize ONLY" scope was ignored by a live
 * summarizer that dropped the session routes the operator asked it to keep
 * (DF-7), so they now outrank the template and name facts outside the transcript.
 */
function buildOperatorInstructions(instructions?: string): string {
	const focus = instructions?.trim();
	if (!focus) return "";
	return `\n\n<operator-instructions>\n${focus}\n</operator-instructions>\nThe operator wrote these instructions for this checkpoint. They override the default scope above: keep every fact, value and decision they name in the checkpoint, even when the conversation does not show it.`;
}

export function buildUserText(
	conversationText: string,
	instructions?: string,
	previousContextText = "",
	activeRequest?: string,
): string {
	const activeRequestPrefix = activeRequest?.trim()
		? `<active-request>\n${activeRequest}\n</active-request>\nThis is the operator's active request in the split turn. The ## Goal section must state this request, even when the earlier conversation has no goal or a different goal.\n\n`
		: "";
	return `${buildPreviousContextPrefix(previousContextText)}${activeRequestPrefix}<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_USER_PROMPT_TEMPLATE}${buildOperatorInstructions(instructions)}`;
}

export function buildTurnPrefixUserText(
	conversationText: string,
	instructions?: string,
	previousContextText = "",
): string {
	return `${buildPreviousContextPrefix(previousContextText)}<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE}${buildOperatorInstructions(instructions)}`;
}
