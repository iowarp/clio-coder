/** read's window arguments. */
export interface DocumentRequest {
	numbered: boolean;
	offset: number;
	limit: number | null;
	tail: number | null;
	signal: AbortSignal | undefined;
}

/** What a renderer produces: bounded text, or the reason it cannot. */
export type Rendered = { text: string } | { error: string };
