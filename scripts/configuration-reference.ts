import { join } from "node:path";
import ts from "typescript";

export function configurationReferenceMembership(root: string): (path: string) => boolean {
	const file = join(root, "src/core/defaults.ts");
	const program = ts.createProgram([file], {
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		strict: true,
		skipLibCheck: true,
		noEmit: true,
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(file);
	const module = source && checker.getSymbolAtLocation(source);
	const settings = module && checker.getExportsOfModule(module).find((symbol) => symbol.name === "DEFAULT_SETTINGS");
	if (!settings || !source) throw new Error("cannot resolve DEFAULT_SETTINGS schema");
	const schema = checker.getTypeOfSymbolAtLocation(settings, source);
	return (path) => {
		// Keep container syntax significant: an array is not an object or a map.
		const tokens = path.match(/[^.[\]]+|\[\]/g) ?? [];
		if (tokens.map((token, index) => (index > 0 && token !== "[]" ? `.${token}` : token)).join("") !== path) return false;
		let current: ts.Type | undefined = schema;
		for (const token of tokens) {
			current = checker.getNonNullableType(current);
			if (token === "[]") {
				if (!checker.isArrayType(current) && !checker.isTupleType(current)) return false;
				current = checker.getIndexTypeOfType(current, ts.IndexKind.Number);
			} else if (token === "<key>") {
				current = checker.getIndexTypeOfType(current, ts.IndexKind.String);
			} else {
				if (!(current.flags & ts.TypeFlags.Object) || checker.isArrayType(current)) return false;
				const property = checker.getPropertyOfType(current, token);
				current = property && checker.getTypeOfSymbolAtLocation(property, source);
			}
			if (!current || current.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
		}
		return tokens.length > 0;
	};
}
