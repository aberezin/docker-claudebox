/**
 * dridock's debug switch (#130): `DRIDOCK_DEBUG`, one rule in every reader.
 *
 * Until 6.1 it was bare `DEBUG`, the one dridock setting outside the DRIDOCK_*
 * namespace, read by four parsers with three rules: `DEBUG=1` turned on the API
 * daemon's logging but not the entrypoint's or cron's, and `DEBUG=TRUE` was
 * dropped by the host before anything could disagree.
 *
 * The rule, mirrored in entrypoint.sh, cron.py and api_server.py and pinned
 * together by tests/test_debug_flag_mirror.sh:
 *   on:  1 true yes on        (any case)
 *   off: "" 0 false no off    (any case)
 *   anything else: off, and SAID.
 *
 * Legacy bare `DEBUG` is honoured through 6.x only when its value is one of
 * those words, with a nudge. Anything else (npm's `DEBUG=express:*`) belongs to
 * another tool and is left alone. Removed in 7.0.0 (docs/roadmap.md).
 */
export const DEBUG_ON = ["1", "true", "yes", "on"] as const;
export const DEBUG_OFF = ["", "0", "false", "no", "off"] as const;

export type DebugValue = "on" | "off" | "invalid";

export function parseDebugValue(v: string | undefined): DebugValue {
  const s = (v ?? "").trim().toLowerCase();
  if ((DEBUG_ON as readonly string[]).includes(s)) return "on";
  if ((DEBUG_OFF as readonly string[]).includes(s)) return "off";
  return "invalid";
}

/** Whether debug is on for this run, and the lines to print about how it was decided. */
export function resolveDebug(env: Record<string, string | undefined>): { on: boolean; notes: string[] } {
  const notes: string[] = [];
  const canonical = env["DRIDOCK_DEBUG"];
  if (canonical !== undefined && canonical !== "") {
    const p = parseDebugValue(canonical);
    if (p === "invalid") {
      notes.push(`⚠️  DRIDOCK_DEBUG=${canonical} isn't a recognised value, so debug stays off (use 1/true/yes/on or 0/false/no/off, #130).\n`);
    }
    return { on: p === "on", notes };
  }
  const legacy = env["DEBUG"];
  if (legacy !== undefined && legacy !== "") {
    const p = parseDebugValue(legacy);
    if (p !== "invalid") {
      notes.push(`!  DEBUG=${legacy} is read as DRIDOCK_DEBUG for now; it's renamed (#130) and bare DEBUG stops working in 7.0.0. Use DRIDOCK_DEBUG=${legacy}.\n`);
      return { on: p === "on", notes };
    }
    // Not a boolean word: someone else's DEBUG (npm's `DEBUG=express:*`). Not ours.
  }
  return { on: false, notes };
}

/** The env pairs that carry it into a container: the new name, plus the old one so a pre-6.1 image still honours it. */
export function debugEnvPairs(on: boolean): { key: string; value: string }[] {
  return on ? [{ key: "DRIDOCK_DEBUG", value: "1" }, { key: "DEBUG", value: "true" }] : [];
}
