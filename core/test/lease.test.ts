import { describe, expect, it } from "vitest";
import { inProcessLease } from "../src/index.ts";

describe("inProcessLease (fail-fast 单写者)", () => {
  it("同 session 已占用 → 第二次 tryAcquire 返回 null(不排队)", () => {
    const lease = inProcessLease();
    const r1 = lease.tryAcquire("s");
    expect(r1).not.toBeNull();
    expect(lease.tryAcquire("s")).toBeNull(); // busy
    r1!();
    expect(lease.tryAcquire("s")).not.toBeNull(); // acquirable again after release
  });

  it("不同 session 互不影响", () => {
    const lease = inProcessLease();
    expect(lease.tryAcquire("a")).not.toBeNull();
    expect(lease.tryAcquire("b")).not.toBeNull(); // b unaffected by a's occupancy
  });

  it("release 幂等,且不误放他人", () => {
    const lease = inProcessLease();
    const r = lease.tryAcquire("s")!;
    r();
    r(); // double release is safe
    const r2 = lease.tryAcquire("s")!; // still acquirable normally
    expect(r2).not.toBeNull();
    // calling the stale release must not free r2's lease
    r();
    expect(lease.tryAcquire("s")).toBeNull(); // r2 still holds it
  });
});
