/**
 * The conversation a message of a group's main timeline belongs to: one per sender, so one person's long task does not
 * hold up another's question and their follow-ups reach their own session (docs/design/place-sessions.md). A DM, a
 * thread or topic, and a custom route's conversation are not main timelines and do not come through here.
 *
 * A sender the platform gave no id (an anonymous admin, a channel post, a tenant whose events carry none) has no
 * session of their own: they share the place's, as before, and so can still hold each other up.
 */
export function senderConversation(place: string, sender: string | number | undefined): string {
  return sender === undefined || sender === "" ? place : `${place}#${sender}`;
}

/** Whether `conversation` is one sender's in `place`: the answers it gets are what the place's other senders miss. */
export function isSenderConversation(place: string, conversation: string): boolean {
  return conversation.startsWith(`${place}#`);
}
