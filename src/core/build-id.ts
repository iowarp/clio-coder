/**
 * The id of the build this process loaded. The bundler replaces this whole
 * module with a fresh literal on every build (tsup.config.ts `buildIdPlugin`),
 * so it stays tiny and only its chunk changes between builds. Source runs
 * under tsx and tests see null.
 */
export const runningBuildId: string | null = null;
