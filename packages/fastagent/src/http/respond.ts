/** The serve's `text/plain` replies (errors, statuses). */
const textHeaders = { "content-type": "text/plain" } as const;

export const text = (body: string, status: number): Response => new Response(body, { status, headers: textHeaders });
