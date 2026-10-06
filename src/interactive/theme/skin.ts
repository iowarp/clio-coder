import type { ExtensionSkin } from "../../domains/extensions/public-api-v2.js";
import { setPaletteSkin } from "./tokens.js";

/** Admission validates the skin; the theme only owns its reversible palette projection. */
export function applySkin(skin: ExtensionSkin | null): void {
	setPaletteSkin(skin?.palette);
}
