interface Hidden {
	secret: string;
}
export function make(): Hidden {
	return { secret: "s" };
}
