// Convenience entry: the engine-neutral core plus the pi reference implementation.
// Contract/channel-only consumers should prefer `@fastagent-sh/fastagent/core`; pi-specific consumers
// may use `@fastagent-sh/fastagent/pi`. The root remains the supported all-in-one surface.
export * from "./core.ts";
export * from "./pi.ts";
