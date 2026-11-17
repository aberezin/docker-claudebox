import { test, expect } from "bun:test";
import { legacyLayoutRefusal } from "./LegacyLayout.ts";

test("#135: the .claudebox refusal names the manual steps and the 5.x way out", () => {
  const out = legacyLayoutRefusal("/u/proj", "/Users/a").join("");
  expect(out).toContain("/u/proj still uses the legacy .claudebox/ layout, which dridock 6.0 can't read or convert");
  expect(out).toContain("mv '/u/proj/.claudebox' '/u/proj/.dridock'");
  expect(out).toContain("/.claudebox/ lines in /u/proj/.gitignore");
  expect(out).toContain("/Users/a/.config/claudebox/");
  expect(out).toContain("dridock 5.x");
  // It must not send the user to a verb that no longer exists in this binary
  // without saying where that verb lives.
  expect(out).not.toMatch(/Convert it:\s+dridock migrate/);
});
