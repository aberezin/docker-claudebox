import { test, expect, describe } from "bun:test";
import { Spinner, NULL_PROGRESS } from "./Spinner.ts";
import { StringWriter } from "../cli/Context.ts";

/** Build a spinner over a captured writer with a hand-cranked clock. */
function build(isTty = true): { s: Spinner; out: StringWriter; advance: (ms: number) => void } {
  const out = new StringWriter();
  let t = 1_000;
  const s = new Spinner({ out, isTty, now: () => t });
  return { s, out, advance: (ms) => { t += ms; } };
}

describe("Spinner — TTY animation", () => {
  test("renders a frame on begin and overwrites in place, never newlines", () => {
    const { s, out } = build();
    s.begin("seeding image cb-infra → cb-abc");
    s.tick();
    s.tick();
    const text = out.text();
    // Every frame starts with \r + clear-to-EOL, so the row is reused.
    expect(text.startsWith("\r\x1b[K")).toBe(true);
    // No newline while spinning — a newline is what pollutes scrollback.
    expect(text).not.toContain("\n");
    expect(text).toContain("seeding image cb-infra → cb-abc");
    // Distinct frames, i.e. it is actually animating.
    expect(text).toContain("⠋");
    expect(text).toContain("⠙");
  });

  test("elapsed seconds come from the injected clock", () => {
    const { s, out, advance } = build();
    const done = s.begin("seeding");
    advance(23_000);
    s.tick();
    expect(out.text()).toContain("(23s)");
    advance(2_000);
    done();
    expect(out.text()).toContain("✓ seeding (25s)");
  });

  test("completion clears the animation row, then writes one clean line", () => {
    const { s, out } = build();
    const done = s.begin("seeding");
    done({ summary: "image seeded" });
    const text = out.text();
    // The last clear precedes the final line, so the next status line the
    // command writes starts at column 0 on a fresh row.
    expect(text.endsWith("✓ image seeded (0s)\n")).toBe(true);
    expect(text).toContain("\r\x1b[K✓");
  });
});

describe("Spinner — non-TTY", () => {
  test("emits NO animation frames but STILL reports completion", () => {
    const { s, out, advance } = build(false);
    const done = s.begin("seeding");
    s.tick(); s.tick();
    advance(31_000);
    done({ summary: "image seeded" });
    const text = out.text();
    // \r-overwriting into a pipe or log file is unreadable, so no frames...
    expect(text).not.toContain("\r");
    expect(text).not.toContain("⠋");
    // ...but a non-interactive run must still record that this happened and
    // how long it took. Silence would be the easier choice and the worse one.
    expect(text).toBe("✓ image seeded (31s)\n");
  });
});

describe("Spinner — outcome honesty", () => {
  test("a failed phase is marked ✗, not ✓", () => {
    const { s, out } = build();
    const done = s.begin("seeding");
    done({ ok: false, summary: "image seed FAILED (rc 1)" });
    expect(out.text()).toContain("✗ image seed FAILED (rc 1)");
    expect(out.text()).not.toContain("✓");
  });
});

describe("Spinner — misuse resistance", () => {
  test("calling done twice prints one completion line", () => {
    const { s, out } = build();
    const done = s.begin("seeding");
    done();
    done();
    expect(out.text().match(/✓/g)?.length).toBe(1);
  });

  test("a second begin() while one is live is ignored, not interleaved", () => {
    const { s, out } = build();
    const first = s.begin("first");
    const second = s.begin("second");
    second();              // no-op handle
    expect(out.text()).not.toContain("second");
    first();
    expect(out.text().match(/✓/g)?.length).toBe(1);
  });

  test("tick() after completion is inert (a late timer callback can't reopen the row)", () => {
    const { s, out } = build();
    const done = s.begin("seeding");
    done();
    const after = out.text();
    s.tick();
    expect(out.text()).toBe(after);
  });

  test("the real timer is cancelled on completion", () => {
    const out = new StringWriter();
    let cancelled = false;
    const s = new Spinner({
      out, isTty: true, now: () => 0,
      schedule: () => ({ cancel: () => { cancelled = true; } }),
    });
    s.begin("seeding")();
    // A live interval after the phase ends would keep writing frames over
    // whatever the command prints next.
    expect(cancelled).toBe(true);
  });
});

describe("NULL_PROGRESS", () => {
  test("is silent and its handle is safe to call", () => {
    const done = NULL_PROGRESS.begin("anything");
    expect(() => { done(); done({ ok: false }); }).not.toThrow();
  });
});
