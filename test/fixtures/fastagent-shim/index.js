// What a spawned CLI's `import "@fastagent-sh/fastagent"` resolves to in a test project: the source, as vitest's alias
// makes it in-process, since the package's own entry is `dist/`, which a test run does not build.
export * from "../../../src/index.ts";
