/**
 * Agent-teams message-header parser + delivery predicate — the pure
 * primitive shared between #46 (agent-teams spec) and #45 (reusable
 * watcher). Every message on a header-bearing transport (GitHub
 * comments/issues, cb-consult replies, cb-report-bug notes, future A2A)
 * starts with a header line naming its author and optional recipients;
 * the watcher's delivery predicate branches on the parse.
 *
 * Spec: docs/design/agent-teams.md §2 (grammar) + §3 (predicate).
 *
 * ## Two shapes accepted (dual-accept per §6)
 *
 * - **New (canonical):** sender-first. Examples:
 *     `Arfy:`               broadcast from Arfy
 *     `Arfy->Bear:`         directed from Arfy to Bear
 *     `Arfy->Bear,Alan:`    directed to multiple recipients
 *   Markdown emphasis is allowed but not required (`**Arfy->Bear:**`).
 *
 * - **Legacy (deprecated, still accepted during migration):**
 *   recipient-only. Example: `→ Bear:` or `**→ Bear:**`. No sender
 *   is expressed, so self-echo suppression can't apply. The migration
 *   plan (spec §6) is: agents adopt sender-first immediately, and the
 *   legacy branch is removed once all posts have migrated.
 *
 * ## Delivery predicate branches (spec §3)
 *
 * For **new-shape (has-sender) headers** — the full four-part rule:
 *   surface(e) := eventHash(e) ∉ delivered
 *              AND sender != self
 *              AND (recipients = ∅ OR self ∈ recipients)
 *
 * For **legacy (no-sender) headers** — degraded rule (no self-echo
 * signal to check):
 *   surface(e) := eventHash(e) ∉ delivered
 *              AND self ∈ recipients
 *   Broadcasts have no expressible form in the legacy shape.
 *
 * Dedup and eventHash live in the caller (#45's watcher contract); this
 * lib is stateless. Where the predicate runs (watcher/receiver) is a
 * security boundary — see agent-teams.md §3 HARD RULE.
 */

/** A parsed header — one of two flavors. `sender === undefined` iff the
 *  source form was the legacy `→ Name:` (no sender expressible). */
export interface ParsedHeader {
  readonly sender: string | undefined;
  readonly recipients: readonly string[];
  /** True iff parsed from the legacy `→ Name:` form (no sender). Callers
   *  don't usually need this — the predicate handles both shapes — but
   *  it's exposed so a formatter can prompt-nudge an agent to migrate.  */
  readonly legacy: boolean;
}

/**
 * Parse the FIRST line of `body` as an agent-teams header. Returns
 * `undefined` if the first line isn't a header (plain-text body,
 * or the header appears mid-body but not on line 1 — headers must be
 * first-line per spec §2.4). Tolerant of leading whitespace and
 * optional `**` markdown emphasis on both ends.
 *
 * Grammar (spec §2 reference regex):
 *   ^\s*\*{0,2}(?<sender>[A-Za-z][\w-]*)(?:->(?<recipients>[A-Za-z][\w-]*(?:,[A-Za-z][\w-]*)*))?:\*{0,2}
 * Legacy alternation (spec §6 dual-accept):
 *   ^\s*\*{0,2}→\s*(?<recipients>[A-Za-z][\w-]*(?:,[A-Za-z][\w-]*)*):\*{0,2}
 */
export function parseHeader(body: string): ParsedHeader | undefined {
  // Only ever look at the FIRST line. A header mid-body is not a header
  // — that's plain-text content that happens to contain a colon.
  const firstLine = firstLineOf(body);
  if (firstLine === "") return undefined;

  // NEW-shape first. If it matches we're done (the emphasized-legacy
  // form `**→ Bear:**` doesn't overlap because it starts with `→` which
  // is not `[A-Za-z]`).
  const newMatch = NEW_HEADER_RE.exec(firstLine);
  if (newMatch !== null && newMatch.groups !== undefined) {
    const sender = newMatch.groups["sender"];
    const recipientsRaw = newMatch.groups["recipients"];
    if (sender === undefined) return undefined; // shouldn't happen given the regex; defensive
    return {
      sender,
      recipients: recipientsRaw === undefined ? [] : recipientsRaw.split(","),
      legacy: false,
    };
  }

  // LEGACY fallback.
  const legacyMatch = LEGACY_HEADER_RE.exec(firstLine);
  if (legacyMatch !== null && legacyMatch.groups !== undefined) {
    const recipientsRaw = legacyMatch.groups["recipients"];
    if (recipientsRaw === undefined) return undefined;
    return {
      sender: undefined,
      recipients: recipientsRaw.split(","),
      legacy: true,
    };
  }

  return undefined;
}

/**
 * Delivery predicate for header-bearing (comment-kind) events. Returns
 * `true` iff the event should be surfaced to `selfName`. Non-header
 * bodies (parseHeader returned undefined) are NOT delivered — they
 * don't carry attribution and the whole point of the header is
 * being addressable in the first place.
 *
 * Dedup is the CALLER's responsibility — this function is stateless
 * per spec §3's split between the pure predicate and the watcher's
 * dedup store.
 */
export function surfacesForAgent(header: ParsedHeader | undefined, selfName: string): boolean {
  if (header === undefined) return false;
  if (header.legacy) {
    // Legacy shape: no sender to compare against selfName, so no self-
    // echo suppression is possible. Fall back to the recipient-only
    // check (matches the pre-#46 watcher behavior).
    return header.recipients.includes(selfName);
  }
  // New shape — the full predicate (spec §3):
  //   sender != self AND (recipients = ∅ OR self ∈ recipients)
  if (header.sender === selfName) return false;
  if (header.recipients.length === 0) return true; // broadcast
  return header.recipients.includes(selfName);
}

/**
 * Compose a canonical header line for a NEW post. `recipients` empty →
 * broadcast (`"Sender:"`). Non-empty → directed (`"Sender->A,B:"`).
 * Callers prepend this to their message body.
 */
export function formatHeader(sender: string, recipients: readonly string[] = []): string {
  if (!SENDER_TOKEN_RE.test(sender)) {
    throw new Error(`formatHeader: invalid sender token '${sender}' — must match [A-Za-z][\\w-]*`);
  }
  for (const r of recipients) {
    if (!SENDER_TOKEN_RE.test(r)) {
      throw new Error(`formatHeader: invalid recipient token '${r}' — must match [A-Za-z][\\w-]*`);
    }
  }
  return recipients.length === 0 ? `${sender}:` : `${sender}->${recipients.join(",")}:`;
}

/* ─────────────────────────────────────────────────────────────────────
 * Internals
 * ─────────────────────────────────────────────────────────────────────
 */

/**
 * The canonical new-shape regex from spec §2. Anchored to start; matches
 * only the header token (not the whole line — content follows). The
 * `\*{0,2}` on both ends is optional bold-marker tolerance:
 *   Arfy:              → matches
 *   **Arfy:**          → matches
 *   **Arfy->Bear,Alan:** rest of body → matches with sender=Arfy, recipients=Bear,Alan
 * Explicit `[A-Za-z][\w-]*` in JS regex (no `\p` needed — spec restricts
 * names to ASCII letters/digits/underscore/hyphen).
 */
const NEW_HEADER_RE = /^\s*\*{0,2}(?<sender>[A-Za-z][\w-]*)(?:->(?<recipients>[A-Za-z][\w-]*(?:,[A-Za-z][\w-]*)*))?:\*{0,2}/;

/**
 * Legacy `→ Name:` form. Kept during the migration window (spec §6).
 * No sender — the whole point of moving to sender-first was that this
 * shape can't disambiguate authors.
 */
const LEGACY_HEADER_RE = /^\s*\*{0,2}→\s*(?<recipients>[A-Za-z][\w-]*(?:,[A-Za-z][\w-]*)*):\*{0,2}/;

/** Sender/recipient tokens per spec §2: `[A-Za-z][A-Za-z0-9_-]*`. */
const SENDER_TOKEN_RE = /^[A-Za-z][\w-]*$/;

function firstLineOf(body: string): string {
  const nl = body.indexOf("\n");
  return nl === -1 ? body : body.substring(0, nl);
}
