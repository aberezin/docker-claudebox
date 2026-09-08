import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Enforces that every line written to the FETCHER LOG carries a timestamp.
 *
 * WHY THIS EXISTS
 * ---------------
 * #90 asked for timestamps on the fetcher log. It was "fixed" three times in
 * one afternoon and was incomplete each time — not because any fix was wrong,
 * but because each coverage CLAIM was made by reading rather than enumerating:
 *
 *   1. 5.8.0's retry fix ADDED an untimed line to the very log #90 is about.
 *   2. 6a47bee grepped `runWatch` for write sites and stopped at the module
 *      being edited, missing InboxSink — which writes to the same log.
 *   3. 3fb8a33 fixed InboxSink's `poll failed`, grepped for the string, saw a
 *      hit that was already timestamped, and declared the issue covered. There
 *      were TWO sites with identical text; only one was fixed.
 *
 * Every one of those was caught by a human asking a question that forced an
 * enumeration. That is not a control. This test is the control: it enumerates
 * the write sites itself and fails on any new bare one, so the next person to
 * add a log line cannot ship it untimed and believe otherwise.
 *
 * Deliberately source-text based. A runtime test would only cover the lines a
 * fixture happens to trigger, and the whole failure mode here is lines nobody
 * thought to look at.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = [
  join(HERE, "InboxSink.ts"),
  join(HERE, "..", "cli", "commands", "TeamCommand.ts"),
];

/**
 * Sites allowed to be bare, each with the reason. These run BEFORE the watch
 * loop starts and exit immediately, so there is no log to correlate them
 * against — they go to a terminal the operator is already looking at.
 *
 * Matched on a distinctive substring. Adding to this list is a deliberate act
 * that shows up in review; forgetting a timestamp is not.
 */
const ALLOWED_BARE = [
  "no GitHub repo configured",  // pre-loop validation; prints and exits
  "invalid repo '",             // pre-loop validation; prints and exits
];

interface Site { file: string; line: number; text: string }

/**
 * Scope matters. TeamCommand.ts also holds `post` / `whoami` / `roster`, whose
 * errors go to an operator's terminal in real time — timestamping those is
 * noise, and a noisy check gets switched off, which is how enforcement dies.
 * So only the FETCHER path is scanned: `runWatch` and everything in InboxSink.
 */
function fetcherRegion(path: string, src: string): { start: number; end: number } {
  const lines = src.split("\n");
  if (!path.endsWith("TeamCommand.ts")) return { start: 0, end: lines.length };
  const start = lines.findIndex((l) => /private async runWatch\(/.test(l));
  if (start === -1) throw new Error("runWatch not found — scanner needs updating, not deleting");
  // Ends at the next method declared at the same indent.
  const rest = lines.slice(start + 1).findIndex((l) => /^  private (async )?[a-zA-Z]/.test(l));
  return { start, end: rest === -1 ? lines.length : start + 1 + rest };
}

function writeSites(path: string): Site[] {
  const src = readFileSync(path, "utf8");
  const { start, end } = fetcherRegion(path, src);
  const out: Site[] = [];
  src.split("\n").forEach((raw, i) => {
    if (i < start || i >= end) return;
    // Only lines that actually emit to the log stream.
    if (!/\b(?:ctx|deps)\.stderr\.write\(|^\s*logLine\(/.test(raw)) return;
    out.push({ file: path.split("/").slice(-1)[0]!, line: i + 1, text: raw.trim() });
  });
  return out;
}

/** A site is timestamped if it interpolates an ISO clock or delegates to the
 *  `logLine` helper, which prepends one. */
function isTimestamped(text: string): boolean {
  return text.includes("toISOString") || /^logLine\(/.test(text);
}

/**
 * Continuation lines are exempt by CONVENTION, not by exemption list.
 *
 * A multi-line diagnostic prints one timestamped header followed by indented
 * detail. Timestamping every continuation would make `grep '^2026-'` return one
 * hit per line instead of one per event, which is the opposite of what the
 * timestamps are for — Bear's rationale in 6a47bee, and it is right.
 *
 * Detected structurally: the emitted literal opens with whitespace. That keeps
 * the rule self-maintaining, where an exemption list would need an entry for
 * every new detail line and would rot.
 */
function isContinuation(text: string): boolean {
  return /\.write\(\s*`\s/.test(text);
}

function isAllowedBare(text: string): boolean {
  return ALLOWED_BARE.some((frag) => text.includes(frag));
}

describe("fetcher log — every emitted line is timestamped or explicitly exempt", () => {
  test("no bare log line escapes without being on the exemption list", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      for (const s of writeSites(f)) {
        if (isTimestamped(s.text) || isContinuation(s.text) || isAllowedBare(s.text)) continue;
        offenders.push(`${s.file}:${s.line}  ${s.text.slice(0, 100)}`);
      }
    }
    // The message matters as much as the assertion: whoever trips this is
    // mid-edit and needs to know both options, not just that they failed.
    expect(offenders, offenders.length === 0 ? "" : [
      "",
      "Untimed fetcher-log line(s):",
      ...offenders.map((o) => `  ${o}`),
      "",
      "Either prepend `${new Date().toISOString()} ` (or use logLine()),",
      "or, if it is indented detail under a timestamped header, start the",
      "literal with whitespace so it reads as a continuation.",
      "Last resort: add a substring to ALLOWED_BARE with the reason.",
      "See the header of this file for why the honour system did not work.",
    ].join("\n")).toEqual([]);
  });

  test("the scanner actually finds sites (guards against a regex that matches nothing)", () => {
    // A silent-green enforcement test is worse than none: it reports success
    // while checking nothing. Pin a floor so a broken pattern fails loudly.
    const total = FILES.reduce((n, f) => n + writeSites(f).length, 0);
    expect(total).toBeGreaterThan(5);
  });

  test("every ALLOWED_BARE entry still matches a real site", () => {
    // Stale exemptions silently widen the hole. If a line is renamed or
    // deleted, its exemption must go too.
    const all = FILES.flatMap(writeSites).map((s) => s.text);
    const dead = ALLOWED_BARE.filter((frag) => !all.some((t) => t.includes(frag)));
    expect(dead, `exemptions matching nothing (remove them): ${dead.join(", ")}`).toEqual([]);
  });
});
