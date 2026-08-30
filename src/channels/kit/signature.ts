/**
 * The replay window every signed webhook ingress needs. A signature covers its timestamp but proves
 * nothing about it, so without a window a captured body plus its signed headers replays forever.
 * The window LENGTH is the caller's: it is set by the platform's own redelivery schedule, not by us.
 */

/**
 * Whether a Unix-SECONDS timestamp header is within `maxAgeS` of now, in either direction (a clock
 * ahead of ours is as suspect as one behind). Non-numeric is not fresh: the header is part of the
 * signed material, so a value the signature commits to but this cannot read is a reason to refuse,
 * not to wave through.
 */
export function signatureIsFresh(timestamp: string, maxAgeS: number, nowMs = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  return Number.isSafeInteger(seconds) && Math.abs(Math.floor(nowMs / 1000) - seconds) <= maxAgeS;
}
