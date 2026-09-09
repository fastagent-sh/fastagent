/** The replay window every signed webhook ingress needs. */

/**
 * Whether a Unix-SECONDS timestamp header is within `maxAgeS` of now, in either direction (a clock ahead of ours is as
 * suspect as one behind).
 */
export function signatureIsFresh(timestamp: string, maxAgeS: number, nowMs = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  return Number.isSafeInteger(seconds) && Math.abs(Math.floor(nowMs / 1000) - seconds) <= maxAgeS;
}
