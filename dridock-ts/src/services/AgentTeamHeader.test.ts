import { test, expect, describe } from "bun:test";
import { parseHeader, surfacesForAgent, formatHeader } from "./AgentTeamHeader.ts";

// Spec: docs/design/agent-teams.md §2 (grammar) + §3 (predicate) + §6 (dual-accept).

describe("parseHeader — NEW shape (sender-first, canonical)", () => {
  test("broadcast: 'Arfy:' → sender=Arfy, recipients=[]", () => {
    const h = parseHeader("Arfy:");
    expect(h).toEqual({ sender: "Arfy", recipients: [], legacy: false });
  });

  test("directed single: 'Arfy->Bear:' → sender=Arfy, recipients=[Bear]", () => {
    const h = parseHeader("Arfy->Bear:");
    expect(h).toEqual({ sender: "Arfy", recipients: ["Bear"], legacy: false });
  });

  test("directed multi: 'Arfy->Bear,Alan:' → sender=Arfy, recipients=[Bear,Alan]", () => {
    const h = parseHeader("Arfy->Bear,Alan:");
    expect(h).toEqual({ sender: "Arfy", recipients: ["Bear", "Alan"], legacy: false });
  });

  test("emphasis tolerated on BOTH ends: '**Arfy->Bear:**' → same result", () => {
    expect(parseHeader("**Arfy->Bear:**")).toEqual({ sender: "Arfy", recipients: ["Bear"], legacy: false });
    // Also tolerated with only one side emphasized.
    expect(parseHeader("**Arfy:")).toEqual({ sender: "Arfy", recipients: [], legacy: false });
    expect(parseHeader("Arfy:**")).toEqual({ sender: "Arfy", recipients: [], legacy: false });
  });

  test("leading whitespace tolerated", () => {
    expect(parseHeader("   Arfy->Bear:")).toEqual({ sender: "Arfy", recipients: ["Bear"], legacy: false });
    expect(parseHeader("\tArfy->Bear:")).toEqual({ sender: "Arfy", recipients: ["Bear"], legacy: false });
    // But NOT leading non-whitespace: a header must own the start of the line.
    expect(parseHeader("x Arfy->Bear:")).toBeUndefined();
  });

  test("token grammar per spec: [A-Za-z][\\w-]* — letters + digits + underscore + hyphen", () => {
    expect(parseHeader("agent-1:")).toEqual({ sender: "agent-1", recipients: [], legacy: false });
    expect(parseHeader("Bear_2:")).toEqual({ sender: "Bear_2", recipients: [], legacy: false });
    expect(parseHeader("Arfy->agent-1,Bear_2:")).toEqual({
      sender: "Arfy", recipients: ["agent-1", "Bear_2"], legacy: false,
    });
    // First char must be a letter (spec: `[A-Za-z][\\w-]*`).
    expect(parseHeader("1-agent:")).toBeUndefined();
    expect(parseHeader("_agent:")).toBeUndefined();
    // Hyphen alone (which is legacy's marker) isn't a valid name start.
    expect(parseHeader("-agent:")).toBeUndefined();
  });

  test("content after the header colon is preserved as body (not parsed)", () => {
    // parseHeader returns undefined on shape-only mismatches; here the
    // header IS valid and the content just tags along. The lib doesn't
    // split content out — callers do that themselves.
    expect(parseHeader("Arfy->Bear: verified #42, tests green")).toEqual({
      sender: "Arfy", recipients: ["Bear"], legacy: false,
    });
  });

  test("multi-line body — header lives on FIRST line only", () => {
    const body = "Arfy->Bear: line one\n\nMore content here\nAlan: not the header";
    expect(parseHeader(body)).toEqual({ sender: "Arfy", recipients: ["Bear"], legacy: false });
  });
});

describe("parseHeader — LEGACY shape (recipient-only, deprecated)", () => {
  test("'→ Bear:' → sender=undefined, recipients=[Bear], legacy=true", () => {
    expect(parseHeader("→ Bear:")).toEqual({ sender: undefined, recipients: ["Bear"], legacy: true });
  });

  test("'**→ Bear:**' emphasized → same result", () => {
    expect(parseHeader("**→ Bear:**")).toEqual({ sender: undefined, recipients: ["Bear"], legacy: true });
  });

  test("multiple recipients: '→ Bear,Alan:' → recipients=[Bear,Alan]", () => {
    expect(parseHeader("→ Bear,Alan:")).toEqual({ sender: undefined, recipients: ["Bear", "Alan"], legacy: true });
  });

  test("legacy with content: '→ Bear: fixed the thing' still parses", () => {
    expect(parseHeader("→ Bear: fixed the thing")).toEqual({
      sender: undefined, recipients: ["Bear"], legacy: true,
    });
  });

  test("no space after arrow tolerated by spec regex? — NO, spec requires `\\s*` after `→` for whitespace, but the pattern is `\\s*` (zero-or-more)", () => {
    // The regex uses `\s*` after `→`, so zero whitespace is technically legal.
    expect(parseHeader("→Bear:")).toEqual({ sender: undefined, recipients: ["Bear"], legacy: true });
  });
});

describe("parseHeader — NOT a header", () => {
  test("plain text → undefined", () => {
    expect(parseHeader("Just a regular comment.")).toBeUndefined();
    expect(parseHeader("Hello world")).toBeUndefined();
  });

  test("empty body → undefined", () => {
    expect(parseHeader("")).toBeUndefined();
    expect(parseHeader("\n\n")).toBeUndefined();
  });

  test("header only on line 2 → undefined (spec §2.4: must be first line)", () => {
    expect(parseHeader("preface\nArfy->Bear:")).toBeUndefined();
  });

  test("looks-like-header but missing colon → undefined", () => {
    expect(parseHeader("Arfy->Bear no colon")).toBeUndefined();
  });

  test("code-block containing what looks like a header on line 1 → parses (documented false-positive; markdown-aware parsing would be scope creep)", () => {
    // Documenting the known false-positive rather than silently supporting
    // it — a markdown-aware parser would need to skip ``` fences etc.,
    // which the spec doesn't require.
    expect(parseHeader("```\nArfy->Bear:\n```")).toBeUndefined(); // ``` isn't a header line
    // But an in-code-block header on line 1 (rare) would false-match:
    expect(parseHeader("Arfy: not intended as a header\n```\ncode\n```")).toEqual({
      sender: "Arfy", recipients: [], legacy: false,
    });
  });
});

describe("surfacesForAgent — NEW-shape delivery predicate (spec §3)", () => {
  test("broadcast + not-self → surface (broadcast reaches everyone but sender)", () => {
    expect(surfacesForAgent(parseHeader("Arfy:"), "Bear")).toBe(true);
    expect(surfacesForAgent(parseHeader("Arfy:"), "Alan")).toBe(true);
  });

  test("broadcast + self-as-sender → DROP (self-echo suppression)", () => {
    expect(surfacesForAgent(parseHeader("Bear:"), "Bear")).toBe(false);
  });

  test("directed + self in recipients → surface", () => {
    expect(surfacesForAgent(parseHeader("Arfy->Bear:"), "Bear")).toBe(true);
    expect(surfacesForAgent(parseHeader("Arfy->Bear,Alan:"), "Alan")).toBe(true);
  });

  test("directed + self NOT in recipients → DROP", () => {
    expect(surfacesForAgent(parseHeader("Arfy->Bear:"), "Alan")).toBe(false);
    expect(surfacesForAgent(parseHeader("Arfy->Bear:"), "Arfy")).toBe(false); // self-echo too
  });

  test("directed + self-as-sender-AND-self-as-recipient → DROP (self-echo wins)", () => {
    // Edge case: an agent posts to itself. The sender check fires first.
    expect(surfacesForAgent(parseHeader("Bear->Bear:"), "Bear")).toBe(false);
  });
});

describe("surfacesForAgent — LEGACY-shape delivery predicate (degraded)", () => {
  test("self in recipients → surface (no self-echo signal to check)", () => {
    expect(surfacesForAgent(parseHeader("→ Bear:"), "Bear")).toBe(true);
    expect(surfacesForAgent(parseHeader("→ Bear,Alan:"), "Alan")).toBe(true);
  });

  test("self NOT in recipients → DROP", () => {
    expect(surfacesForAgent(parseHeader("→ Bear:"), "Alan")).toBe(false);
  });

  test("legacy broadcast has no expressible form → nothing surfaces to anyone as broadcast", () => {
    // Legacy is recipient-only; there is no `→ :` broadcast form. Any
    // legacy header has at least one named recipient, so agents not in
    // that list drop the message. That's the whole reason we moved off
    // legacy — broadcasts weren't expressible.
    expect(surfacesForAgent(parseHeader("→ Bear:"), "Arfy")).toBe(false);
  });

  test("KNOWN LIMITATION: legacy can't detect self-echo — 'Bear posts → Bear:' still surfaces to Bear", () => {
    // This is the incident from 2026-07-24 that motivated the migration
    // to sender-first. Documenting rather than fixing — the mitigation
    // is to migrate all posts to new-shape, at which point self-echo
    // suppression kicks in.
    expect(surfacesForAgent(parseHeader("→ Bear:"), "Bear")).toBe(true);
  });
});

describe("surfacesForAgent — non-header bodies", () => {
  test("undefined header (plain text) → DROP (nothing to attribute)", () => {
    expect(surfacesForAgent(parseHeader("just a comment"), "Bear")).toBe(false);
    expect(surfacesForAgent(undefined, "Bear")).toBe(false);
  });
});

describe("formatHeader — compose canonical headers for outgoing posts", () => {
  test("broadcast: no recipients → 'Sender:'", () => {
    expect(formatHeader("Bear")).toBe("Bear:");
    expect(formatHeader("Bear", [])).toBe("Bear:");
  });

  test("directed single → 'Sender->Recipient:'", () => {
    expect(formatHeader("Bear", ["Arfy"])).toBe("Bear->Arfy:");
  });

  test("directed multi → 'Sender->A,B:' (comma-separated, no spaces)", () => {
    expect(formatHeader("Bear", ["Arfy", "Alan"])).toBe("Bear->Arfy,Alan:");
  });

  test("rejects tokens that don't match the spec grammar", () => {
    expect(() => formatHeader("1invalid")).toThrow("invalid sender token");
    expect(() => formatHeader("Bear", ["ok", "1bad"])).toThrow("invalid recipient token");
    expect(() => formatHeader("has space")).toThrow("invalid sender token");
    expect(() => formatHeader("has:colon")).toThrow("invalid sender token");
  });

  test("roundtrip: formatHeader → parseHeader gives back what went in (new shape)", () => {
    const cases = [
      { sender: "Bear", recipients: [] },
      { sender: "Arfy", recipients: ["Bear"] },
      { sender: "Arfy", recipients: ["Bear", "Alan"] },
      { sender: "agent-1", recipients: ["Bear_2"] },
    ];
    for (const c of cases) {
      const line = formatHeader(c.sender, c.recipients);
      const parsed = parseHeader(line);
      expect(parsed).toEqual({ ...c, legacy: false });
    }
  });
});
