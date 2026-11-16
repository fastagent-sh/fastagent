/** Shared `text/plain` reply for channels + the host (error/status responses). */
const textHeaders = { "content-type": "text/plain" } as const;

export const text = (body: string, status: number): Response => new Response(body, { status, headers: textHeaders });
