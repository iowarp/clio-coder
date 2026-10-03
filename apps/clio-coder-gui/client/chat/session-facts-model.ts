import type { SessionConfig } from "../../contracts/session-config.js";
import type { TimelineItem } from "../../contracts/sessions.js";

/** ACP marks engine notices separately from model text; older records keep their prefix. */
export function sessionFacts(
	items: readonly TimelineItem[],
	notices: readonly string[] = [],
): { model: string[]; context: string[]; other: string[] } {
	const facts = { model: [] as string[], context: [] as string[], other: [] as string[] };
	for (const raw of [...items.filter((item) => item.kind === "notice").map((item) => item.text), ...notices]) {
		const text = raw.replace(/^\[Clio Coder\]\s*/u, "").trim();
		if (!text) continue;
		const bucket = /^(?:thinking |This model .*thinking)/iu.test(text)
			? facts.model
			: /^project instructions:/iu.test(text)
				? facts.context
				: facts.other;
		if (!bucket.includes(text)) bucket.push(text);
	}
	return facts;
}

export function needsTrustReview(trust: { ignored: readonly unknown[] } | undefined): boolean {
	return (trust?.ignored.length ?? 0) > 0;
}

export function modelSessionFacts(config: SessionConfig | undefined, recorded: readonly string[]): readonly string[] {
	const control = config?.options.find((row) => row.id === "thinkingLevel");
	return control ? (control.notice ? [control.notice] : []) : recorded;
}

export function isConversationItem(item: TimelineItem): boolean {
	return item.kind !== "notice";
}
