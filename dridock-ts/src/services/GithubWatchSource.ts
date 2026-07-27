import type { HostCommandRunner } from "../infra/HostCommandRunner.ts";
import { parseHeader } from "./AgentTeamHeader.ts";
import { eventHashOf, type WatcherEvent } from "./WatcherEvent.ts";

/**
 * The generic contract every #45 source adapter implements. `poll`
 * returns the events fetched since `fromCursor` plus the new cursor
 * the store should persist. Adapter-owned cursor shape (opaque to the
 * delivery layer).
 */
export interface WatchSource {
  readonly source: WatcherEvent["source"];
  poll(fromCursor: string): Promise<WatchSourcePollOutcome>;
}

export type WatchSourcePollOutcome =
  | { readonly kind: "ok"; readonly events: readonly WatcherEvent[]; readonly newCursor: string }
  | { readonly kind: "poll-failed"; readonly reason: string };

/**
 * `github` source — polls a single repo's comments + issue bodies since
 * a timestamp cursor. Uses `gh api ... --paginate | jq -c '.[]'` under
 * the hood; parses each JSON record into a WatcherEvent whose `header`
 * comes from [[parseHeader]] applied to the body's first line.
 *
 * Cursor semantics: ISO-8601 `updated_at` timestamp — GitHub's `since=`
 * filter uses updated_at, so this captures edits too (a corrected
 * comment re-fires because its updated_at bumped + its body-hash
 * changed → dedup lets it through).
 *
 * Repo-wide (not per-issue). Repo passed in the constructor; caller
 * (the CLI verb) resolves it from config.
 *
 * Failure mode: `gh api` or `jq` non-zero → returns `poll-failed`
 * (soft), never throws. Watcher's live loop logs + continues with the
 * old cursor. Fail-loud on the user side (stderr), never crash.
 */
export class GithubWatchSource implements WatchSource {
  readonly source = "github" as const;

  constructor(
    private readonly runner: HostCommandRunner,
    /** GitHub repo in `owner/name` form (e.g. `"aberezin/docker-claudebox"`). */
    private readonly repo: string,
    /** Injected in tests. Prod uses `defaultNowIso`. */
    private readonly nowIso: () => string = defaultNowIso,
  ) {}

  async poll(fromCursor: string): Promise<WatchSourcePollOutcome> {
    // First poll ever (empty cursor) — take "now" as the initial
    // cursor. Skips historical events; subsequent polls pick up
    // new activity. The alternative (deep backfill on first run)
    // would flood the delivery layer with weeks of comments.
    const since = fromCursor === "" ? this.nowIso() : fromCursor;

    const commentOutcome = await this.fetchComments(since);
    if (commentOutcome.kind === "poll-failed") return commentOutcome;
    const issueOutcome = await this.fetchIssues(since);
    if (issueOutcome.kind === "poll-failed") return issueOutcome;

    const events = [...commentOutcome.events, ...issueOutcome.events]
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt));

    // New cursor = the latest observedAt we saw, or the previous cursor
    // if we saw nothing new. Never regress the cursor.
    const latest = events.length === 0
      ? since
      : events[events.length - 1]!.observedAt;
    // Bump by 1ms so the next `since=` query doesn't re-fetch the last
    // event (GitHub's since= is inclusive at second precision — with
    // sub-second events an inclusive filter can loop).
    const newCursor = bumpIso1ms(latest);

    return { kind: "ok", events, newCursor };
  }

  private async fetchComments(since: string): Promise<{ kind: "ok"; events: WatcherEvent[] } | { kind: "poll-failed"; reason: string }> {
    // Emit one compact JSON object per line so we can stream-parse.
    const cmd = `gh api "repos/${this.repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]?'`;
    const { rc, stdout } = await this.runner.runCapture(cmd);
    if (rc !== 0) return { kind: "poll-failed", reason: `gh api comments rc=${rc}` };

    const events: WatcherEvent[] = [];
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      let raw: GithubCommentRaw;
      try {
        raw = JSON.parse(line) as GithubCommentRaw;
      } catch {
        // Skip malformed line rather than fail the whole poll; log via
        // caller if we care. Rare (jq -c is well-formed).
        continue;
      }
      if (typeof raw.body !== "string" || typeof raw.issue_url !== "string") continue;
      const issueNum = issueNumberFromUrl(raw.issue_url);
      if (issueNum === undefined) continue;
      const commentId = typeof raw.id === "number" ? raw.id : 0;
      const ref = `github:#${issueNum}#comment-${commentId}`;
      events.push(this.buildEvent(ref, raw.body, raw.updated_at ?? raw.created_at ?? since));
    }
    return { kind: "ok", events };
  }

  private async fetchIssues(since: string): Promise<{ kind: "ok"; events: WatcherEvent[] } | { kind: "poll-failed"; reason: string }> {
    // `.pull_request == null` filters out PRs (they show up on
    // /issues per GH's API oddity).
    const cmd = `gh api "repos/${this.repo}/issues?since=${encodeURIComponent(since)}&state=all&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]? | select(.pull_request == null)'`;
    const { rc, stdout } = await this.runner.runCapture(cmd);
    if (rc !== 0) return { kind: "poll-failed", reason: `gh api issues rc=${rc}` };

    const events: WatcherEvent[] = [];
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      let raw: GithubIssueRaw;
      try {
        raw = JSON.parse(line) as GithubIssueRaw;
      } catch {
        continue;
      }
      if (typeof raw.number !== "number") continue;
      // Empty-body issues can happen; treat as no-header (won't surface
      // via the predicate, but we still emit for the dedup store — a
      // future issue-body edit will re-emit with a different hash).
      const body = typeof raw.body === "string" ? raw.body : "";
      const ref = `github:#${raw.number}#body`;
      events.push(this.buildEvent(ref, body, raw.updated_at ?? raw.created_at ?? since));
    }
    return { kind: "ok", events };
  }

  private buildEvent(ref: string, body: string, observedAt: string): WatcherEvent {
    const header = parseHeader(body) ?? null;
    return {
      source: this.source,
      kind: "comment",   // github events are always body-bearing → comment-kind
      ref,
      header,
      summary: firstLineTruncated(body, 200),
      eventHash: eventHashOf({ source: this.source, ref, kind: "comment", salient: body }),
      cursor: observedAt,
      observedAt,
    };
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Internals — GitHub JSON shapes + small helpers.
 * ─────────────────────────────────────────────────────────────────────
 */

interface GithubCommentRaw {
  readonly id?: number;
  readonly body?: string;
  readonly issue_url?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

interface GithubIssueRaw {
  readonly number?: number;
  readonly body?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly pull_request?: object;
}

/** Extract the issue number from a GitHub API URL like
 *  `https://api.github.com/repos/OWNER/REPO/issues/42`. Returns
 *  undefined for malformed URLs (skip the event). */
export function issueNumberFromUrl(url: string): number | undefined {
  const m = /\/issues\/(\d+)$/.exec(url);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** First line of `body`, truncated to `max` chars with an ellipsis if
 *  cut. Used for the SessionStart-hook summary line. */
export function firstLineTruncated(body: string, max: number): string {
  const nl = body.indexOf("\n");
  const line = nl === -1 ? body : body.substring(0, nl);
  return line.length > max ? `${line.substring(0, max - 1)}…` : line;
}

/** Bump an ISO-8601 timestamp by 1ms so the next GH `since=` filter
 *  doesn't re-see the last event (GitHub's since is inclusive at
 *  second precision + sub-second events would loop). Falls back to
 *  the input if parsing fails (defensive; never crashes poll). */
export function bumpIso1ms(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + 1).toISOString();
}

function defaultNowIso(): string {
  return new Date().toISOString();
}
