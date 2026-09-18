/** Shared `text/plain` reply for channels + the host (error/status responses). */
export const textHeaders = { "content-type": "text/plain" } as const;

export const text = (body: string, status: number): Response => new Response(body, { status, headers: textHeaders });

/**
 * Tag a reply from a route fastagent OWNS as browser-callable.
 *
 * ONE function, because both fastagent-owned surfaces need it and they are reached by different code: `/invoke` is a
 * literal route, `/control/*` is a mounted prefix. A channel's route is NOT tagged — its caller is a platform's
 * server, and a webhook that answers cross-origin requests is a webhook someone can drive from a page.
 *
 * `authorization` is allowed even though nothing here reads it: a deployment that fronts this port with real auth
 * has a browser sending that header, and a preflight we refuse is a deployment that cannot use its own gateway.
 */
export function withCors(res: Response, allowMethods: string): Response {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-headers", "authorization, content-type");
  res.headers.set("access-control-allow-methods", allowMethods);
  return res;
}
