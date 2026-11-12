import { test, expect, describe } from "bun:test";
import { buildRegistry, buildCronModeCommand } from "./buildRegistry.ts";
import { resolveImage } from "../domain/ImageRef.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";

// Spec: #109. From 4.0 to 5.14.0 every image-using command defaulted its
// constructor's `imageName` to "dridock:latest", and buildRegistry() passed
// nothing, so DRIDOCK_IMAGE / DRIDOCK_IMAGE_NAME / DRIDOCK_MINIMAL never
// reached any of them. This test drives the REAL composition root with a
// non-default choice and asserts every command that carries an image got it.
// It discovers them by the field, so a command added later with the old
// default-and-forget pattern fails here instead of shipping.
//
// CONTRACT: the field is named `imageName`. A command that stores its image
// under any other name is invisible to the generic check below and is caught
// only if it's in the hardcoded verb list. Name it `imageName`.

function imageOf(cmd: object): string | undefined {
  const v = (cmd as { imageName?: unknown }).imageName;
  return typeof v === "string" ? v : undefined;
}

describe("the resolved image reaches every image-using command", () => {
  const choice = resolveImage(new EnvResolver({ DRIDOCK_IMAGE_NAME: "probe", DRIDOCK_MINIMAL: "1" }));

  test("choice under test is the non-default one", () => {
    expect(choice.image).toBe("probe:latest-minimal");
  });

  test("every registered command holding an imageName holds the chosen one", () => {
    const holders = buildRegistry(choice).all().filter((c) => imageOf(c) !== undefined);
    const wrong = holders.filter((c) => imageOf(c) !== choice.image).map((c) => `${c.verb}=${imageOf(c)}`);
    expect(wrong).toEqual([]);
    // The verbs known to run the image at the time of #109. If one drops out of
    // this list, it stopped carrying an image: check that was intended.
    const verbs = new Set<string>(holders.map((c) => c.verb));
    for (const v of ["start", "info", "status", "checkversion", "features", "profiles", "setup-token", "doctor", "auth", "mcp"]) {
      expect(verbs.has(v)).toBe(true);
    }
  });

  test("cron mode, dispatched by env not verb, gets it too", () => {
    expect(imageOf(buildCronModeCommand(choice))).toBe(choice.image);
  });

  // #110: start and cron also take the variant, which picks the drift
  // warning's remedy. Nothing in the types ties it to imageName, so check
  // the pair agrees wherever a command holds both.
  test("a command holding imageVariant holds the variant of its image", () => {
    const variantOf = (c: object): unknown => (c as { imageVariant?: unknown }).imageVariant;
    const cmds: object[] = [...buildRegistry(choice).all(), buildCronModeCommand(choice)];
    const holders = cmds.filter((c) => variantOf(c) !== undefined);
    expect(holders.length).toBeGreaterThanOrEqual(2);   // start + cron at #110
    for (const c of holders) {
      expect(imageOf(c)).toBe(choice.image);
      expect(variantOf(c)).toBe(choice.variant);
    }
  });

  test("with no settings the default is still dridock:latest", () => {
    const holders = buildRegistry().all().filter((c) => imageOf(c) !== undefined);
    expect(holders.every((c) => imageOf(c) === "dridock:latest")).toBe(true);
  });
});
