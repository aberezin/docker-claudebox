import { test, expect, describe } from "bun:test";
import { isPidAlive, type ProcessProbe } from "./PidLiveness.ts";

// Spec: #56 open loop #4 — cmdline check on every liveness probe.
// The class of failure these tests exist to prevent: pid wraparound
// after reboot returns kill(pid,0) === alive on a pid now owned by an
// unrelated process, giving a green light on silent starvation.

class FakeProbe implements ProcessProbe {
  constructor(
    private readonly running: Set<number> = new Set(),
    private readonly cmdlines: Map<number, string> = new Map(),
  ) {}
  isRunning(pid: number): boolean { return this.running.has(pid); }
  getCommandLine(pid: number): string | undefined { return this.cmdlines.get(pid); }
}

const OUR_INBOX = "/xdg/dridock/inbox/Bear.jsonl";
const OUR_CMDLINE = `/usr/local/lib/dridock/dridock team watch --inbox ${OUR_INBOX}\n`;
const OTHER_INBOX = "/xdg/dridock/inbox/Arfy.jsonl";
const OTHER_CMDLINE = `/usr/local/lib/dridock/dridock team watch --inbox ${OTHER_INBOX}\n`;
const UNRELATED_CMDLINE = "sleep 3600\n"; // classic pid-reuse false-positive case
const SUDO_UNRELATED_CMDLINE = "/usr/sbin/sshd -D\n"; // "held by root after reboot"

describe("isPidAlive — bare pid check (no cmdline required)", () => {
  test("nonexistent pid → false", () => {
    const probe = new FakeProbe();
    expect(isPidAlive(999, undefined, probe)).toBe(false);
  });

  test("existing pid, no cmdline requirement → true", () => {
    const probe = new FakeProbe(new Set([999]));
    expect(isPidAlive(999, undefined, probe)).toBe(true);
  });

  test("existing pid + no cmdline available → still true (no requirement)", () => {
    // Skipping the cmdline check because caller didn't ask for one:
    // no getCommandLine call, no data needed.
    const probe = new FakeProbe(new Set([999]));
    expect(isPidAlive(999, undefined, probe)).toBe(true);
  });
});

describe("isPidAlive — cmdline verification (the whole point of #56 #4)", () => {
  test("our-fetcher cmdline + matching inbox → true", () => {
    const probe = new FakeProbe(new Set([1234]), new Map([[1234, OUR_CMDLINE]]));
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(true);
  });

  test("pid-reuse case: alive but cmdline is unrelated (sleep) → false", () => {
    // This is the exact wraparound-after-reboot silent-starvation
    // failure. Without cmdline verification we'd return true and skip
    // respawn. The whole point of this refactor.
    const probe = new FakeProbe(new Set([1234]), new Map([[1234, UNRELATED_CMDLINE]]));
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(false);
  });

  test("pid-reuse case: alive but cmdline is a system daemon → false", () => {
    // Post-reboot pid owned by root running sshd. The old EPERM=alive
    // shortcut would false-positive; the cmdline check catches it.
    const probe = new FakeProbe(new Set([1234]), new Map([[1234, SUDO_UNRELATED_CMDLINE]]));
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(false);
  });

  test("wrong agent's fetcher: has 'dridock team watch' but wrong inbox → false", () => {
    // Someone spawned Arfy's fetcher; we're checking for Bear's. Both
    // substring parts must match; a partial hit is a mismatch.
    const probe = new FakeProbe(new Set([1234]), new Map([[1234, OTHER_CMDLINE]]));
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(false);
  });

  test("alive but ps returned undefined (permission denied / weird state) → false", () => {
    // Can't confirm the cmdline → treat as dead. Safe direction:
    // respawn is recoverable; silent starvation isn't.
    const probe = new FakeProbe(new Set([1234])); // isRunning=true, cmdline=undefined
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(false);
  });

  test("not running at all → false regardless of what cmdline map says", () => {
    // The isRunning check short-circuits: an entry in the cmdline map
    // for a not-running pid shouldn't false-positive. Belt-and-
    // suspenders against a corrupt fake, but also the real invariant.
    const probe = new FakeProbe(new Set(), new Map([[1234, OUR_CMDLINE]]));
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(false);
  });

  test("cmdline substring is order-independent — both 'team watch' and inbox anywhere in cmdline", () => {
    // Real cmdlines have "dridock team watch --inbox <path>" — inbox
    // path is AFTER the tool. Test that we don't accidentally require
    // a specific position.
    const oddOrder = `some-wrapper --arg=${OUR_INBOX} dridock team watch\n`;
    const probe = new FakeProbe(new Set([1234]), new Map([[1234, oddOrder]]));
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(true);
  });

  test("empty expectedCmdlineContains string matches everything (edge case, don't do this)", () => {
    // `"".includes("")` returns true — an empty substring is a
    // wildcard. Callers must pass a non-empty string; not enforced
    // here but documented so nobody thinks it's a bug.
    const probe = new FakeProbe(new Set([1234]), new Map([[1234, "totally unrelated"]]));
    expect(isPidAlive(1234, "", probe)).toBe(false); // fails on "dridock team watch" hardcode still
  });
});

describe("isPidAlive — the hardcoded 'dridock team watch' substring", () => {
  test("missing 'dridock team watch' in cmdline → false even if inbox path matches", () => {
    // Sanity: both substrings must be present. Just having the inbox
    // path (e.g., a `cat` process reading the inbox) isn't enough.
    const cmdline = `cat ${OUR_INBOX}\n`;
    const probe = new FakeProbe(new Set([1234]), new Map([[1234, cmdline]]));
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(false);
  });

  test("has 'dridock team watch' but wrong subverb → matches (tool prefix is what we check)", () => {
    // "dridock team watch --once --repo x" is a legitimate stdout-mode
    // watcher, not a fetcher — different --inbox arg absent. We don't
    // distinguish here because the inbox-path substring is what
    // determines "our fetcher". A stdout watcher wouldn't have our
    // inbox path in its cmdline, so this returns false anyway.
    const stdoutMode = `/usr/local/lib/dridock/dridock team watch --once --repo x\n`;
    const probe = new FakeProbe(new Set([1234]), new Map([[1234, stdoutMode]]));
    expect(isPidAlive(1234, OUR_INBOX, probe)).toBe(false); // inbox path absent
  });
});
