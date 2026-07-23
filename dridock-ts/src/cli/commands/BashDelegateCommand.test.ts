import { test, expect, describe } from "bun:test";
import { BashDelegateCommand } from "./BashDelegateCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

function makeCtx(): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: {
      fs: new InMemoryFileSystem(),
      env: new EnvResolver({}),
      cwd: "/p", home: "/home/alan", binName: "dridock",
      stdout, stderr,
    },
  };
}

describe("BashDelegateCommand — bash wrapper not found", () => {
  test("no DRIDOCK_BASH_WRAPPER, no sibling wrapper.sh, no dridock-bash → rc 127 with clear message", async () => {
    // Explicitly ensure no env var
    const orig = process.env["DRIDOCK_BASH_WRAPPER"];
    delete process.env["DRIDOCK_BASH_WRAPPER"];
    try {
      const { ctx, stderr } = makeCtx();
      const cmd = new BashDelegateCommand("browser-bridge");
      const rc = await cmd.run(["up"], ctx);
      expect(rc).toBe(127);
      const err = stderr.text();
      expect(err).toContain("bash wrapper not found");
      expect(err).toContain("DRIDOCK_BASH_WRAPPER");
      // No silent surrender — the error is visible + actionable
      expect(err).toContain("Install both");
    } finally {
      if (orig !== undefined) process.env["DRIDOCK_BASH_WRAPPER"] = orig;
    }
  });

  test("DRIDOCK_BASH_WRAPPER points at a non-existent path → falls through to 'not found'", async () => {
    const orig = process.env["DRIDOCK_BASH_WRAPPER"];
    process.env["DRIDOCK_BASH_WRAPPER"] = "/tmp/does-not-exist-anywhere-real";
    try {
      const { ctx, stderr } = makeCtx();
      const rc = await new BashDelegateCommand("host-agent").run(["status"], ctx);
      expect(rc).toBe(127);
      expect(stderr.text()).toContain("bash wrapper not found");
    } finally {
      if (orig !== undefined) process.env["DRIDOCK_BASH_WRAPPER"] = orig;
      else delete process.env["DRIDOCK_BASH_WRAPPER"];
    }
  });

  test("verb is preserved on the delegate — carries through to what would be spawned", () => {
    // Just an identity check — the verb property survives to Command interface
    expect(new BashDelegateCommand("browser-bridge").verb).toBe("browser-bridge");
    expect(new BashDelegateCommand("host-agent").verb).toBe("host-agent");
  });
});
