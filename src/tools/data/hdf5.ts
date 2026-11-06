import {
	ATTRIBUTE_LIMIT,
	capCount,
	cfBlock,
	chunkTiles,
	DEFAULT_SELECT_ELEMENTS,
	DEFAULT_STATS_BYTES,
	type EncodedValue,
	encodeAttribute,
	exactView,
	type Hyperslab,
	INSPECT_MAX_OBJECTS,
	INSPECT_MAX_VARIABLES,
	INSPECT_RESULT_BYTES,
	jsonBytes,
	MAX_SELECT_ELEMENTS,
	MAX_STATS_BYTES,
	type NumericBlock,
	product,
	refuse,
	renderValues,
	resolveHyperslab,
	type ScientificRequest,
	type ScientificResult,
	SELECT_VALUE_BYTES,
	SLAB_BYTES,
	STATS_DEADLINE_MS,
	StatsAccumulator,
	sentinelOf,
	sentinelsOf,
	slabsOf,
	viewFor,
} from "./scientific-shared.js";

/**
 * HDF5 and NetCDF-4 through h5wasm, the HDF5 C library compiled to wasm. Its
 * Node build does file I/O through direct POSIX calls, so opening a file reads
 * only the metadata HDF5 asks for and a hyperslab reads only the chunks it
 * touches: inspecting a 2 GB file costs a few MB over the loaded library. The
 * file is opened H5F_ACC_RDONLY and never written.
 *
 * Two facts the pinned build does not expose are reported as unknown instead
 * of guessed: on-disk size per dataset (no H5Dget_storage_size binding) and
 * the dataset-creation fill value (no H5Pget_fill_value binding). Fill and
 * missing values therefore come from the `_FillValue` and `missing_value`
 * attributes only.
 */

interface H5Metadata {
	type: number;
	size: number;
	signed: boolean;
	vlen: boolean;
	littleEndian: boolean;
	cset?: number;
	shape: number[] | null;
	maxshape: number[] | null;
	chunks: number[] | null;
	total_size: number;
	enum_type?: { type: number; members: Record<string, number> };
	compound_type?: { members: Array<H5Metadata & { name: string }> };
	array_type?: H5Metadata & { shape: number[] };
	vlen_type?: H5Metadata;
	ref_type?: string;
	virtual_sources?: Array<{ file_name: string; dset_name: string }>;
}

interface H5Filter {
	id: number;
	name: string;
	cd_values: number[];
}

interface H5Dataset {
	metadata: H5Metadata;
	filters: H5Filter[];
	value: unknown;
	slice(ranges: Array<[number, number, number]>): unknown;
	get_attached_scales(index: number): string[];
	get_dimension_labels(): Array<string | null>;
}

interface H5Module {
	get_names(fileId: bigint, path: string, recursive: boolean): string[];
	get_type(fileId: bigint, path: string): number;
	get_attribute_names(fileId: bigint, path: string): string[];
	get_symbolic_link(fileId: bigint, path: string): string;
	get_external_link(fileId: bigint, path: string): { filename: string; obj_path: string };
	H5G_GROUP: number;
	H5G_DATASET: number;
	H5G_TYPE: number;
	H5G_LINK: number;
	H5G_UDLINK: number;
}

export interface H5Library {
	ready: Promise<unknown>;
	Module: H5Module;
	File: new (path: string, mode: "r") => { file_id: bigint; close(): number };
	Dataset: new (fileId: bigint, path: string) => H5Dataset;
	Attribute: new (fileId: bigint, path: string, name: string) => { value: unknown };
}

const H5T = {
	INTEGER: 0,
	FLOAT: 1,
	TIME: 2,
	STRING: 3,
	BITFIELD: 4,
	OPAQUE: 5,
	COMPOUND: 6,
	REFERENCE: 7,
	ENUM: 8,
	VLEN: 9,
	ARRAY: 10,
};

/** Attributes the netCDF library keeps for itself; a NetCDF-4 view hides them the way ncdump does. */
const NETCDF4_INTERNAL = new Set([
	"_NCProperties",
	"_Netcdf4Dimid",
	"_Netcdf4Coordinates",
	"_nc3_strict",
	"DIMENSION_LIST",
	"REFERENCE_LIST",
	"CLASS",
	"NAME",
]);
const NETCDF_DIMENSION_ONLY = "This is a netCDF dimension but not a netCDF variable.";
/** H5S_UNLIMITED (2^64 - 1) arrives as a double; anything this large is unlimited. */
const UNLIMITED_FLOOR = 2 ** 63;

export const HDF5_STORAGE_NOTE =
	"on-disk size per dataset is not available from the bundled HDF5 reader; use run_script with h5py: f[path].id.get_storage_size()";
export const HDF5_FILL_NOTE =
	"fill and missing values come from the _FillValue and missing_value attributes only; an HDF5 dataset-creation fill value (h5py fillvalue=) is not visible to this reader and is not counted";

function describeType(meta: H5Metadata, depth = 0): string {
	const order = !meta.littleEndian && meta.size > 1 ? " big-endian" : "";
	switch (meta.type) {
		case H5T.INTEGER:
			return `${meta.signed ? "int" : "uint"}${meta.size * 8}${order}`;
		case H5T.FLOAT:
			return `float${meta.size * 8}${order}`;
		case H5T.STRING: {
			const charset = meta.cset === 1 ? "utf-8" : "ascii";
			return meta.vlen ? `string (variable length, ${charset})` : `string (fixed ${meta.size} bytes, ${charset})`;
		}
		case H5T.ENUM: {
			const members = Object.entries(meta.enum_type?.members ?? {});
			if (
				members.length === 2 &&
				members.some(([name]) => name === "FALSE") &&
				members.some(([name]) => name === "TRUE")
			) {
				return "bool (h5py enum of int8)";
			}
			const shown = members.slice(0, 16).map(([name, value]) => `${name}=${value}`);
			return `enum {${shown.join(", ")}${members.length > 16 ? ", …" : ""}}`;
		}
		case H5T.COMPOUND: {
			const members = meta.compound_type?.members ?? [];
			if (depth > 2) return `compound (${members.length} members)`;
			const shown = members.slice(0, 16).map((member) => `${member.name}: ${describeType(member, depth + 1)}`);
			return `compound {${shown.join(", ")}${members.length > 16 ? ", …" : ""}}`;
		}
		case H5T.ARRAY:
			return meta.array_type
				? `array ${JSON.stringify(meta.array_type.shape)} of ${describeType(meta.array_type, depth + 1)}`
				: "array";
		case H5T.VLEN:
			return meta.vlen_type
				? `variable-length sequence of ${describeType(meta.vlen_type, depth + 1)}`
				: "variable-length sequence";
		case H5T.REFERENCE:
			return `reference (${meta.ref_type ?? "object"})`;
		case H5T.BITFIELD:
			return `bitfield${meta.size * 8}`;
		case H5T.OPAQUE:
			return `opaque (${meta.size} bytes)`;
		case H5T.TIME:
			return "time";
		default:
			return `type class ${meta.type}`;
	}
}

function isNumeric(meta: H5Metadata): boolean {
	return (meta.type === H5T.INTEGER || meta.type === H5T.FLOAT) && !(meta.type === H5T.FLOAT && meta.size === 2);
}

function joinPath(parent: string, name: string): string {
	return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function describeFilter(filter: H5Filter): Record<string, unknown> {
	const out: Record<string, unknown> = { id: filter.id, name: filter.name };
	if (filter.id === 1 && filter.cd_values.length > 0) out.level = filter.cd_values[0];
	return out;
}

function compressionText(filters: ReadonlyArray<H5Filter>): string {
	if (filters.length === 0) return "none";
	return filters
		.map((filter) =>
			filter.id === 1 && filter.cd_values.length > 0 ? `${filter.name} level ${filter.cd_values[0]}` : filter.name,
		)
		.join(", ");
}

class Hdf5File {
	readonly fileId: bigint;
	netcdf4 = false;
	private readonly handle: { file_id: bigint; close(): number };

	constructor(
		readonly lib: H5Library,
		readonly path: string,
	) {
		try {
			this.handle = new lib.File(path, "r");
		} catch (error) {
			refuse("read-error", `cannot open ${path} as HDF5: ${errorText(error)}`);
		}
		this.fileId = this.handle.file_id;
		const root = this.attributeNames("/");
		this.netcdf4 = root.includes("_NCProperties");
	}

	close(): void {
		this.handle.close();
	}

	attributeNames(path: string): string[] {
		try {
			return this.lib.Module.get_attribute_names(this.fileId, path);
		} catch {
			// An object whose attribute index cannot be read still lists; its attributes read as none.
			return [];
		}
	}

	attributeValue(path: string, name: string): unknown {
		try {
			return new this.lib.Attribute(this.fileId, path, name).value;
		} catch (error) {
			return { $unreadable: errorText(error) };
		}
	}

	/** Attributes as reported, internal NetCDF-4 bookkeeping hidden when the file is NetCDF-4. */
	attributes(path: string, limit = ATTRIBUTE_LIMIT): { values: Record<string, EncodedValue>; total: number } {
		const names = this.attributeNames(path).filter((name) => !(this.netcdf4 && NETCDF4_INTERNAL.has(name)));
		const values: Record<string, EncodedValue> = {};
		for (const name of names.slice(0, limit)) values[name] = encodeAttribute(this.attributeValue(path, name));
		return { values, total: names.length };
	}

	/**
	 * A variable's attribute names, marking the file NetCDF-4 when the variable
	 * carries the netCDF library's own dimension ids. Files written before
	 * `_NCProperties` existed are recognized this way.
	 */
	noteVariable(path: string): string[] {
		const names = this.attributeNames(path);
		if (names.includes("_Netcdf4Dimid") || names.includes("_Netcdf4Coordinates")) this.netcdf4 = true;
		return names;
	}

	dataset(path: string): H5Dataset {
		const type = this.lib.Module.get_type(this.fileId, path);
		if (type !== this.lib.Module.H5G_DATASET) {
			refuse(
				"unknown-variable",
				`${path} is not a dataset in ${this.path}${type === this.lib.Module.H5G_GROUP ? " (it is a group; inspect it instead)" : ""}`,
			);
		}
		return new this.lib.Dataset(this.fileId, path);
	}
}

function errorText(error: unknown): string {
	// h5wasm errors are plain Errors; never forward a stack, whose frames quote the 4 MB inline wasm line.
	const text = error instanceof Error ? error.message : String(error);
	return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function normalizeVariablePath(variable: string): string {
	const trimmed = variable.trim();
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

interface VariableEntry {
	path: string;
	[key: string]: unknown;
}

function dimensionNames(dataset: H5Dataset, rank: number): Array<string | null> | undefined {
	const names: Array<string | null> = [];
	let labels: Array<string | null> = [];
	try {
		labels = dataset.get_dimension_labels();
	} catch {
		// Labels are optional metadata; a dataset without them still reports scales.
	}
	for (let dim = 0; dim < rank; dim += 1) {
		let scales: string[] = [];
		try {
			scales = dataset.get_attached_scales(dim);
		} catch {
			// No dimension-scale table: the label or nothing names this dimension.
		}
		const scale = scales[0];
		names.push(scale !== undefined ? basename(scale) : (labels[dim] ?? null));
	}
	return names.some((name) => name !== null) ? names : undefined;
}

function shapeView(meta: H5Metadata): { shape: number[]; maxshape?: Array<number | null> } {
	const shape = meta.shape ?? [];
	const maxshape = meta.maxshape ?? shape;
	const differs = maxshape.some((extent, dim) => extent !== shape[dim]);
	return differs
		? { shape, maxshape: maxshape.map((extent) => (extent >= UNLIMITED_FLOOR ? null : extent)) }
		: { shape };
}

interface DimensionOnly {
	dimensionOnly: { name: string; length: number; unlimited: boolean };
}

function describeVariable(file: Hdf5File, path: string, detail: "full" | "compact"): VariableEntry | DimensionOnly {
	const dataset = new file.lib.Dataset(file.fileId, path);
	const meta = dataset.metadata;
	const attributeNames = file.noteVariable(path);
	const isScale = attributeNames.includes("CLASS") && String(file.attributeValue(path, "CLASS")) === "DIMENSION_SCALE";
	if (file.netcdf4 && isScale) {
		const name = String(file.attributeValue(path, "NAME") ?? "");
		if (name.startsWith(NETCDF_DIMENSION_ONLY)) {
			const max = meta.maxshape?.[0] ?? 0;
			return { dimensionOnly: { name: basename(path), length: meta.shape?.[0] ?? 0, unlimited: max >= UNLIMITED_FLOOR } };
		}
	}
	const rank = meta.shape?.length ?? 0;
	let filters: H5Filter[] = [];
	try {
		filters = dataset.filters;
	} catch {
		// Filter pipeline unreadable: reported as an empty pipeline rather than failing the listing.
	}
	const attributes = file.attributes(path);
	const cf = cfBlock(attributes.values);
	const entry: VariableEntry = {
		path,
		dtype: describeType(meta),
		...shapeView(meta),
	};
	// A NetCDF-4 coordinate variable is its own dimension scale, so nothing is attached to it.
	const dims = file.netcdf4 && isScale && rank === 1 ? [basename(path)] : dimensionNames(dataset, rank);
	if (dims !== undefined) entry.dims = dims;
	if (file.netcdf4 && isScale) entry.coordinate = true;
	entry.layout = meta.chunks ? "chunked" : meta.virtual_sources ? "virtual" : "contiguous or compact";
	entry.chunks = meta.chunks ?? null;
	entry.filters = filters.map(describeFilter);
	entry.compression = compressionText(filters);
	entry.uncompressedBytes = meta.shape === null ? 0 : meta.total_size * meta.size;
	entry.storageBytes = null;
	if (meta.virtual_sources) entry.virtualSources = meta.virtual_sources.slice(0, 16);
	if (cf !== undefined) entry.cf = cf;
	if (detail === "full") {
		if (attributes.total > 0) entry.attributes = attributes.values;
		if (attributes.total > ATTRIBUTE_LIMIT) entry.attributesOmitted = attributes.total - ATTRIBUTE_LIMIT;
	} else {
		entry.attributeCount = attributes.total;
	}
	return entry;
}

function isDimensionOnly(value: VariableEntry | DimensionOnly): value is DimensionOnly {
	return typeof value.dimensionOnly === "object" && value.dimensionOnly !== null && !("path" in value);
}

interface Walk {
	groups: Array<{ path: string; attributes?: Record<string, EncodedValue>; attributeCount?: number }>;
	variables: VariableEntry[];
	dimensions: Map<string, { name: string; length: number; unlimited: boolean }>;
	links: Array<{ path: string; kind: "soft" | "external"; target: string }>;
	datatypes: string[];
	visited: number;
	complete: boolean;
}

function walk(file: Hdf5File, root: string, detail: "full" | "compact"): Walk {
	const out: Walk = {
		groups: [],
		variables: [],
		dimensions: new Map(),
		links: [],
		datatypes: [],
		visited: 0,
		complete: true,
	};
	const M = file.lib.Module;
	const visit = (path: string): void => {
		if (out.visited >= INSPECT_MAX_OBJECTS) {
			out.complete = false;
			return;
		}
		out.visited += 1;
		const type = M.get_type(file.fileId, path);
		if (type === M.H5G_GROUP) {
			if (path !== root) {
				const attributes = file.attributes(path);
				out.groups.push(
					detail === "full" && attributes.total > 0
						? { path, attributes: attributes.values }
						: attributes.total > 0
							? { path, attributeCount: attributes.total }
							: { path },
				);
			}
			let names: string[] = [];
			try {
				names = M.get_names(file.fileId, path, false);
			} catch (error) {
				out.groups.push({ path: `${path} (unreadable: ${errorText(error)})` });
			}
			for (const name of names) visit(joinPath(path, name));
		} else if (type === M.H5G_DATASET) {
			const described = describeVariable(file, path, detail);
			if (isDimensionOnly(described)) out.dimensions.set(described.dimensionOnly.name, described.dimensionOnly);
			else {
				out.variables.push(described);
				if (described.coordinate === true) {
					const shape = described.shape as number[];
					const max = (described.maxshape as Array<number | null> | undefined)?.[0];
					out.dimensions.set(basename(path), { name: basename(path), length: shape[0] ?? 0, unlimited: max === null });
				}
			}
		} else if (type === M.H5G_TYPE) out.datatypes.push(path);
		else if (type === M.H5G_LINK)
			out.links.push({ path, kind: "soft", target: safe(() => M.get_symbolic_link(file.fileId, path)) });
		else if (type === M.H5G_UDLINK) {
			const target = safe(() => {
				const link = M.get_external_link(file.fileId, path);
				return `${link.filename}:${link.obj_path}`;
			});
			out.links.push({ path, kind: "external", target });
		}
	};
	visit(root);
	return out;
}

function safe(read: () => string): string {
	try {
		return read();
	} catch (error) {
		return `unreadable: ${errorText(error)}`;
	}
}

function containerFormat(file: Hdf5File): { format: "hdf5" | "netcdf"; variant?: string } {
	return file.netcdf4 ? { format: "netcdf", variant: "netcdf4" } : { format: "hdf5" };
}

export function inspectHdf5(lib: H5Library, request: ScientificRequest): ScientificResult {
	const file = new Hdf5File(lib, request.path);
	try {
		const root = request.variable === undefined ? "/" : normalizeVariablePath(request.variable);
		const rootType = lib.Module.get_type(file.fileId, root);
		if (rootType < 0) refuse("unknown-variable", `${root} does not exist in ${request.path}`);
		if (rootType === lib.Module.H5G_DATASET) {
			const described = describeVariable(file, root, "full");
			if (isDimensionOnly(described)) {
				return {
					...containerFormat(file),
					view: exactView(),
					path: request.path,
					dimension: described.dimensionOnly,
					notes: ["this dataset only stores a NetCDF dimension; it is not a variable"],
				};
			}
			return {
				...containerFormat(file),
				view: exactView(),
				path: request.path,
				variable: described,
				notes: [HDF5_STORAGE_NOTE, HDF5_FILL_NOTE],
			};
		}
		const global = file.attributes(root);
		let detail: "full" | "compact" = "full";
		let tree = walk(file, root, detail);
		const build = (variables: VariableEntry[], shownOf: number): ScientificResult => {
			const result: ScientificResult = {
				...containerFormat(file),
				view: viewFor(true, !tree.complete || shownOf > variables.length || detail === "compact"),
				path: request.path,
				...(root !== "/" ? { group: root } : {}),
				attributes: global.values,
				...(global.total > ATTRIBUTE_LIMIT ? { attributesOmitted: global.total - ATTRIBUTE_LIMIT } : {}),
				...(tree.dimensions.size > 0 ? { dimensions: [...tree.dimensions.values()] } : {}),
				groups: tree.groups,
				variables,
				...(tree.links.length > 0 ? { links: tree.links } : {}),
				...(tree.datatypes.length > 0 ? { datatypes: tree.datatypes } : {}),
				listing: {
					variablesShown: variables.length,
					variablesFound: shownOf,
					objectsVisited: tree.visited,
					walkComplete: tree.complete,
					attributes: detail,
				},
				notes: [
					...(tree.complete
						? []
						: [`the walk stopped after ${INSPECT_MAX_OBJECTS} objects; inspect a group path in variable to see the rest`]),
					...(detail === "compact"
						? ["attributes are reduced to CF fields and a count to fit the result; inspect one variable for all of them"]
						: []),
					...(shownOf > variables.length
						? [`${shownOf - variables.length} variables are not listed; inspect a group path in variable to narrow the walk`]
						: []),
					HDF5_STORAGE_NOTE,
					HDF5_FILL_NOTE,
				],
			};
			return result;
		};
		let variables = tree.variables.slice(0, INSPECT_MAX_VARIABLES);
		let result = build(variables, tree.variables.length);
		if (jsonBytes(result) > INSPECT_RESULT_BYTES) {
			detail = "compact";
			tree = walk(file, root, detail);
			variables = tree.variables.slice(0, INSPECT_MAX_VARIABLES);
			result = build(variables, tree.variables.length);
		}
		while (jsonBytes(result) > INSPECT_RESULT_BYTES && variables.length > 1) {
			variables = variables.slice(0, Math.max(1, Math.floor(variables.length * 0.75)));
			result = build(variables, tree.variables.length);
		}
		return result;
	} finally {
		file.close();
	}
}

function readSlab(dataset: H5Dataset, meta: H5Metadata, slab: Hyperslab): unknown {
	if ((meta.shape ?? []).length === 0) return dataset.value;
	const ranges = slab.start.map((first, dim): [number, number, number] => {
		const count = slab.count[dim] as number;
		const stride = slab.stride[dim] as number;
		return [first, first + (count - 1) * stride + 1, stride];
	});
	return dataset.slice(ranges);
}

function variableHeader(path: string, dataset: H5Dataset): Record<string, unknown> {
	const meta = dataset.metadata;
	const header: Record<string, unknown> = { variable: path, dtype: describeType(meta), shape: meta.shape ?? [] };
	const dims = dimensionNames(dataset, meta.shape?.length ?? 0);
	if (dims !== undefined) header.dims = dims;
	return header;
}

function readError(path: string, filters: ReadonlyArray<H5Filter>, error: unknown): never {
	const pipeline =
		filters.length > 0
			? ` (filters: ${compressionText(filters)}; a filter outside HDF5's built-in set needs a plugin this reader does not have)`
			: "";
	refuse("read-error", `cannot read ${path}${pipeline}: ${errorText(error)}`);
}

export function selectHdf5(lib: H5Library, request: ScientificRequest): ScientificResult {
	if (request.variable === undefined)
		refuse("invalid-argument", "select on HDF5 or NetCDF needs variable: the dataset path to read");
	const file = new Hdf5File(lib, request.path);
	try {
		const path = normalizeVariablePath(request.variable);
		const dataset = file.dataset(path);
		file.noteVariable(path);
		const meta = dataset.metadata;
		if (meta.shape === null)
			refuse("invalid-argument", `${path} has an empty (null) dataspace; there is nothing to select`);
		const { slab, explicitCount } = resolveHyperslab(meta.shape, request);
		const requested = product(slab.count);
		if (explicitCount && requested > MAX_SELECT_ELEMENTS) {
			refuse(
				"selection-too-large",
				`the selection names ${requested} elements; op=select returns at most ${MAX_SELECT_ELEMENTS}. Narrow count, or use op=stats for a summary of the whole selection`,
			);
		}
		let budget = Math.min(requested, DEFAULT_SELECT_ELEMENTS);
		let filters: H5Filter[] = [];
		try {
			filters = dataset.filters;
		} catch {
			// Only used to explain a read failure.
		}
		for (;;) {
			const count = explicitCount ? slab.count : capCount(slab.count, budget);
			const window = { ...slab, count };
			let raw: unknown;
			try {
				raw = readSlab(dataset, meta, window);
			} catch (error) {
				readError(path, filters, error);
			}
			const flat = ArrayBuffer.isView(raw)
				? Array.from(raw as unknown as ArrayLike<unknown>)
				: Array.isArray(raw)
					? raw
					: [raw];
			const rendered = renderValues(
				flat,
				meta.shape.length === 0 ? [] : count,
				meta.type === H5T.FLOAT && meta.size === 4,
			);
			const returned = product(count);
			if (rendered === null) {
				if (explicitCount || returned <= 1) {
					refuse(
						"selection-too-large",
						`the ${returned} selected elements render past ${SELECT_VALUE_BYTES / 1024} KiB; narrow count${meta.type === H5T.STRING ? " (string values are large)" : ""}`,
					);
				}
				budget = Math.max(1, Math.floor(returned / 2));
				continue;
			}
			const truncated = returned < requested;
			return {
				...containerFormat(file),
				view: viewFor(true, truncated),
				path: request.path,
				...variableHeader(path, dataset),
				start: window.start,
				count,
				stride: window.stride,
				returned,
				total: requested,
				hasMore: truncated,
				...(truncated
					? {
							truncated: {
								reason: budget < Math.min(requested, DEFAULT_SELECT_ELEMENTS) ? "byte-cap" : "element-cap",
								requestedCount: slab.count,
								note: `count was omitted, so the first ${returned} of ${requested} elements in row-major order are returned; pass an explicit count (up to ${MAX_SELECT_ELEMENTS} elements) for a different window`,
							},
						}
					: {}),
				values: rendered.values,
				notes: ["values are raw as stored: scale_factor and add_offset are not applied and fill values are not masked"],
			};
		}
	} finally {
		file.close();
	}
}

export function statsHdf5(lib: H5Library, request: ScientificRequest): ScientificResult {
	if (request.variable === undefined)
		refuse("invalid-argument", "stats on HDF5 or NetCDF needs variable: the dataset path to summarize");
	const file = new Hdf5File(lib, request.path);
	try {
		const path = normalizeVariablePath(request.variable);
		const dataset = file.dataset(path);
		file.noteVariable(path);
		const meta = dataset.metadata;
		if (!isNumeric(meta))
			refuse("invalid-argument", `${path} is ${describeType(meta)}; op=stats summarizes integer and float variables`);
		if (meta.shape === null) refuse("invalid-argument", `${path} has an empty (null) dataspace`);
		const { slab } = resolveHyperslab(meta.shape, request);
		const attributeNames = file.attributeNames(path);
		const attr = (name: string): unknown => (attributeNames.includes(name) ? file.attributeValue(path, name) : undefined);
		const fill = sentinelOf(attr("_FillValue"));
		const missing = sentinelsOf(attr("missing_value"));
		const accumulator = new StatsAccumulator(fill, missing);
		const maxBytes = Math.min(MAX_STATS_BYTES, Math.max(meta.size, request.maxBytes ?? DEFAULT_STATS_BYTES));
		const slabElements = Math.max(1, Math.floor(Math.min(SLAB_BYTES, maxBytes) / meta.size));
		const deadline = performance.now() + STATS_DEADLINE_MS;
		const selected = product(slab.count);
		let scanned = 0;
		let stoppedBy: "byte-cap" | "deadline" | null = null;
		let filters: H5Filter[] = [];
		try {
			filters = dataset.filters;
		} catch {
			// Only used to explain a read failure.
		}
		const tiles = meta.chunks ? chunkTiles(slab, meta.chunks, slabElements) : null;
		for (const part of tiles ?? slabsOf(slab, slabElements)) {
			const elements = product(part.count);
			if ((scanned + elements) * meta.size > maxBytes) {
				stoppedBy = "byte-cap";
				break;
			}
			if (performance.now() > deadline) {
				stoppedBy = "deadline";
				break;
			}
			let raw: unknown;
			try {
				raw = readSlab(dataset, meta, part);
			} catch (error) {
				readError(path, filters, error);
			}
			accumulator.add((typeof raw === "number" || typeof raw === "bigint" ? [raw] : raw) as NumericBlock);
			scanned += elements;
		}
		const float32 = meta.type === H5T.FLOAT && meta.size === 4;
		const scale = sentinelOf(attr("scale_factor"));
		const offset = sentinelOf(attr("add_offset"));
		const unpacked =
			scale !== null || offset !== null ? accumulator.unpacked(Number(scale ?? 1), Number(offset ?? 0)) : null;
		const complete = stoppedBy === null;
		return {
			...containerFormat(file),
			view: viewFor(complete, false),
			path: request.path,
			...variableHeader(path, dataset),
			start: slab.start,
			count: slab.count,
			stride: slab.stride,
			elementsSelected: selected,
			elementsScanned: scanned,
			bytesRead: scanned * meta.size,
			maxBytes,
			complete,
			...(stoppedBy !== null
				? {
						stoppedBy,
						note:
							stoppedBy === "byte-cap"
								? `the pass stopped at the ${maxBytes}-byte cap after ${scanned} of ${selected} elements, read ${tiles ? "chunk tile by chunk tile in row-major order of the tiles" : "in row-major order"}; every figure covers only those elements. Raise max_bytes (up to ${MAX_STATS_BYTES}) or narrow the selection`
								: `the pass stopped after ${STATS_DEADLINE_MS / 1000} s at ${scanned} of ${selected} elements; every figure covers only those elements. Narrow the selection`,
					}
				: {}),
			fillValue: fill === null ? null : encodeAttribute(attr("_FillValue")),
			missingValue: missing.length === 0 ? null : encodeAttribute(attr("missing_value")),
			...accumulator.summary(float32),
			...(unpacked !== null
				? { unpacked: { scaleFactor: Number(scale ?? 1), addOffset: Number(offset ?? 0), ...unpacked } }
				: {}),
			stdDefinition: "population (ddof=0) over valid values",
			notes: [HDF5_FILL_NOTE],
		};
	} finally {
		file.close();
	}
}
