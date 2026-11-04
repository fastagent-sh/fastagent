import { isEnvName } from "../../declared-secrets.js";
/** @public */
export function defineAgent(config) {
    return config;
}
/** @public */
export function needs(secrets, build) {
    const declared = secrets.map((spec) => typeof spec === "string"
        ? { name: spec, optional: false }
        : {
            name: spec.name,
            optional: spec.optional === true,
            ...(spec.description === undefined ? {} : { description: spec.description }),
        });
    for (const { name } of declared) {
        // Written verbatim into env files and deploy artifacts, where a malformed name breaks somewhere far away.
        if (!isEnvName(name))
            throw new Error(`needs: ${JSON.stringify(name)} is not an environment variable name`);
    }
    return { kind: "fastagent.needs", secrets: declared, build: (values) => build(values) };
}
export function isNeeds(value) {
    return value?.kind === "fastagent.needs";
}
/** @public */
export function defineSchedule(config) {
    return { kind: "fastagent.schedule", ...config };
}
