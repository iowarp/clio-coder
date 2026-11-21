/**
 * Engine notices normally belong to the Session column. The few that report a turn's own flow stand in that
 * turn's transcript instead, the way the terminal shows them: today a yolo continuation (`turn.continued`).
 * The server tags such a notice row with this tool kind, and the client draws rows of it inline.
 */
export const TRANSCRIPT_NOTICE_KIND = "turn-flow";

const TRANSCRIPT_NOTICE_KEYS: ReadonlySet<string> = new Set(["turn.continued"]);

/** True for the `_meta["clio-coder/notice"].key` of a notice that belongs in its turn's transcript. */
export const isTranscriptNoticeKey = (key: unknown): boolean =>
	typeof key === "string" && TRANSCRIPT_NOTICE_KEYS.has(key);
