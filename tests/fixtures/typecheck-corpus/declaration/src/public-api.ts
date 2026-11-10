// Declaration emit, as tsup's dts step needs for the ./extensions types.
import { make } from "./internal.js";

export const Mixin = class {
	private hidden = 1;
	read(): number {
		return this.hidden;
	}
};
export const made = make();
export function factory() {
	return class {
		#count = 0;
		protected bump(): number {
			return ++this.#count;
		}
	};
}
export const ok: { label: string } = { label: "ok" };
