/**
 * Member names in code prose (`m.add(1,1)`, `x.name()`, `cache.update`). A dot followed by a name reads, to the
 * task readers here, as a clause break before a verb or as a file extension, so "verify m.add(1,1)==2" read as a
 * request to add something (M-40) and inferred `m.add` as a read root (M-42).
 *
 * A method call of any name is masked; with `verbs`, so is a mutation verb reached through a dot without a call.
 * A file extension (`m.py`, `app.config.ts`, `fix.patch`) is neither and stays.
 */
const MEMBER_CALL = String.raw`[A-Za-z_$][\w$]*(?=\()`;
const MEMBER_VERB = String.raw`(?:write|implement|add|create|build|develop|fix|repair|resolve|patch|address|correct|edit|change|modify|refactor|update)\b`;
const RECEIVER = String.raw`(?<=[\w$)\]]\.)`;

const CODE_MEMBER_CALLS = new RegExp(`${RECEIVER}${MEMBER_CALL}`, "g");
const CODE_MEMBERS = new RegExp(`${RECEIVER}(?:${MEMBER_CALL}|${MEMBER_VERB})`, "gi");

/** The text with each code member replaced by `replacement(name)`; `verbs` also masks a dotted mutation verb. */
export function maskCodeMembers(
	text: string,
	options: { verbs: boolean },
	replacement: (name: string) => string,
): string {
	return text.replace(options.verbs ? CODE_MEMBERS : CODE_MEMBER_CALLS, replacement);
}
