/**
 * A schedule's cron in EventBridge Scheduler's dialect: `cron(m h dom mon dow year)`, Quartz-flavoured, with exactly
 * one of the two day fields `?` and 1 = Sunday. AgentCore fires each schedule from a recurring EventBridge schedule
 * the container sets (schedule/wake-alarm.ts), so a schedule must translate to be one at all: discovery refuses one
 * that does not, on every host, so that what runs locally also runs there.
 */

/** Remap ONE day-of-week field from standard cron numbering (0–7, 0/7 = Sunday) to EventBridge's (1–7, 1 = Sunday). */
function mapDowField(dow: string): { value: string } | { error: string } {
  const items: string[] = [];
  for (const item of dow.split(",")) {
    const slash = item.split("/");
    if (slash.length > 2 || slash.some((part) => part === "")) {
      return { error: `malformed day-of-week token "${item}"` };
    }
    const [body, step] = slash as [string, string?];
    if (step !== undefined && !/^\d+$/.test(step)) return { error: `malformed day-of-week step "${item}"` };
    let mapped: string;
    if (body === "*") {
      mapped = "*";
    } else {
      const endpoints = body.split("-");
      if (endpoints.length > 2 || endpoints.some((part) => part === "")) {
        return { error: `malformed day-of-week token "${item}"` };
      }
      const remapped = endpoints.map((p) => (/^\d+$/.test(p) ? String((Number(p) % 7) + 1) : p));
      if (
        remapped.length === 2 &&
        remapped.every((p) => /^\d+$/.test(p)) &&
        Number(remapped[0]) > Number(remapped[1])
      ) {
        return {
          error:
            `day-of-week range "${body}" wraps across the week under EventBridge numbering (1 = Sunday) — ` +
            `split it into an explicit list`,
        };
      }
      mapped = remapped.join("-");
    }
    items.push(step !== undefined ? `${mapped}/${step}` : mapped);
  }
  return { value: items.join(",") };
}

/**
 * Translate a 5-field cron into EventBridge Scheduler's `cron(m h dom mon dow *)`, or say why it can't be. The two
 * fire on the same instants, in the same zone (EventBridge, like croner, skips a time a DST change removes and fires
 * a repeated one once).
 */
export function toEventBridgeCron(cron: string): { expression: string } | { error: string } {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { error: `EventBridge supports 5-field cron only (got ${fields.length} fields)` };
  }
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (/[L#]/i.test(dow) || /[L#]/i.test(dom)) {
    return { error: "L/# day forms don't translate to EventBridge numbering — set this schedule up manually" };
  }
  // `?` FIRST, and not as a synonym for `*`.
  if (dom === "?" || dow === "?") {
    return { expression: `cron(${min} ${hour} * ${mon} ? *)` };
  }
  if (dom !== "*" && dow !== "*") {
    return {
      error: "restricting BOTH day-of-month and day-of-week (cron OR semantics) is not expressible in EventBridge",
    };
  }
  if (dow === "*") {
    return { expression: `cron(${min} ${hour} ${dom} ${mon} ? *)` };
  }
  const mapped = mapDowField(dow);
  if ("error" in mapped) return mapped;
  return { expression: `cron(${min} ${hour} ? ${mon} ${mapped.value} *)` };
}
