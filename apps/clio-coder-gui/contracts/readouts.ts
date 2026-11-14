import type { Static } from "typebox";
import { AcpReadouts } from "./wire.js";

/**
 * The engine's live readouts for one session, as the last `_clio-coder/session/readouts` frame carried them: the
 * yolo posture and window, the live rate, the armed skills and the provider retry. Each field is the engine's own
 * words, and `null` means there is nothing to show, never zero. A frame replaces the previous one whole.
 */
export const SessionReadouts = AcpReadouts;
export type SessionReadouts = Static<typeof SessionReadouts>;
