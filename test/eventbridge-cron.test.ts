import { Cron } from "croner";
import { describe, expect, it } from "vitest";
import { cronError } from "../src/schedule/cron.ts";
import { toEventBridgeCron } from "../src/schedule/eventbridge-cron.ts";

describe("schedule/eventbridge-cron", () => {
  const expression = (cron: string): string => {
    const r = toEventBridgeCron(cron);
    if ("error" in r) throw new Error(r.error);
    return r.expression;
  };
  const error = (cron: string): string => {
    const r = toEventBridgeCron(cron);
    if ("expression" in r) throw new Error(`unexpectedly translated: ${r.expression}`);
    return r.error;
  };

  // One pure translation, its whole mapping table: dow renumbering, dom/dow exclusivity, names,
  // steps, lists, and the `?` field croner reads as unrestricted.
  it("translates every 5-field cron shape into the Quartz-flavoured EventBridge form", () => {
    expect(expression("0 * * * *")).toBe("cron(0 * * * ? *)"); // both wildcards → dow becomes ?
    expect(expression("30 6 1 * *")).toBe("cron(30 6 1 * ? *)"); // a dom restriction keeps dom
    // Standard 0/7 = Sunday, EventBridge 1 = Sunday.
    expect(expression("0 9 * * 1")).toBe("cron(0 9 ? * 2 *)");
    expect(expression("0 9 * * 0")).toBe("cron(0 9 ? * 1 *)");
    expect(expression("0 9 * * 7")).toBe("cron(0 9 ? * 1 *)");
    expect(expression("0 9 * * 1-5")).toBe("cron(0 9 ? * 2-6 *)");
    expect(expression("0 9 * * MON")).toBe("cron(0 9 ? * MON *)"); // names pass through unmapped
    // Steps are COUNTS, not weekdays: preserved verbatim while values/endpoints remap.
    expect(expression("0 9 * * */2")).toBe("cron(0 9 ? * */2 *)");
    expect(expression("0 9 * * 1-5/2")).toBe("cron(0 9 ? * 2-6/2 *)");
    expect(expression("0 9 * * 1,3,5")).toBe("cron(0 9 ? * 2,4,6 *)"); // lists remap per element
    expect(expression("0 9 * * MON,3")).toBe("cron(0 9 ? * MON,4 *)");
    // A `?` field is UNRESTRICTED — croner reads it as daily, so the deployed rule must say daily.
    // Carrying MON/1 across would deploy a schedule the workspace never runs.
    expect(expression("0 9 ? * MON")).toBe("cron(0 9 * * ? *)");
    expect(expression("0 9 1 * ?")).toBe("cron(0 9 * * ? *)");
    expect(expression("0 9 * * ?")).toBe("cron(0 9 * * ? *)");
    expect(expression("0 9 ? * *")).toBe("cron(0 9 * * ? *)");
  });

  it("refuses what EventBridge cannot express, with the reason", () => {
    expect(error("0 9 1 * 1")).toMatch(/BOTH day-of-month and day-of-week/);
    expect(error("0 0 9 * * 1")).toMatch(/5-field/);
    expect(error("0 9 * * 5L")).toMatch(/L\/#/);
    expect(error("0 9 * * 5-7")).toMatch(/wraps across the week/); // Fri–Sun → 6-1: not a valid range
    expect(error("0 9 * * 1-")).toMatch(/malformed/);
    expect(error("0 9 * * 1/")).toMatch(/malformed/);
  });
});

describe("schedule/eventbridge-cron vs the Croner dialect the workspace actually accepts", () => {
  /**
   * The property that matters is not "the string looks right" but "the DEPLOYED rule fires on the
   * same days the workspace's own scheduler fires on". So: expand both sides and compare.
   * EventBridge's cron is Quartz-flavoured 6-field — day-of-week names, exactly one of DOM/DOW as
   * `?` — which for the day-selection question this checks maps onto croner once the trailing year
   * field is dropped and the `?` field is read as `*` (EventBridge has no OR semantics: the `?`
   * field is genuinely unrestricted).
   */
  const firingDays = (cron: string, count: number): string[] => {
    const c = new Cron(cron, { timezone: "UTC" });
    const out: string[] = [];
    let prev: Date | null = null;
    for (let i = 0; i < count; i++) {
      prev = c.nextRun(prev ?? new Date("2026-07-29T00:00:00Z"));
      if (!prev) break;
      out.push(prev.toISOString().slice(0, 16));
    }
    return out;
  };
  const eventBridgeDays = (expression: string, count: number): string[] => {
    const [min, hour, dom, mon, dowRaw] = expression.slice(5, -1).split(" ") as [
      string,
      string,
      string,
      string,
      string,
    ];
    // `?` = unrestricted; croner reads `*` for that, without the OR quirk (only one can be `?`).
    const dow = dowRaw === "?" ? "*" : dowRaw;
    return firingDays(`${min} ${hour} ${dom === "?" ? "*" : dom} ${mon} ${dow}`, count);
  };

  it.each([
    "0 9 * * MON", // the plain weekly form
    "0 9 1 * *", // day-of-month
    "*/5 * * * *", // the every-N form a deploy test actually uses
    "0 9 ? * MON", // `?` is NOT `*` in croner: this fires DAILY, whatever MON suggests
    "0 9 1 * ?", // …and here too, whatever the 1st suggests
    "0 9 * * ?",
    "0 9 ? * *",
  ])("%s fires on the same days locally and on EventBridge", (cron) => {
    expect(cronError(cron, undefined)).toBeUndefined();
    const out = toEventBridgeCron(cron);
    expect("expression" in out).toBe(true);
    const expression = (out as { expression: string }).expression;
    // 10 occurrences is enough to separate daily / weekly / monthly patterns.
    expect(eventBridgeDays(expression, 10)).toEqual(firingDays(cron, 10));
    // EventBridge rejects both day fields wildcarded, and both restricted: exactly one `?`.
    const fields = expression.slice(5, -1).split(" ");
    expect([fields[2], fields[4]].filter((f) => f === "?")).toHaveLength(1);
  });

  it("refuses what EventBridge genuinely cannot express, rather than deploying a different schedule", () => {
    // Cron ORs two RESTRICTED day fields (the 15th OR any Wednesday); EventBridge has no such form.
    expect(cronError("0 9 15 * WED", undefined)).toBeUndefined();
    expect(toEventBridgeCron("0 9 15 * WED")).toMatchObject({ error: expect.stringContaining("BOTH") });
  });
});
