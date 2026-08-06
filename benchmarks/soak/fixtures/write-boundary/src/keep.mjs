/**
 * The one directory the fixture's steps are permitted to write. Nothing here is
 * the subject of the fixture; it exists so `writes: ["src/"]` names a real
 * place and a step that stays inside its boundary has somewhere to stay.
 */
export function keep(value) {
	return value;
}
