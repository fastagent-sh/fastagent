import { createHash, createHmac } from "node:crypto";

/**
 * The microVM's metadata service and Secrets Manager as the container reaches them, with a SigV4 check that does not
 * use the signer under test: it recomputes the signature from the request's own headers and the role's secret key, so a
 * signature the real service would refuse is refused here. One double for `runtime-secrets.ts`, driven on Bun by
 * test/smoke/bun/runtime-secrets.ts.
 */
const ACCESS_KEY_ID = "AKIATESTACCESSKEY";
const SECRET_ACCESS_KEY = "TESTSECRETKEY/abc123";
const SESSION_TOKEN = "SESSION-TOKEN";

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

type Authorization = Record<"key" | "day" | "region" | "service" | "signedHeaders" | "signature", string>;

/** Why SigV4 would refuse this request, or `undefined` when it would not. */
function sigV4Problem(
  method: string,
  url: URL,
  headers: Headers,
  body: string,
  secretAccessKey: string,
  endpointRegion: string,
): string | undefined {
  const auth = headers.get("authorization") ?? "";
  const parts =
    /^AWS4-HMAC-SHA256 Credential=(?<key>[^/]+)\/(?<day>\d{8})\/(?<region>[^/]+)\/(?<service>[^/]+)\/aws4_request, SignedHeaders=(?<signedHeaders>[^,]+), Signature=(?<signature>[0-9a-f]+)$/.exec(
      auth,
    );
  if (!parts?.groups) return `no SigV4 authorization: ${auth}`;
  const { key, day, region, service, signedHeaders, signature } = parts.groups as Authorization;
  if (key !== ACCESS_KEY_ID) return `signed with access key ${key}`;
  if (region !== endpointRegion || service !== "secretsmanager")
    return `signed for ${region}/${service}, not ${endpointRegion}/secretsmanager`;
  if (headers.get("x-amz-security-token") !== SESSION_TOKEN) return "no session token";
  const canonicalHeaders = signedHeaders
    .split(";")
    .map((name) => `${name}:${(headers.get(name) ?? "").trim()}\n`)
    .join("");
  const canonical = [method, url.pathname, url.search.slice(1), canonicalHeaders, signedHeaders, sha256(body)].join(
    "\n",
  );
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", headers.get("x-amz-date"), scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
  const expected = createHmac("sha256", signingKey).update(toSign).digest("hex");
  return expected === signature ? undefined : "signature mismatch";
}

export interface AwsStandIn {
  fetch: typeof fetch;
  /** Every request, as `METHOD host/path`. */
  calls: string[];
  /** What the stand-in refused, and why. */
  problems: string[];
}

/**
 * `secretString` is what Secrets Manager answers for `secretId`. `verifyWith` is the secret key the signature is checked
 * against: the one the metadata service handed out, unless a test gives another to see a mismatch refused.
 */
export function awsStandIn(secretId: string, secretString: string, verifyWith: string = SECRET_ACCESS_KEY): AwsStandIn {
  const region = secretId.split(":")[3] as string;
  const calls: string[] = [];
  const problems: string[] = [];
  const refuse = (why: string, status: number) => {
    problems.push(why);
    return new Response(why, { status });
  };
  const standIn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push(`${method} ${url.host}${url.pathname}`);
    if (init?.signal === undefined || init.signal === null) return refuse(`${method} ${url.host} has no timeout`, 500);
    if (url.host === "169.254.169.254") {
      if (url.pathname === "/latest/api/token") return new Response("IMDS-TOKEN");
      if (headers.get("x-aws-ec2-metadata-token") !== "IMDS-TOKEN") return new Response("no token", { status: 401 });
      if (url.pathname.endsWith("/security-credentials/")) return new Response("execution_role\n");
      return Response.json({ AccessKeyId: ACCESS_KEY_ID, SecretAccessKey: SECRET_ACCESS_KEY, Token: SESSION_TOKEN });
    }
    if (url.host === `secretsmanager.${region}.amazonaws.com`) {
      const body = String(init?.body);
      const problem = sigV4Problem(method, url, headers, body, verifyWith, region);
      if (problem) return refuse(problem, 403);
      if (headers.get("x-amz-target") !== "secretsmanager.GetSecretValue") return refuse("wrong target", 400);
      if ((JSON.parse(body) as { SecretId?: string }).SecretId !== secretId) return refuse("wrong secret id", 400);
      return Response.json({ SecretString: secretString });
    }
    return refuse(`unexpected host ${url.host}`, 500);
  };
  return { fetch: standIn, calls, problems };
}
