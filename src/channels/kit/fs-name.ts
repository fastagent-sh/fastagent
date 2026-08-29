/**
 * ONE reduction of external text to a single filesystem path segment, for the attachment directories
 * every chat channel writes under its state home (`<filesDir>/<conversation>/<file>`).
 *
 * Both halves of that path are external: the file NAME comes from the platform, and the DIRECTORY
 * comes from the channel's route — `route.chatId` / `route.channelId`, which the agent's author
 * writes. Each channel sanitized the name and left the directory raw, so a route returning
 * `chatId: "../.."` wrote outside the state home, silently. The two halves are the same question, so
 * they get the same answer here rather than one guard per platform (which is how the directory came
 * to be missing three times).
 *
 * Containment beats uniqueness: `a/b` and `a_b` fold to one segment. Real platform ids carry no
 * separator, so that collision needs a hostile custom route to reach.
 */

/** A single path segment: no separators, no traversal, never empty. */
export function safeSegment(value: string | number, fallback = "file"): string {
  // `.` and `..` are traversal; a leading dot also hides the entry, which is not a channel's call to
  // make. Collapsing every leading dot covers both without a special case per spelling.
  return String(value).replace(/[/\\]/g, "_").replace(/^\.+/, "_") || fallback;
}
