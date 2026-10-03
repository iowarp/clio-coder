/** read's window arguments plus the document-only ones. */
export interface DocumentRequest {
	numbered: boolean;
	offset: number;
	limit: number | null;
	tail: number | null;
	pages?: string;
	member?: string;
	signal: AbortSignal | undefined;
}

/** What a renderer produces: bounded text, or the reason it cannot. */
export type Rendered = { text: string } | { error: string };

/** Ceiling on the text one rendering produces; read's per-call cap windows it further. */
export const RENDER_CAP_BYTES = 4 * 1024 * 1024;
