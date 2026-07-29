import type { FileSystem } from "../infra/FileSystem.ts";
import type { WatcherEvent } from "./WatcherEvent.ts";
import type { WatcherSink, WatcherTickSummary } from "./WatcherLoop.ts";
import type { TextWriter } from "../cli/Context.ts";

/**
 * Sink for `dridock team watch --inbox <path>` — the fetcher mode.
 *
 * Runs as a detached (`nohup`) background process spawned by the
 * SessionStart hook (spec: #56, `docs/design/agent-teams-delivery.md`).
 * Each surfaced event is appended as one JSONL line to the inbox file;
 * the SessionStart hook drains the unread slice at boot, and a Monitor
 * running `tail -F -c +$((X+1)) <inbox>` picks up live events during
 * the session. Per-agent inbox files make consumer starvation
 * impossible by construction (Bear and Arfy write to different files).
 *
 * ## JSONL line shape
 * One line per event, machine-readable end-to-end:
 * ```json
 * {"observedAt":"2026-07-29T00:04:08Z","source":"github","kind":"comment",
 *  "ref":"github:#46#comment-5111100124","sender":"Arfy","recipients":["Bear"],
 *  "summary":"Design accepted…","fingerprint":"7f3c…","url":"https://github.com/…"}
 * ```
 * `sender`/`recipients` come from the parsed header; `<legacy>` sender
 * for a body without a header prefix (matches the display-line behavior
 * in TeamCommand). `url` is derived from the ref+repo for github events;
 * omitted when we can't build one deterministically.
 *
 * ## Not on this sink
 * - Pidfile management, log-file redirection, and process lifecycle live
 *   in the fetcher CLI verb (`runFetcher` in TeamCommand). This sink is
 *   pure I/O.
 * - Heartbeat file is still written by `onTickComplete` (same as the
 *   stdout sink), so the SessionStart hook's staleness nudge still fires
 *   when the fetcher is silent for too long.
 */

export interface InboxSinkDeps {
  readonly fs: FileSystem;
  /** Absolute path to the per-agent JSONL inbox file. Parent dir is
   *  created on first append. */
  readonly inboxPath: string;
  /** Agent this fetcher is running as (Bear, Arfy). Written into every
   *  heartbeat record so `dridock team fetcher status` can surface it. */
  readonly selfName: string;
  /** GitHub repo the fetcher is polling (`owner/name`). Used for URL
   *  derivation. */
  readonly repo: string;
  /** Absolute path to the heartbeat file (unchanged behavior from the
   *  stdout sink). */
  readonly heartbeatPath: string;
  /** Where to write poll-failure warnings + the (rare) sink error line.
   *  Under `nohup` redirection this is the log file at `<inbox>.log`. */
  readonly stderr: TextWriter;
}

/** Build a `WatcherSink` that appends JSONL events to the inbox file
 *  instead of writing display lines to stdout. See file header. */
export function makeInboxSink(deps: InboxSinkDeps): WatcherSink {
  return {
    onEvent: async (event) => {
      try {
        const line = formatInboxLine(event, deps.repo);
        await deps.fs.appendText(deps.inboxPath, `${line}\n`);
      } catch (e) {
        // Sink write failed — surface on stderr so the fetcher's log
        // captures it. Don't crash the loop: the event is lost for this
        // consumer, but the cursor/dedup state advances on the next
        // tick regardless, so a re-poll wouldn't recover it either.
        // Better to keep polling than to wedge the whole fetcher.
        deps.stderr.write(`⚠️  inbox append failed for ${event.ref}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    },
    onPollFailed: (source, reason) => {
      deps.stderr.write(`⚠️  team watch: ${source} poll failed: ${reason}\n`);
    },
    onTickComplete: async (summary: WatcherTickSummary) => {
      try {
        await deps.fs.writeText(
          deps.heartbeatPath,
          JSON.stringify({
            ...summary,
            atIso: new Date().toISOString(),
            self: deps.selfName,
            repo: deps.repo,
            inbox: deps.inboxPath,
          }),
        );
      } catch { /* best-effort */ }
    },
  };
}

/** Serialize one event into a single JSONL line (no trailing newline —
 *  caller appends `\n`). Exported for InboxSink.test.ts + for the
 *  SessionStart hook drain helper (see `parseInboxLine`). */
export function formatInboxLine(event: WatcherEvent, repo: string): string {
  const sender = event.header?.sender ?? "<legacy>";
  const recipients = event.header?.recipients ?? [];
  const record: InboxRecord = {
    observedAt: event.observedAt,
    source: event.source,
    kind: event.kind,
    ref: event.ref,
    sender,
    recipients: [...recipients],
    summary: event.summary,
    fingerprint: event.eventHash,
  };
  const url = githubUrlFromRef(event.ref, repo);
  if (url !== undefined) record.url = url;
  return JSON.stringify(record);
}

/** The parsed shape of an inbox line — the mirror of `formatInboxLine`.
 *  Kept explicit (not `Record<string, unknown>`) so consumers get typed
 *  access without a re-parse. */
export interface InboxRecord {
  observedAt: string;
  source: string;
  kind: string;
  ref: string;
  sender: string;
  recipients: string[];
  summary: string;
  fingerprint: string;
  url?: string;
}

/** Reverse of `formatInboxLine`. Returns `undefined` for lines that
 *  aren't parseable inbox records (blank, comment, corrupt). Drain-side
 *  tools use this to filter noise without crashing. */
export function parseInboxLine(line: string): InboxRecord | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<InboxRecord>;
    if (
      typeof parsed.observedAt === "string" &&
      typeof parsed.ref === "string" &&
      typeof parsed.sender === "string" &&
      typeof parsed.fingerprint === "string"
    ) {
      return {
        observedAt: parsed.observedAt,
        source: parsed.source ?? "",
        kind: parsed.kind ?? "",
        ref: parsed.ref,
        sender: parsed.sender,
        recipients: Array.isArray(parsed.recipients) ? parsed.recipients.filter((r): r is string => typeof r === "string") : [],
        summary: parsed.summary ?? "",
        fingerprint: parsed.fingerprint,
        ...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Convention: per-agent inbox lives at `<xdg-dridock>/inbox/<agent>.jsonl`.
 *  Same rule host + container so the SessionStart hook and the CLI both
 *  compute the same path without configuration. */
export function inboxPathFor(xdgDridockRoot: string, selfName: string): string {
  return `${xdgDridockRoot}/inbox/${selfName}.jsonl`;
}

/** Sibling file paths derived from the inbox path (all conventions —
 *  keep them next to the inbox so `ls <dir>` shows the whole fetcher's
 *  state in one place). */
export function pidfileFor(inboxPath: string): string { return `${inboxPath}.pid`; }
export function logfileFor(inboxPath: string): string { return `${inboxPath}.log`; }
export function sessionCursorsFor(inboxPath: string): string { return `${inboxPath}.session-cursors.json`; }

/** Derive a browsable URL from an adapter ref + owner/name repo.
 *  Currently only github refs are recognized — other sources (consult,
 *  bug-report) return `undefined` and the record ships without a `url`. */
export function githubUrlFromRef(ref: string, repo: string): string | undefined {
  // Ref shapes seen in the wild:
  //   github:#46#body              → issue body
  //   github:#46#comment-511010    → an issue comment
  //   github:#46#head              → head/state event (no comment id)
  const m = /^github:#(\d+)#(body|comment-(\d+)|head)$/.exec(ref);
  if (m === null) return undefined;
  const issue = m[1];
  const kind = m[2];
  const commentId = m[3];
  const base = `https://github.com/${repo}/issues/${issue}`;
  if (kind === "body" || kind === "head") return base;
  if (commentId !== undefined) return `${base}#issuecomment-${commentId}`;
  return base;
}
