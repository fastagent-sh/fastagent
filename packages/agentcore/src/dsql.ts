/**
 * Aurora DSQL as an instance's database. DSQL speaks PostgreSQL, with three differences the storage is told of here:
 * a connection signs in with an IAM token that expires, so each new one is signed (`@aws-sdk/dsql-signer`, with the
 * SDK's credential chain: the runtime's role on AWS); a transaction is capped (3,000 rows, 10 MiB) and so is a value
 * (1 MiB); and an index is built asynchronously (`CREATE INDEX ASYNC`, then waited for).
 */
import { DsqlSigner, type DsqlSignerConfig } from "@aws-sdk/dsql-signer";
import type { CreateIndex, PostgresDatabase, PostgresLimits } from "@fastagent-sh/fastagent/platform";

/**
 * Below DSQL's own caps: its 10 MiB counts what a transaction stores, which is more than the records the storage
 * estimates from, and a value's 1 MiB is of the stored text.
 */
export const DSQL_LIMITS: PostgresLimits = {
  rowsPerTransaction: 3_000,
  bytesPerTransaction: 8 * 1024 * 1024,
  bytesPerValue: 1_000_000,
};

/**
 * DSQL builds an index as a job: started with `ASYNC`, and waited for, so the storage opens on the index it made. A job
 * that fails leaves the index `INVALID`, so it fails the migration, which then records no version and is run again.
 */
export const createIndexAsync: CreateIndex = async (db, statement) => {
  if (!statement.startsWith("CREATE INDEX ")) throw new Error(`not an index: ${statement.slice(0, 60)}`);
  const [job] = await db.query<{ job_id?: string }>(statement.replace("CREATE INDEX ", "CREATE INDEX ASYNC "));
  const jobId = job?.job_id;
  // An index that exists starts no job.
  if (jobId === undefined) return;
  return async () => {
    const [waited] = await db.query<{ succeeded?: boolean }>("CALL sys.wait_for_job($1)", [jobId]);
    if (waited?.succeeded !== true) {
      const index = statement.replace(/\s+/g, " ").slice(0, 80);
      throw new Error(`the index job ${jobId} did not succeed (${index}): see sys.jobs, then drop the INVALID index`);
    }
  };
};

export interface DsqlOptions {
  /** The cluster's endpoint: `<cluster id>.dsql.<region>.on.aws`. */
  endpoint: string;
  /** Default: the endpoint's. */
  region?: string;
  /** The database role to sign in as. Default `admin`, signed with the admin token. */
  user?: string;
  /** Default: the AWS SDK's chain (the environment, a profile, or the role the runtime runs as). */
  credentials?: DsqlSignerConfig["credentials"];
}

const REGION = /\.dsql\.([a-z0-9-]+)\.on\.aws$/;

/** The DSQL cluster at `options.endpoint`, for `openAgent`'s `database`. */
export function dsqlDatabase(options: DsqlOptions): PostgresDatabase {
  const { endpoint } = options;
  const region = options.region ?? REGION.exec(endpoint)?.[1];
  if (region === undefined) {
    throw new Error(`${endpoint} is not a DSQL endpoint (<cluster id>.dsql.<region>.on.aws): pass its region`);
  }
  const user = options.user ?? "admin";
  const signer = new DsqlSigner({
    hostname: endpoint,
    region,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
  return {
    url: `postgres://${encodeURIComponent(user)}@${endpoint}:5432/postgres?sslmode=verify-full`,
    password: () => (user === "admin" ? signer.getDbConnectAdminAuthToken() : signer.getDbConnectAuthToken()),
    limits: DSQL_LIMITS,
    createIndex: createIndexAsync,
  };
}
