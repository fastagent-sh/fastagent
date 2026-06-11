/**
 * SPEC conformance assertions — Agent Handler v0.1 (docs/SPEC.md), runnable
 * against ANY Agent implementation. Engine-free: everything engine-specific is
 * supplied by the subject (the WSGI-validator posture — the SPEC is the design,
 * this file is its executable form).
 *
 * Scope: Agent-side MUSTs only (1/2/3 + optional 6). Caller-side MUSTs (4/5,
 * forward compatibility / relay passthrough) constrain consumers, not Agents —
 * they cannot be asserted against an Agent and are deliberately absent.
 * Implementation policies that the SPEC does not mandate (e.g. fastagent's
 * busy fail-fast floor) are also deliberately absent — they belong to the
 * implementation's own tests.
 */
import { describe, expect, it } from "vitest";
import type { Agent, AgentEvent } from "../src/agent.ts";

/** Engine-specific factories: each returns an Agent in a known behavioral posture. */
export interface ConformanceSubject {
  /** An agent whose turn succeeds (streams some events, then completes). */
  completing(): Agent | Promise<Agent>;
  /** An agent whose turn fails INSIDE the engine (model error, setup failure, …). */
  failing(): Agent | Promise<Agent>;
  /**
   * An agent whose turn streams long enough for the consumer to cancel mid-flight.
   * `onCleanup` must be called when the engine's in-flight work is actually
   * aborted/released (the subject knows where its cleanup hook is).
   */
  hanging(onCleanup: () => void): Agent | Promise<Agent>;
  /**
   * Optional (SPEC MUST 6, portable conformance): TWO independent agent instances
   * sharing only an external session backend — no in-process state in common.
   * `sawHistory` reports whether instance B's turn observed instance A's turn
   * (the subject knows how to probe its own engine's context).
   */
  pair?(): { a: Agent; b: Agent; sawHistory: () => boolean } | Promise<{ a: Agent; b: Agent; sawHistory: () => boolean }>;
}

const TERMINAL = new Set(["completed", "failed"]);

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const terminals = (events: AgentEvent[]) => events.filter((e) => TERMINAL.has(e.type));

/** Register the SPEC v0.1 Agent-side conformance suite for one subject. */
export function describeSpecConformance(name: string, subject: ConformanceSubject): void {
  describe(`SPEC conformance: ${name}`, () => {
    it("MUST 1 终局唯一 — 成功流:恰一个终局,是 completed,且是最后一个事件", async () => {
      const agent = await subject.completing();
      const events = await drain(agent.invoke({ session: "spec-ok" }, { text: "go" }));
      expect(events.length).toBeGreaterThan(0);
      expect(terminals(events)).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("completed");
    });

    it("MUST 1+2 失败即事件 — 引擎失败:迭代不 throw,恰一个终局,是 failed{details, retryable}", async () => {
      const agent = await subject.failing();
      // MUST 2: the iteration itself must not throw — drain() rejecting = violation.
      const events = await drain(agent.invoke({ session: "spec-fail" }, { text: "go" }));
      expect(terminals(events)).toHaveLength(1);
      const last = events.at(-1);
      expect(last?.type).toBe("failed");
      if (last?.type === "failed") {
        expect(typeof last.details).toBe("string");
        expect(typeof last.retryable).toBe("boolean");
      }
    });

    it("MUST 3 cancel — 消费者 break:无终局事件,且引擎在飞工作被清理", async () => {
      let cleaned = false;
      let resolveCleaned!: () => void;
      const cleanedSeen = new Promise<void>((r) => (resolveCleaned = r));
      const agent = await subject.hanging(() => {
        cleaned = true;
        resolveCleaned();
      });

      const seen: AgentEvent[] = [];
      for await (const e of agent.invoke({ session: "spec-cancel" }, { text: "go" })) {
        seen.push(e);
        break; // caller cancels
      }

      await Promise.race([
        cleanedSeen,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("engine cleanup never ran after cancel (MUST 3)")), 3000),
        ),
      ]);
      expect(cleaned).toBe(true);
      expect(terminals(seen)).toHaveLength(0); // (c) cancelled: no terminal expected
    });

    it("§5 事件可 JSON 序列化(成功与失败两条路径)", async () => {
      for (const make of [subject.completing, subject.failing]) {
        const agent = await make.call(subject);
        const events = await drain(agent.invoke({ session: "spec-json" }, { text: "go" }));
        for (const e of events) {
          expect(JSON.parse(JSON.stringify(e))).toEqual(e);
        }
      }
    });

    if (subject.pair) {
      it("MUST 6 portable — 同 session 跨实例连续:实例 B 看到实例 A 的 turn(无位置依赖)", async () => {
        const { a, b, sawHistory } = await subject.pair!();
        const e1 = await drain(a.invoke({ session: "spec-portable" }, { text: "turn one" }));
        expect(e1.at(-1)?.type).toBe("completed");
        const e2 = await drain(b.invoke({ session: "spec-portable" }, { text: "turn two" }));
        expect(e2.at(-1)?.type).toBe("completed");
        expect(sawHistory()).toBe(true);
      });
    }
  });
}
