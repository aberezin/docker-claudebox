import { test, expect, describe } from "bun:test";
import { resolveImage, variantTags, makeTargetFor } from "./ImageRef.ts";
import { EnvResolver } from "./EnvResolver.ts";

// Spec: #109. The 3.4.1 wrapper's image selection, restored. The 4.0 TS port
// dropped it, so all three settings were silently ignored.
const r = (env: Record<string, string>) => resolveImage(new EnvResolver(env));

describe("resolveImage — the v3.4.1 wrapper.sh:2146-2153 rules", () => {
  test("nothing set → dridock:latest, no notes", () => {
    expect(r({})).toEqual({ image: "dridock:latest", variant: "full", name: "dridock", notes: [] });
  });
  test("DRIDOCK_MINIMAL=1 → the minimal tag", () => {
    const c = r({ DRIDOCK_MINIMAL: "1" });
    expect(c.image).toBe("dridock:latest-minimal");
    expect(c.variant).toBe("minimal");
    expect(c.notes).toEqual([]);
  });
  test("DRIDOCK_IMAGE_NAME renames the repo, the variant tag still applies", () => {
    expect(r({ DRIDOCK_IMAGE_NAME: "mybox" }).image).toBe("mybox:latest");
    expect(r({ DRIDOCK_IMAGE_NAME: "mybox", DRIDOCK_MINIMAL: "1" }).image).toBe("mybox:latest-minimal");
  });
  test("DRIDOCK_IMAGE wins outright, and says what it overrode", () => {
    const c = r({ DRIDOCK_IMAGE: "reg.example/cb:dev", DRIDOCK_MINIMAL: "1", DRIDOCK_IMAGE_NAME: "mybox" });
    expect(c.image).toBe("reg.example/cb:dev");
    expect(c.variant).toBe("custom");
    expect(c.notes.join("")).toContain("DRIDOCK_MINIMAL is ignored");
    expect(c.notes.join("")).toContain("DRIDOCK_IMAGE_NAME is ignored");
  });
  test("empty values count as unset, like bash's [ -n ] / [ -z ]", () => {
    expect(r({ DRIDOCK_IMAGE: "", DRIDOCK_IMAGE_NAME: " ", DRIDOCK_MINIMAL: "" }).image).toBe("dridock:latest");
  });
  test("DRIDOCK_MINIMAL=0 still selects minimal (install.sh parity), and says so", () => {
    // LOAD-BEARING: install.sh reads it as [ -n ]. If this resolver treated
    // "0" as off, install.sh would build minimal while dridock ran full.
    const c = r({ DRIDOCK_MINIMAL: "0" });
    expect(c.image).toBe("dridock:latest-minimal");
    expect(c.notes.join("")).toContain("any non-empty value");
  });
});

describe("variant helpers", () => {
  test("variantTags lists full then minimal", () => {
    expect(variantTags("dridock")).toEqual(["dridock:latest", "dridock:latest-minimal"]);
  });
  test("makeTargetFor names the make target that rebuilds the tag", () => {
    expect(makeTargetFor("dridock:latest-minimal")).toBe("make build-minimal");
    expect(makeTargetFor("dridock:latest")).toBe("make build");
  });
});
