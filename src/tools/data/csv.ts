import {
	type CellClass,
	type ColumnType,
	capText,
	classifyCell,
	type DataRefusal,
	type DataViewFlags,
	emptyCellHistogram,
	exactView,
	histogramRecord,
	inferColumnType,
	numberLiteralPrecision,
	type PrecisionIssue,
	type PrecisionKind,
	refusal,
	refusalFromError,
	resolveMaxRows,
	sampledNotice,
	sampledView,
	statDataFile,
	streamTextChunks,
	type TextStreamStats,
	throwIfAborted,
} from "./shared.js";

/**
 * Streaming CSV/TSV reader. An RFC 4180 state machine consumes decoded text
 * chunks and emits one record at a time, so memory holds the current record,
 * the bounded sample, and per-column counters, never the file. Cells stay
 * source text: inspection classifies them, selection returns them verbatim,
 * and nothing is ever coerced to a number or a date.
 */

export type CsvIssueKind =
	| "bare-quote"
	| "text-after-quote"
	| "unterminated-quote"
	| "field-too-large"
	| "record-too-large";

export interface CsvIssue {
	kind: CsvIssueKind;
	/** 1-based record number, header included when one exists. */
	record: number;
	/** 1-based physical line the record starts on. */
	line: number;
	message: string;
}

export interface CsvParserCallbacks {
	/** One complete record. Return false to stop parsing. */
	onRecord(fields: string[], record: number, line: number): boolean;
	onIssue(issue: CsvIssue): void;
}

enum CsvState {
	FieldStart = 0,
	Unquoted = 1,
	Quoted = 2,
	QuoteInQuoted = 3,
	/** A cap was hit: the rest of the record is dropped up to the next line break. */
	Overflow = 4,
}

const CHAR_QUOTE = 0x22;
const CHAR_LF = 0x0a;
const CHAR_CR = 0x0d;

/** Longest field kept, in characters; a longer one is cut here and reported. */
export const CSV_MAX_FIELD_CHARS = 1_048_576;
/** Longest record kept, counting every field's characters plus one per field. */
export const CSV_MAX_RECORD_CHARS = 16 * 1_048_576;

/**
 * Incremental RFC 4180 parser. Quoted fields may hold the delimiter, quotes
 * doubled, and line breaks; CRLF, LF, and a lone CR each end a record; a line
 * with no content at all is a blank line, not a one-field record. Recovery is
 * lenient and reported: a bare quote inside an unquoted field is literal text,
 * text after a closing quote joins the field, and an unterminated quote ends at
 * end of input, each with an issue naming the record.
 *
 * Memory is bounded whatever the input: a field is cut at CSV_MAX_FIELD_CHARS
 * and a record at CSV_MAX_RECORD_CHARS, after which the record closes at the
 * next line break. A stray opening quote therefore costs one oversized,
 * reported record instead of swallowing the rest of the file into one field.
 */
export class CsvParser {
	private state = CsvState.FieldStart;
	private fields: string[] = [];
	private current = "";
	private recordChars = 0;
	private hasContent = false;
	private skipLf = false;
	private line = 1;
	private recordLine = 1;
	private records = 0;
	private stopped = false;
	private issueThisRecord: CsvIssueKind | null = null;
	blankLines = 0;
	crlf = 0;
	lf = 0;
	cr = 0;

	constructor(
		private readonly delimiter: number,
		private readonly callbacks: CsvParserCallbacks,
	) {}

	get isStopped(): boolean {
		return this.stopped;
	}

	get recordCount(): number {
		return this.records;
	}

	/** Feed one chunk. Returns false once the record sink asked to stop. */
	push(text: string): boolean {
		if (this.stopped) return false;
		const length = text.length;
		// A field that continues from the previous chunk starts its run at 0.
		let runStart = this.state === CsvState.Unquoted || this.state === CsvState.Quoted ? 0 : -1;
		for (let index = 0; index < length; index += 1) {
			const code = text.charCodeAt(index);
			if (this.skipLf) {
				this.skipLf = false;
				if (code === CHAR_LF) {
					this.crlf += 1;
					this.cr -= 1;
					continue;
				}
			}
			switch (this.state) {
				case CsvState.FieldStart:
					if (code === CHAR_QUOTE) {
						this.state = CsvState.Quoted;
						this.hasContent = true;
						runStart = index + 1;
					} else if (code === this.delimiter) {
						this.hasContent = true;
						this.pushField("");
					} else if (code === CHAR_LF || code === CHAR_CR) {
						if (this.hasContent) this.pushField("");
						this.newline(code);
						this.endRecord();
					} else {
						this.state = CsvState.Unquoted;
						this.hasContent = true;
						runStart = index;
					}
					break;
				case CsvState.Unquoted:
					if (code === this.delimiter) {
						const fits = this.appendRun(text, runStart, index);
						runStart = -1;
						if (!fits) break;
						this.pushField(this.current);
						this.current = "";
						if (this.state === CsvState.Unquoted) this.state = CsvState.FieldStart;
					} else if (code === CHAR_LF || code === CHAR_CR) {
						const fits = this.appendRun(text, runStart, index);
						runStart = -1;
						if (!fits) {
							this.closeOverflow(code);
							break;
						}
						this.pushField(this.current);
						this.current = "";
						this.state = CsvState.FieldStart;
						this.newline(code);
						this.endRecord();
					} else if (code === CHAR_QUOTE) {
						this.issue("bare-quote", "a quote inside an unquoted field was read as literal text");
					}
					break;
				case CsvState.Quoted:
					if (code === CHAR_QUOTE) {
						const fits = this.appendRun(text, runStart, index);
						runStart = -1;
						if (fits) this.state = CsvState.QuoteInQuoted;
					} else if (code === CHAR_LF || code === CHAR_CR) {
						// A line break inside quotes is where an oversized field gets closed,
						// so the caps are checked here whatever the chunk boundaries were.
						const pending = index - runStart;
						if (this.current.length + pending > CSV_MAX_FIELD_CHARS || this.recordChars + pending > CSV_MAX_RECORD_CHARS) {
							this.appendRun(text, runStart, index);
							runStart = -1;
							this.closeOverflow(code);
						} else if (code === CHAR_LF) {
							this.line += 1;
							this.lf += 1;
						} else {
							// The LF that may follow is field content; only the line counter pairs them.
							this.line += 1;
							this.cr += 1;
							this.skipLf = true;
						}
					}
					break;
				case CsvState.QuoteInQuoted:
					if (code === CHAR_QUOTE) {
						if (this.appendRun('"', 0, 1)) {
							this.state = CsvState.Quoted;
							runStart = index + 1;
						}
					} else if (code === this.delimiter) {
						this.pushField(this.current);
						this.current = "";
						if (this.state === CsvState.QuoteInQuoted) this.state = CsvState.FieldStart;
					} else if (code === CHAR_LF || code === CHAR_CR) {
						this.pushField(this.current);
						this.current = "";
						this.state = CsvState.FieldStart;
						this.newline(code);
						this.endRecord();
					} else {
						this.issue("text-after-quote", "text after a closing quote was joined to the field");
						this.state = CsvState.Unquoted;
						runStart = index;
					}
					break;
				case CsvState.Overflow:
					if (code === CHAR_LF || code === CHAR_CR) this.closeOverflow(code);
					break;
			}
			if (this.stopped) return false;
		}
		if (runStart >= 0 && (this.state === CsvState.Unquoted || this.state === CsvState.Quoted)) {
			this.appendRun(text, runStart, length);
		}
		return true;
	}

	end(): void {
		if (this.stopped) return;
		switch (this.state) {
			case CsvState.Quoted:
				this.issue("unterminated-quote", "the file ended inside a quoted field");
				this.fields.push(this.current);
				this.endRecord();
				break;
			case CsvState.QuoteInQuoted:
			case CsvState.Unquoted:
			case CsvState.Overflow:
				this.fields.push(this.current);
				this.endRecord();
				break;
			default:
				if (this.hasContent) {
					this.fields.push("");
					this.endRecord();
				}
				break;
		}
		this.current = "";
		this.state = CsvState.FieldStart;
	}

	/**
	 * Append text[from, to) to the current field within the caps. Returns false
	 * when a cap was hit: the field keeps what fit and the parser is in the
	 * Overflow state, dropping input until the record's next line break.
	 */
	private appendRun(text: string, from: number, to: number): boolean {
		if (to <= from) return true;
		const run = to - from;
		const fieldRoom = CSV_MAX_FIELD_CHARS - this.current.length;
		const recordRoom = CSV_MAX_RECORD_CHARS - this.recordChars;
		const room = Math.min(fieldRoom, recordRoom);
		if (run <= room) {
			this.current += text.slice(from, to);
			this.recordChars += run;
			return true;
		}
		if (room > 0) {
			this.current += text.slice(from, from + room);
			this.recordChars += room;
		}
		this.overflow(fieldRoom <= recordRoom ? "field-too-large" : "record-too-large");
		return false;
	}

	/** Complete a field; each field also costs one character of the record cap. */
	private pushField(value: string): void {
		this.fields.push(value);
		this.recordChars += 1;
		if (this.recordChars > CSV_MAX_RECORD_CHARS) this.overflow("record-too-large");
	}

	private overflow(kind: "field-too-large" | "record-too-large"): void {
		const message =
			kind === "field-too-large"
				? `a field exceeded ${CSV_MAX_FIELD_CHARS} characters${
						this.state === CsvState.Quoted ? " inside quotes, likely an unterminated quote" : ""
					}; it was cut at the cap and the record was closed at the next line break`
				: `a record exceeded ${CSV_MAX_RECORD_CHARS} characters; it was cut at the cap and closed at the next line break`;
		this.issue(kind, message);
		this.state = CsvState.Overflow;
	}

	private closeOverflow(code: number): void {
		this.fields.push(this.current);
		this.current = "";
		this.state = CsvState.FieldStart;
		this.newline(code);
		this.endRecord();
	}

	private newline(code: number): void {
		this.line += 1;
		if (code === CHAR_CR) {
			this.cr += 1;
			this.skipLf = true;
		} else {
			this.lf += 1;
		}
	}

	private endRecord(): void {
		const startLine = this.recordLine;
		this.recordLine = this.line;
		this.recordChars = 0;
		if (!this.hasContent && this.fields.length === 0) {
			this.blankLines += 1;
			return;
		}
		this.records += 1;
		const fields = this.fields;
		this.fields = [];
		this.hasContent = false;
		this.issueThisRecord = null;
		if (!this.callbacks.onRecord(fields, this.records, startLine)) this.stopped = true;
	}

	private issue(kind: CsvIssueKind, message: string): void {
		if (this.issueThisRecord === kind) return;
		this.issueThisRecord = kind;
		this.callbacks.onIssue({ kind, record: this.records + 1, line: this.recordLine, message });
	}
}

export const CSV_DELIMITER_CANDIDATES = [",", "\t", ";", "|"] as const;
const DELIMITER_SAMPLE_CHARS = 64 * 1024;
const DELIMITER_SAMPLE_RECORDS = 200;

export interface CsvDelimiterDetection {
	delimiter: string;
	/** Share of sampled records whose field count equals the modal count; 0 when nothing split. */
	confidence: number;
	fieldCount: number;
}

/**
 * Pick the delimiter that splits the sample most consistently: parse the first
 * records under each candidate, take the modal field count, and score by how
 * many records share it. A candidate that never produces two fields is out.
 * Ties fall to candidate order (comma first). A file that no candidate splits
 * is a one-column file read with the comma.
 */
export function detectCsvDelimiter(sample: string, sampleComplete: boolean): CsvDelimiterDetection {
	let best: CsvDelimiterDetection = { delimiter: ",", confidence: 0, fieldCount: 1 };
	for (const candidate of CSV_DELIMITER_CANDIDATES) {
		const counts: number[] = [];
		const parser = new CsvParser(candidate.charCodeAt(0), {
			onRecord(fields) {
				counts.push(fields.length);
				return counts.length < DELIMITER_SAMPLE_RECORDS;
			},
			onIssue() {},
		});
		parser.push(sample);
		if (sampleComplete) parser.end();
		// The sample's last record may be cut mid-line; only a complete sample keeps it.
		const usable = sampleComplete || parser.isStopped ? counts : counts.slice(0, -1);
		if (usable.length === 0) continue;
		const tally = new Map<number, number>();
		for (const count of usable) tally.set(count, (tally.get(count) ?? 0) + 1);
		let modal = 1;
		let modalHits = 0;
		for (const [count, hits] of tally) {
			if (hits > modalHits || (hits === modalHits && count > modal)) {
				modal = count;
				modalHits = hits;
			}
		}
		if (modal < 2) continue;
		const confidence = modalHits / usable.length;
		if (confidence > best.confidence) best = { delimiter: candidate, confidence, fieldCount: modal };
	}
	return best;
}

export type CsvHeaderOption = "auto" | boolean;

/** A first record reads as a header when every cell is non-numeric text and a second record exists. */
export function headerLooksLikeNames(record: ReadonlyArray<string>): boolean {
	return record.length > 0 && record.every((cell) => cell.trim().length > 0 && classifyCell(cell.trim()) === "string");
}

export function defaultColumnName(index: number): string {
	return `column_${index + 1}`;
}

export interface CsvColumnReport {
	index: number;
	name: string;
	inferredType: ColumnType;
	nonEmpty: number;
	empty: number;
	/** Missing-value tokens seen in this column, by token. Counted, never converted. */
	sentinels: Record<string, number>;
	/** Cell classes over the scanned rows. */
	types: Record<CellClass, number>;
	/** Up to five distinct values in first-seen order, each capped for the report. */
	sampleValues: string[];
	minLength: number;
	maxLength: number;
	/** Extremes of the numeric cells as their source text; approximate when a literal exceeded double precision. */
	numericRange?: { min: string; max: string; approximate: boolean };
	/** Numeric cells whose double representation would misstate the text. */
	precisionIssues: number;
}

export interface CsvRaggedRow {
	/** 1-based data row (header excluded). */
	row: number;
	line: number;
	fields: number;
}

export interface CsvInspectResult {
	ok: true;
	format: "csv" | "tsv";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	/** Data rows parsed, header excluded. */
	rowsScanned: number;
	/** Data rows in the file; null when the scan stopped at maxRows. */
	rowCount: number | null;
	delimiter: string;
	delimiterSource: "explicit" | "detected" | "default";
	header: string[] | null;
	headerSource: "explicit" | "detected" | "none";
	bom: boolean;
	lineEnding: "lf" | "crlf" | "cr" | "mixed" | "none";
	/** Field count the header (or first record) established. */
	fieldCount: number;
	columns: CsvColumnReport[];
	/** True when ragged rows introduced more columns than the report tracks. */
	columnsTruncated: boolean;
	raggedRows: { count: number; first: CsvRaggedRow[] };
	quotingIssues: { count: number; first: CsvIssue[] };
	/** Numeric cells whose double representation would misstate the text, with row and column. */
	precision: { count: number; first: PrecisionIssue[] };
	blankLines: number;
	/** First data rows as source text, each cell capped at SAMPLE_TEXT_CAP. */
	sample: string[][];
	sampleTruncatedCells: number;
	notes: string[];
}

export interface CsvInspectOptions {
	format?: "csv" | "tsv";
	delimiter?: string;
	header?: CsvHeaderOption;
	sampleRows?: number;
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export const CSV_DEFAULT_SAMPLE_ROWS = 10;
export const CSV_DEFAULT_MAX_ROWS = 100_000;
const COLUMN_TRACK_CAP = 10_000;
const FIRST_ISSUES_CAP = 10;
const SAMPLE_VALUES_CAP = 5;

interface ColumnAccumulator {
	index: number;
	name: string;
	nonEmpty: number;
	empty: number;
	sentinels: Map<string, number>;
	types: Record<CellClass, number>;
	samples: string[];
	minLength: number;
	maxLength: number;
	intMin: bigint | null;
	intMax: bigint | null;
	intMinText: string;
	intMaxText: string;
	floatMin: number;
	floatMax: number;
	floatMinText: string;
	floatMaxText: string;
	floatApproximate: boolean;
	precisionIssues: number;
}

function newColumn(index: number, name: string): ColumnAccumulator {
	return {
		index,
		name,
		nonEmpty: 0,
		empty: 0,
		sentinels: new Map(),
		types: emptyCellHistogram(),
		samples: [],
		minLength: Number.POSITIVE_INFINITY,
		maxLength: 0,
		intMin: null,
		intMax: null,
		intMinText: "",
		intMaxText: "",
		floatMin: Number.POSITIVE_INFINITY,
		floatMax: Number.NEGATIVE_INFINITY,
		floatMinText: "",
		floatMaxText: "",
		floatApproximate: false,
		precisionIssues: 0,
	};
}

/** Fold one cell into its column; returns the precision kind when the cell is a number a double would misstate. */
function accumulateCell(column: ColumnAccumulator, cell: string): PrecisionKind | null {
	const cls = classifyCell(cell);
	column.types[cls] += 1;
	if (cls === "empty") {
		column.empty += 1;
		column.minLength = 0;
		return null;
	}
	column.nonEmpty += 1;
	column.minLength = Math.min(column.minLength, cell.length);
	column.maxLength = Math.max(column.maxLength, cell.length);
	if (cls === "sentinel") {
		column.sentinels.set(cell, (column.sentinels.get(cell) ?? 0) + 1);
		return null;
	}
	if (column.samples.length < SAMPLE_VALUES_CAP && !column.samples.includes(cell)) column.samples.push(cell);
	if (cls === "integer") {
		const value = BigInt(cell);
		if (column.intMin === null || value < column.intMin) {
			column.intMin = value;
			column.intMinText = cell;
		}
		if (column.intMax === null || value > column.intMax) {
			column.intMax = value;
			column.intMaxText = cell;
		}
		const precision = numberLiteralPrecision(cell);
		if (precision !== null) column.precisionIssues += 1;
		return precision;
	}
	if (cls === "float") {
		const value = Number(cell);
		const precision = numberLiteralPrecision(cell);
		if (precision !== null) {
			column.precisionIssues += 1;
			column.floatApproximate = true;
		}
		if (Number.isFinite(value)) {
			if (value < column.floatMin) {
				column.floatMin = value;
				column.floatMinText = cell;
			}
			if (value > column.floatMax) {
				column.floatMax = value;
				column.floatMaxText = cell;
			}
		}
		return precision;
	}
	return null;
}

function numericRange(column: ColumnAccumulator): CsvColumnReport["numericRange"] {
	const hasInt = column.intMin !== null && column.intMax !== null;
	const hasFloat = Number.isFinite(column.floatMin);
	if (!hasInt && !hasFloat) return undefined;
	if (hasInt && !hasFloat) return { min: column.intMinText, max: column.intMaxText, approximate: false };
	if (!hasInt) return { min: column.floatMinText, max: column.floatMaxText, approximate: column.floatApproximate };
	// Mixed integers and floats compare through doubles, so the range is
	// approximate whenever an integer left the exactly representable range.
	const intMinNumber = Number(column.intMin);
	const intMaxNumber = Number(column.intMax);
	const approximate =
		column.floatApproximate || !Number.isSafeInteger(intMinNumber) || !Number.isSafeInteger(intMaxNumber);
	const min = intMinNumber <= column.floatMin ? column.intMinText : column.floatMinText;
	const max = intMaxNumber >= column.floatMax ? column.intMaxText : column.floatMaxText;
	return { min, max, approximate };
}

function columnReport(column: ColumnAccumulator): CsvColumnReport {
	const range = numericRange(column);
	return {
		index: column.index,
		name: column.name,
		inferredType: inferColumnType(column.types),
		nonEmpty: column.nonEmpty,
		empty: column.empty,
		sentinels: histogramRecord(column.sentinels),
		types: { ...column.types },
		sampleValues: column.samples.map((value) => capText(value).text),
		minLength: Number.isFinite(column.minLength) ? column.minLength : 0,
		maxLength: column.maxLength,
		...(range !== undefined ? { numericRange: range } : {}),
		precisionIssues: column.precisionIssues,
	};
}

function lineEndingOf(parser: CsvParser): CsvInspectResult["lineEnding"] {
	const kinds = [parser.lf > 0, parser.crlf > 0, parser.cr > 0].filter(Boolean).length;
	if (kinds === 0) return "none";
	if (kinds > 1) return "mixed";
	if (parser.crlf > 0) return "crlf";
	if (parser.cr > 0) return "cr";
	return "lf";
}

function resolveDelimiter(explicit: string | undefined, format: "csv" | "tsv"): string | Error | null {
	if (explicit === undefined) return format === "tsv" ? "\t" : null;
	if (explicit === "\\t") return "\t";
	if (explicit.length !== 1) return new Error("delimiter must be one character (or \\t)");
	if (explicit === '"' || explicit === "\n" || explicit === "\r") {
		return new Error("delimiter cannot be a quote or a line break");
	}
	return explicit;
}

interface CsvScan {
	parser: CsvParser;
	delimiter: string;
	delimiterSource: CsvInspectResult["delimiterSource"];
}

/**
 * Drive the parser over the file. The first 64 KiB of text is held back for
 * delimiter detection when none was given, then fed through the same parser
 * so the detection sample is never parsed twice against the chosen delimiter.
 */
async function scanCsv(
	path: string,
	explicitDelimiter: string | null,
	signal: AbortSignal | undefined,
	stats: TextStreamStats,
	callbacks: CsvParserCallbacks,
): Promise<CsvScan> {
	let parser: CsvParser | null = null;
	let delimiter = explicitDelimiter;
	let delimiterSource: CsvInspectResult["delimiterSource"] = delimiter === null ? "detected" : "explicit";
	let sample = "";
	for await (const chunk of streamTextChunks(path, { signal, stats })) {
		if (parser === null) {
			if (delimiter === null) {
				sample += chunk.text;
				if (sample.length < DELIMITER_SAMPLE_CHARS) continue;
				const detected = detectCsvDelimiter(sample.slice(0, DELIMITER_SAMPLE_CHARS), false);
				delimiter = detected.delimiter;
				if (detected.confidence === 0) delimiterSource = "default";
				parser = new CsvParser(delimiter.charCodeAt(0), callbacks);
				const keepGoing = parser.push(sample);
				sample = "";
				if (!keepGoing) break;
				continue;
			}
			parser = new CsvParser(delimiter.charCodeAt(0), callbacks);
		}
		if (!parser.push(chunk.text)) break;
	}
	throwIfAborted(signal, path);
	if (parser === null) {
		// The whole file fit inside the detection sample (or it is empty).
		if (delimiter === null) {
			const detected = detectCsvDelimiter(sample, true);
			delimiter = detected.delimiter;
			if (detected.confidence === 0) delimiterSource = "default";
		}
		parser = new CsvParser(delimiter.charCodeAt(0), callbacks);
		parser.push(sample);
	}
	if (!parser.isStopped) parser.end();
	return { parser, delimiter: delimiter as string, delimiterSource };
}

interface FirstRecord {
	fields: string[];
	line: number;
}

/**
 * Header resolution shared by the three readers. Under `auto` the first
 * record waits for the second: it is a header only when every cell is a
 * non-numeric name and another record exists, so a one-record file under
 * auto is one data row.
 */
class HeaderResolver {
	header: string[] | null = null;
	source: CsvInspectResult["headerSource"] = "none";
	fieldCount = 0;
	settled = false;
	pending: FirstRecord | null = null;

	constructor(private readonly option: CsvHeaderOption) {}

	/** Returns the data rows this record releases, in order. */
	feed(fields: string[], line: number): FirstRecord[] {
		if (this.settled) return [{ fields, line }];
		if (this.option === true) {
			this.settle(fields, "explicit", fields.length);
			return [];
		}
		if (this.option === false) {
			this.settle(null, "none", fields.length);
			return [{ fields, line }];
		}
		if (this.pending === null) {
			this.pending = { fields, line };
			return [];
		}
		const first = this.pending;
		this.pending = null;
		if (headerLooksLikeNames(first.fields)) {
			this.settle(first.fields, "detected", first.fields.length);
			return [{ fields, line }];
		}
		this.settle(null, "none", first.fields.length);
		return [first, { fields, line }];
	}

	/** End of input: a lone pending record is data. */
	finish(): FirstRecord[] {
		if (this.settled) return [];
		const first = this.pending;
		this.pending = null;
		if (first === null) {
			this.settle(this.option === true ? [] : null, this.option === true ? "explicit" : "none", 0);
			return [];
		}
		this.settle(null, "none", first.fields.length);
		return [first];
	}

	private settle(header: string[] | null, source: CsvInspectResult["headerSource"], fieldCount: number): void {
		this.settled = true;
		this.header = header;
		this.source = source;
		this.fieldCount = fieldCount;
	}
}

export async function inspectCsv(
	path: string,
	options: CsvInspectOptions = {},
): Promise<CsvInspectResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = options.format ?? "csv";
	const explicitDelimiter = resolveDelimiter(options.delimiter, format);
	if (explicitDelimiter instanceof Error) return refusal("invalid-argument", explicitDelimiter.message, { path });
	const sampleRows = Math.max(0, Math.min(1000, Math.floor(options.sampleRows ?? CSV_DEFAULT_SAMPLE_ROWS)));
	const maxRows = resolveMaxRows(options.maxRows, CSV_DEFAULT_MAX_ROWS);
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const headers = new HeaderResolver(options.header ?? "auto");

	const state = {
		columns: [] as ColumnAccumulator[],
		columnsTruncated: false,
		columnsEstablished: false,
		dataRows: 0,
		stoppedAtRows: false,
		raggedCount: 0,
		raggedFirst: [] as CsvRaggedRow[],
		issueCount: 0,
		issueFirst: [] as CsvIssue[],
		precisionCount: 0,
		precisionFirst: [] as PrecisionIssue[],
		sample: [] as string[][],
		sampleTruncatedCells: 0,
	};

	const establishColumns = (): void => {
		if (state.columnsEstablished) return;
		state.columnsEstablished = true;
		const names = headers.header ?? Array.from({ length: headers.fieldCount }, (_, index) => defaultColumnName(index));
		for (const [index, name] of names.entries()) {
			if (state.columns.length >= COLUMN_TRACK_CAP) {
				state.columnsTruncated = true;
				break;
			}
			state.columns.push(newColumn(index, name));
		}
	};

	const consumeDataRow = (fields: string[], line: number): boolean => {
		establishColumns();
		if (state.dataRows >= maxRows) {
			state.stoppedAtRows = true;
			return false;
		}
		state.dataRows += 1;
		if (fields.length !== headers.fieldCount) {
			state.raggedCount += 1;
			if (state.raggedFirst.length < FIRST_ISSUES_CAP) {
				state.raggedFirst.push({ row: state.dataRows, line, fields: fields.length });
			}
		}
		for (const [index, cell] of fields.entries()) {
			let column = state.columns[index];
			if (column === undefined) {
				if (state.columns.length >= COLUMN_TRACK_CAP) {
					state.columnsTruncated = true;
					break;
				}
				column = newColumn(index, defaultColumnName(index));
				state.columns.push(column);
			}
			const precision = accumulateCell(column, cell);
			if (precision !== null) {
				state.precisionCount += 1;
				if (state.precisionFirst.length < FIRST_ISSUES_CAP) {
					state.precisionFirst.push({ kind: precision, literal: cell, row: state.dataRows, column: index });
				}
			}
		}
		if (state.sample.length < sampleRows) {
			state.sample.push(
				fields.map((cell) => {
					const capped = capText(cell);
					if (capped.truncated) state.sampleTruncatedCells += 1;
					return capped.text;
				}),
			);
		}
		return true;
	};

	const callbacks: CsvParserCallbacks = {
		onRecord(fields, _record, line) {
			for (const row of headers.feed(fields, line)) {
				if (!consumeDataRow(row.fields, row.line)) return false;
			}
			return true;
		},
		onIssue(issue) {
			state.issueCount += 1;
			if (state.issueFirst.length < FIRST_ISSUES_CAP) state.issueFirst.push(issue);
		},
	};

	let scan: CsvScan;
	try {
		scan = await scanCsv(path, explicitDelimiter, options.signal, stats, callbacks);
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
	if (!scan.parser.isStopped) {
		for (const row of headers.finish()) consumeDataRow(row.fields, row.line);
		establishColumns();
	}
	const sampled = state.stoppedAtRows;
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	if (sampled) notes.push(sampledNotice(state.dataRows, "rows"));
	if (scan.delimiterSource === "default") {
		notes.push("no delimiter split the sample consistently; read as one column with the comma");
	}
	if (state.columnsTruncated) notes.push(`column tracking capped at ${COLUMN_TRACK_CAP} columns`);
	if (state.raggedCount > 0) {
		notes.push(`${state.raggedCount} row(s) have a field count other than ${headers.fieldCount}`);
	}
	if (state.issueCount > 0) notes.push(`${state.issueCount} quoting issue(s) were recovered leniently and are listed`);
	if (state.precisionCount > 0) {
		notes.push(`${state.precisionCount} numeric cell(s) would lose precision as doubles; cells stay source text`);
	}
	return {
		ok: true,
		format,
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: sampled ? sampledView() : exactView(),
		rowsScanned: state.dataRows,
		rowCount: sampled ? null : state.dataRows,
		delimiter: scan.delimiter,
		delimiterSource: scan.delimiterSource,
		header: headers.header,
		headerSource: headers.source,
		bom: stats.bom,
		lineEnding: lineEndingOf(scan.parser),
		fieldCount: headers.fieldCount,
		columns: state.columns.map(columnReport),
		columnsTruncated: state.columnsTruncated,
		raggedRows: { count: state.raggedCount, first: state.raggedFirst },
		quotingIssues: { count: state.issueCount, first: state.issueFirst },
		precision: { count: state.precisionCount, first: state.precisionFirst },
		blankLines: scan.parser.blankLines,
		sample: state.sample,
		sampleTruncatedCells: state.sampleTruncatedCells,
		notes,
	};
}

export interface CsvSelectOptions {
	format?: "csv" | "tsv";
	delimiter?: string;
	header?: CsvHeaderOption;
	/** 0-based first data row to return. */
	offset?: number;
	limit?: number;
	/** Column names (from the header) or 0-based indices to project; omit for every column. */
	columns?: ReadonlyArray<string | number>;
	signal?: AbortSignal | undefined;
}

export const CSV_SELECT_DEFAULT_LIMIT = 50;
export const CSV_SELECT_MAX_LIMIT = 1000;

export interface CsvSelectResult {
	ok: true;
	format: "csv" | "tsv";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	delimiter: string;
	/** Projected header names, or null when the file has no header. */
	header: string[] | null;
	/** Column indices the rows carry, in output order; empty when no projection and no header fixed a width. */
	columnIndexes: number[];
	offset: number;
	limit: number;
	returned: number;
	/** Whether a data row exists past the returned window. */
	hasMore: boolean;
	/** Data rows parsed to produce the window, skipped prefix included. */
	rowsScanned: number;
	/** Rows as source text; a projected index past a short row is null. */
	rows: Array<Array<string | null>>;
	notes: string[];
}

export async function selectCsv(path: string, options: CsvSelectOptions = {}): Promise<CsvSelectResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = options.format ?? "csv";
	const explicitDelimiter = resolveDelimiter(options.delimiter, format);
	if (explicitDelimiter instanceof Error) return refusal("invalid-argument", explicitDelimiter.message, { path });
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = Math.max(1, Math.min(CSV_SELECT_MAX_LIMIT, Math.floor(options.limit ?? CSV_SELECT_DEFAULT_LIMIT)));
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const headers = new HeaderResolver(options.header ?? "auto");
	const state = {
		projection: null as number[] | null,
		projectionResolved: false,
		projectionError: null as DataRefusal | null,
		dataRows: 0,
		hasMore: false,
		rows: [] as Array<Array<string | null>>,
	};

	const resolveProjection = (): boolean => {
		if (state.projectionResolved) return state.projectionError === null;
		state.projectionResolved = true;
		if (options.columns === undefined) return true;
		const names = headers.header;
		const indexes: number[] = [];
		for (const column of options.columns) {
			if (typeof column === "number") {
				if (!Number.isInteger(column) || column < 0) {
					state.projectionError = refusal("invalid-argument", `column index ${column} is not a non-negative integer`, {
						path,
					});
					return false;
				}
				indexes.push(column);
				continue;
			}
			const index = names?.indexOf(column) ?? -1;
			if (index === -1) {
				state.projectionError = refusal(
					"unknown-column",
					names === null
						? `column "${column}" cannot be resolved: the file has no header; use a 0-based index`
						: `unknown column "${column}"; header columns are ${names.map((name) => JSON.stringify(name)).join(", ")}`,
					{ path },
				);
				return false;
			}
			indexes.push(index);
		}
		state.projection = indexes;
		return true;
	};

	const consumeDataRow = (fields: string[]): boolean => {
		if (!resolveProjection()) return false;
		const index = state.dataRows;
		state.dataRows += 1;
		if (index < offset) return true;
		if (state.rows.length >= limit) {
			state.hasMore = true;
			return false;
		}
		const projection = state.projection;
		state.rows.push(projection === null ? fields : projection.map((column) => fields[column] ?? null));
		return true;
	};

	const callbacks: CsvParserCallbacks = {
		onRecord(fields, _record, line) {
			for (const row of headers.feed(fields, line)) {
				if (!consumeDataRow(row.fields)) return false;
			}
			if (headers.settled && !resolveProjection()) return false;
			return true;
		},
		onIssue() {},
	};

	let scan: CsvScan;
	try {
		scan = await scanCsv(path, explicitDelimiter, options.signal, stats, callbacks);
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
	if (state.projectionError !== null) return state.projectionError;
	if (!scan.parser.isStopped) {
		for (const row of headers.finish()) consumeDataRow(row.fields);
		if (!resolveProjection()) return state.projectionError ?? refusal("invalid-argument", "bad projection", { path });
	}
	const header = headers.header;
	const projection = state.projection;
	const indexes =
		projection ??
		(header !== null
			? header.map((_, index) => index)
			: Array.from({ length: state.rows.reduce((max, row) => Math.max(max, row.length), 0) }, (_, index) => index));
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	if (scan.delimiterSource === "default") {
		notes.push("no delimiter split the sample consistently; read as one column with the comma");
	}
	return {
		ok: true,
		format,
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: exactView(),
		delimiter: scan.delimiter,
		header:
			header === null
				? null
				: projection === null
					? header
					: projection.map((column) => header[column] ?? defaultColumnName(column)),
		columnIndexes: indexes,
		offset,
		limit,
		returned: state.rows.length,
		hasMore: state.hasMore,
		rowsScanned: state.dataRows,
		rows: state.rows,
		notes,
	};
}

export interface CsvValidateOptions {
	format?: "csv" | "tsv";
	delimiter?: string;
	header?: CsvHeaderOption;
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export interface CsvValidateResult {
	ok: true;
	format: "csv" | "tsv";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	/** True when every scanned row is well formed and the scan reached the end; null when it stopped at maxRows without a fault. */
	valid: boolean | null;
	complete: boolean;
	rowsScanned: number;
	rowCount: number | null;
	delimiter: string;
	fieldCount: number;
	header: string[] | null;
	raggedRows: { count: number; first: CsvRaggedRow[] };
	quotingIssues: { count: number; first: CsvIssue[] };
	blankLines: number;
	notes: string[];
}

export async function validateCsv(
	path: string,
	options: CsvValidateOptions = {},
): Promise<CsvValidateResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = options.format ?? "csv";
	const explicitDelimiter = resolveDelimiter(options.delimiter, format);
	if (explicitDelimiter instanceof Error) return refusal("invalid-argument", explicitDelimiter.message, { path });
	const maxRows = resolveMaxRows(options.maxRows, CSV_DEFAULT_MAX_ROWS);
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const headers = new HeaderResolver(options.header ?? "auto");
	const state = {
		dataRows: 0,
		stoppedAtRows: false,
		raggedCount: 0,
		raggedFirst: [] as CsvRaggedRow[],
		issueCount: 0,
		issueFirst: [] as CsvIssue[],
	};

	const consumeDataRow = (fields: string[], line: number): boolean => {
		if (state.dataRows >= maxRows) {
			state.stoppedAtRows = true;
			return false;
		}
		state.dataRows += 1;
		if (fields.length !== headers.fieldCount) {
			state.raggedCount += 1;
			if (state.raggedFirst.length < FIRST_ISSUES_CAP) {
				state.raggedFirst.push({ row: state.dataRows, line, fields: fields.length });
			}
		}
		return true;
	};

	const callbacks: CsvParserCallbacks = {
		onRecord(fields, _record, line) {
			for (const row of headers.feed(fields, line)) {
				if (!consumeDataRow(row.fields, row.line)) return false;
			}
			return true;
		},
		onIssue(issue) {
			state.issueCount += 1;
			if (state.issueFirst.length < FIRST_ISSUES_CAP) state.issueFirst.push(issue);
		},
	};

	let scan: CsvScan;
	try {
		scan = await scanCsv(path, explicitDelimiter, options.signal, stats, callbacks);
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
	if (!scan.parser.isStopped) {
		for (const row of headers.finish()) consumeDataRow(row.fields, row.line);
	}
	const complete = !state.stoppedAtRows;
	const faults = state.raggedCount + state.issueCount;
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	if (!complete) {
		notes.push(
			`validation incomplete: stopped after ${state.dataRows} rows; pass maxRows null to validate the whole file`,
		);
	}
	if (state.raggedCount > 0) {
		notes.push(`${state.raggedCount} row(s) have a field count other than ${headers.fieldCount}`);
	}
	if (state.issueCount > 0) notes.push(`${state.issueCount} quoting issue(s)`);
	return {
		ok: true,
		format,
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: complete ? exactView() : sampledView(),
		valid: faults > 0 ? false : complete ? true : null,
		complete,
		rowsScanned: state.dataRows,
		rowCount: complete ? state.dataRows : null,
		delimiter: scan.delimiter,
		fieldCount: headers.fieldCount,
		header: headers.header,
		raggedRows: { count: state.raggedCount, first: state.raggedFirst },
		quotingIssues: { count: state.issueCount, first: state.issueFirst },
		blankLines: scan.parser.blankLines,
		notes,
	};
}
