/** Durable OAuth grants: explicit writes under the same lock that guards refresh and deletion. */
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { withLockedFile } from "../locked-file.ts";
import { McpError, type McpGrantRecord, type McpGrantStore, type McpGrantSummary } from "../mcp-api.ts";

const RecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  serverUrl: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  issuer: Schema.NonEmptyString,
  client: Schema.Struct({
    id: Schema.NonEmptyString,
    secret: Schema.optional(Schema.String),
    tokenEndpointAuthMethod: Schema.Literals(["none", "client_secret_post", "client_secret_basic"]),
  }),
  scopes: Schema.Array(Schema.NonEmptyString),
  status: Schema.Literals(["ready", "refreshing", "reauthorization_required"]),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.optional(Schema.NonEmptyString),
  expiresAt: Schema.optional(Schema.Number.check(Schema.isFinite())),
});
const FileSchema = Schema.Record(Schema.String, RecordSchema);

export function checkedGrant(value: unknown): McpGrantRecord {
  try {
    return Schema.decodeUnknownSync(RecordSchema)(value, { onExcessProperty: "error" });
  } catch {
    throw new McpError("storage", "Invalid MCP grant record; refusing to read or overwrite credentials");
  }
}

export function grantSummary(id: string, record: McpGrantRecord): McpGrantSummary {
  return {
    id,
    serverUrl: record.serverUrl,
    resource: record.resource,
    issuer: record.issuer,
    scopes: [...record.scopes],
    status: record.status,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

function decode(raw: string | undefined, path: string): Record<string, McpGrantRecord> {
  if (raw === undefined) return {};
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(FileSchema))(raw, { onExcessProperty: "error" });
  } catch {
    throw new McpError("storage", `Invalid MCP grant file ${path}; refusing to overwrite it`);
  }
}

function idIsValid(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) {
    throw new McpError("storage", "Invalid MCP grant ID");
  }
}

function grantFileTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const link = lstatSync(path, { throwIfNoEntry: false });
    return link?.isSymbolicLink()
      ? grantFileTarget(resolve(dirname(path), readlinkSync(path)))
      : resolve(grantFileTarget(dirname(path)), basename(path));
  }
}

export function mcpGrantFile(path: string): McpGrantStore {
  const file = resolve(path);
  const read = () => {
    try {
      return decode(readFileSync(file, "utf8"), file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  return {
    async read(id) {
      idIsValid(id);
      const records = read();
      return Object.hasOwn(records, id) ? records[id] : undefined;
    },
    async list() {
      return Object.entries(read()).map(([id, value]) => grantSummary(id, value));
    },
    withGrant(id, operation) {
      idIsValid(id);
      // The shared lock helper preserves pi credential path spellings; MCP locks the backing file itself.
      return withLockedFile(
        grantFileTarget(file),
        async (raw, replace) => {
          let records = decode(raw, file);
          const save = (next: Record<string, McpGrantRecord>) => {
            replace(`${JSON.stringify(next)}\n`);
            records = next;
          };
          let active = true;
          const assertActive = () => {
            if (!active) throw new McpError("storage", "MCP grant access escaped its exclusive scope");
          };
          try {
            const result = await operation({
              read() {
                assertActive();
                return Object.hasOwn(records, id) ? checkedGrant(records[id]) : undefined;
              },
              async write(value) {
                assertActive();
                save({ ...records, [id]: checkedGrant(value) });
              },
              async remove() {
                assertActive();
                const next = { ...records };
                delete next[id];
                save(next);
              },
            });
            return { result };
          } finally {
            active = false;
          }
        },
        { create: false },
      );
    },
  };
}
