/**
 * Self-caps of the gateway-plane observation envelopes. Kept in a module with
 * no imports so the bootstrap policy assertion and the catalog can read them
 * without loading the tools themselves.
 */

/** Bytes of one `data` result body before the JSON stub rule offloads it. */
export const DATA_OBSERVATION_SELF_CAP_BYTES = 32 * 1024;

/** Bytes of one `gateway` find listing before the JSON stub rule offloads it. */
export const GATEWAY_FIND_SELF_CAP_BYTES = 32 * 1024;
