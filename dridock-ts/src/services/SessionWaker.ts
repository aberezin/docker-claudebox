import { createConnection } from "node:net";
import type { FileSystem } from "../infra/FileSystem.ts";
import type { InboxRecord } from "./InboxSink.ts";

/**
 * Wake the agent's Claude session when a team-bus event lands (#107).
 *
 * Every Claude Code session binds an inbox Unix socket and exports its path
 * as $CLAUDE_CODE_MESSAGING_SOCKET. A message posted there starts a turn in
 * an idle session (or is read between tool calls in a busy one). So instead
 * of the agent keeping a Monitor armed — which expires, needs re-arming the
 * agent forgets, and leaks a task per re-arm — the fetcher posts each event
 * straight into the session.
 *
 * ## Which session
 * The SessionStart hook writes `<inbox>.wake.json` = {socket, token,
 * sessionId}, chmod 600. The fetcher re-reads it before every post, so on
 * the host (where the fetcher outlives sessions) it always targets the
 * CURRENT session, not the one it was spawned under.
 *
 * ## Why the hook gates it, not this file
 * The socket gives no acknowledgement: a held message and a delivered one
 * look identical from here. A session that bypasses permission prompts —
 * every dridock session — HOLDS a message from a process it can't prove is
 * its own child, and the fetcher is detached (reparented to init), so it
 * can't prove that. Only `crossSessionInbound: "accept"` from a trusted
 * source (managed settings, the `--settings` flag, or user settings —
 * project/local `accept` is ignored by design) gets it delivered. If the
 * fetcher posted without that, it would advance the cursor past events
 * that are actually sitting held: silent loss. So the hook writes the wake
 * file ONLY when `accept` is in force, and removes it otherwise; this file
 * trusts that contract and posts whenever the wake file exists.
 *
 * ## Cursor
 * After a successful post the session's cursor in
 * `<inbox>.session-cursors.json` is raised to the inbox size, so the
 * prompt-time drain doesn't hand the event over a second time. Raised,
 * never lowered: the hook writes the same file, and if the two race the
 * worst case is a duplicate, never a skipped event. A failed post leaves
 * the cursor alone, so the event is drained at the next prompt as before.
 */

export interface WakeTarget {
  readonly socket: string;
  readonly token?: string;
  readonly sessionId: string;
}

/** Post one message to a session socket. Resolves true when the bytes were
 *  written and the connection closed cleanly; false on any connect/write
 *  error or timeout. Injectable so tests can use a fake or a real listener. */
export type SocketPoster = (target: WakeTarget, text: string) => Promise<boolean>;

export function wakeFileFor(inboxPath: string): string { return `${inboxPath}.wake.json`; }

/** Parse the wake file. Undefined when absent or malformed — both mean
 *  "socket delivery is off", and the Monitor/drain path carries on. */
export async function readWakeTarget(fs: FileSystem, path: string): Promise<WakeTarget | undefined> {
  const raw = await fs.readTextOrUndefined(path);
  if (raw === undefined) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<WakeTarget>;
    if (typeof p.socket !== "string" || p.socket === "" || typeof p.sessionId !== "string" || p.sessionId === "") return undefined;
    return { socket: p.socket, sessionId: p.sessionId, ...(typeof p.token === "string" && p.token !== "" ? { token: p.token } : {}) };
  } catch {
    return undefined;
  }
}

/** The wire format, from Claude Code's own `[uds-messaging] Inject messages`
 *  hint (CLI 2.1.319): an optional auth line, then one user-message line. */
export function socketPayload(target: WakeTarget, text: string): string {
  const lines: string[] = [];
  if (target.token !== undefined) lines.push(JSON.stringify({ type: "auth", token: target.token }));
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  return lines.map((l) => `${l}\n`).join("");
}

/** Human-first text for one inbox event, with the raw JSONL line last so the
 *  agent can still parse it exactly as a Monitor would have delivered it. */
export function wakeText(selfName: string, record: InboxRecord, line: string): string {
  const to = record.recipients.length > 0 ? record.recipients.join(",") : "(broadcast)";
  const parts = [
    `📬 team-bus event for ${selfName} — ${record.sender} → ${to} (${record.ref})`,
    record.summary,
  ];
  if (record.url !== undefined) parts.push(record.url);
  parts.push(`inbox line: ${line}`);
  return parts.join("\n");
}

export const realSocketPoster: SocketPoster = (target, text) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => { if (!settled) { settled = true; resolve(ok); } };
    const sock = createConnection({ path: target.socket });
    // Claude Code closes a connection that hasn't sent a complete line in
    // 30s; we write everything immediately, so 5s is ample for a local socket.
    sock.setTimeout(5000, () => { sock.destroy(); done(false); });
    sock.on("error", () => done(false));
    sock.on("connect", () => {
      sock.end(socketPayload(target, text), () => { /* flushed */ });
    });
    sock.on("close", (hadError) => done(!hadError));
  });

/** Raise `sessionId`'s cursor to `offset`, never lowering it. Atomic write.
 *  Returns false (and leaves the file alone) if it can't be read as JSON —
 *  never clobber a cursors file it can't parse. */
export async function raiseCursor(fs: FileSystem, cursorsPath: string, sessionId: string, offset: number): Promise<boolean> {
  const raw = await fs.readTextOrUndefined(cursorsPath);
  let cursors: Record<string, unknown> = {};
  if (raw !== undefined && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      cursors = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  const prev = cursors[sessionId];
  if (typeof prev === "number" && prev >= offset) return true;
  cursors[sessionId] = offset;
  await fs.writeTextAtomic(cursorsPath, JSON.stringify(cursors));
  return true;
}
