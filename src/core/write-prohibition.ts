const WRITE_VERB = "(?:write|create|modify|edit|change|delete|remove|touch)";
const PROHIBITION = "(?:do\\s+not|don['’]t|never|must\\s+not|should\\s+not|shouldn['’]t)";
const VERB_LIST = `${WRITE_VERB}(?:\\s*,\\s*${WRITE_VERB})*(?:,?\\s+(?:or|and|nor)\\s+${WRITE_VERB})?`;
const CLAUSE_END = "(?=\\s*(?:[.;:!,)]|$|\\s(?:and|or|nor)\\s+(?:do\\s+not|don['’]t|never)\\b))";

const FORBIDS_FILES = new RegExp(
	`\\b${PROHIBITION}\\s+${VERB_LIST}\\s+(?:any\\s+(?:files?|anything)|files|anything|a\\s+(?:single\\s+)?file)${CLAUSE_END}`,
	"iu",
);
const READ_ONLY_TASK = new RegExp(
	`\\bthis\\s+is\\s+(?:a\\s+|an\\s+)?read[ -]only(?:\\s+(?:task|request|question|run|investigation|review|job|pass))?${CLAUSE_END}`,
	"iu",
);
const CHANGE_NOTHING =
	/\b(?:change|edit|modify|write|touch)\s+nothing(?!\s+(?:else|but|except|outside|other)\b)(?=\s*(?:[.;:!,)]|$))/iu;

/**
 * A request that forbids writing any file at all, stated in its own prose:
 * "do not write any files", "don't create, modify or delete any file", "this
 * is a read-only task", "change nothing". Strict on purpose: a scoped
 * prohibition ("do not modify files outside src/", "don't edit the tests") or
 * one with an exception ("change nothing else", "touch nothing but the docs")
 * is not one, because the request still asks for a write.
 */
export function forbidsFileWrites(text: string): boolean {
	return FORBIDS_FILES.test(text) || READ_ONLY_TASK.test(text) || CHANGE_NOTHING.test(text);
}
