import { test, expect, describe } from "bun:test";
import { CommandRegistry } from "./CommandRegistry.ts";
import { VersionCommand } from "./commands/VersionCommand.ts";
import { StringWriter, type Context } from "./Context.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";
import { UnknownVerbError } from "../domain/errors.ts";
import { DRIDOCK_TS_VERSION } from "../domain/dridockVersion.ts";

/** Small factory so each test gets a fresh context with fresh writers. */
function makeCtx(overrides: Partial<Context> = {}): Context & {
  stdout: StringWriter;
  stderr: StringWriter;
} {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    fs: new InMemoryFileSystem(),
    env: new EnvResolver({}),
    cwd: "/proj",
    home: "/home/claude",
    binName: "dridock",
    stdout,
    stderr,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("CommandRegistry — dispatch table", () => {
  test("empty argv → banner + exit 0", async () => {
    const registry = new CommandRegistry();
    const ctx = makeCtx();
    const rc = await registry.dispatch([], ctx);
    expect(rc).toBe(0);
    expect(ctx.stdout.toString()).toContain("dridock");   // simplified banner post-P4b
    expect(ctx.stderr.toString()).toBe("");
  });

  test("known verb with registered Command → dispatched", async () => {
    const registry = new CommandRegistry();
    registry.register(new VersionCommand());
    const ctx = makeCtx();
    const rc = await registry.dispatch(["version"], ctx);
    expect(rc).toBe(0);
    expect(ctx.stdout.toString()).toBe(`dridock ${DRIDOCK_TS_VERSION}\n`);
  });

  test("known verb WITHOUT registered command → returns 2 + stderr note (phased-port fallback)", async () => {
    const registry = new CommandRegistry();
    // register nothing — 'info' is a known verb but no command registered
    const ctx = makeCtx();
    const rc = await registry.dispatch(["info"], ctx);
    expect(rc).toBe(2);
    expect(ctx.stderr.toString()).toContain("not yet ported");
    expect(ctx.stderr.toString()).toContain("info");
  });

  test("unknown bareword → throws UnknownVerbError (matches wrapper.sh:2766 / 3.3.7)", async () => {
    const registry = new CommandRegistry();
    const ctx = makeCtx();
    await expect(registry.dispatch(["chrome"], ctx)).rejects.toThrow(UnknownVerbError);
  });

  test("UnknownVerbError carries exit code 1 + verb name (for main.ts to surface)", async () => {
    const registry = new CommandRegistry();
    const ctx = makeCtx();
    try {
      await registry.dispatch(["chrome"], ctx);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownVerbError);
      const err = e as UnknownVerbError;
      expect(err.verb).toBe("chrome");
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("unknown dridock verb: 'chrome'");
      expect(err.message).toContain("run 'dridock --help'");
    }
  });

  test("first arg starting with '-' when start is NOT registered → UnknownVerbError", async () => {
    // Fresh registry with no start command. This shouldn't happen in
    // production (main.ts always registers start) but the branch exists.
    const registry = new CommandRegistry();
    const ctx = makeCtx();
    try {
      await registry.dispatch(["-p", "hello"], ctx);
      throw new Error("expected UnknownVerbError");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownVerbError);
    }
  });

  test("first arg starting with '-' → routes to start command (P4b: dridock -p '…' works at top level)", async () => {
    // Prove the routing: register a mock start that records what argv it got.
    const registry = new CommandRegistry();
    let receivedArgs: readonly string[] = [];
    registry.register({
      verb: "start",
      run: async (args) => { receivedArgs = args; return 0; },
    });
    const ctx = makeCtx();
    const rc = await registry.dispatch(["-p", "hello"], ctx);
    expect(rc).toBe(0);
    expect(receivedArgs).toEqual(["-p", "hello"]);
  });

  test("--help at top level → routes to help command when registered", async () => {
    const registry = new CommandRegistry();
    let helpCalled = false;
    registry.register({ verb: "start", run: async () => 0 });
    registry.register({ verb: "help", run: async () => { helpCalled = true; return 0; } });
    const ctx = makeCtx();
    const rc = await registry.dispatch(["--help"], ctx);
    expect(rc).toBe(0);
    expect(helpCalled).toBe(true);
  });
});

describe("CommandRegistry — register + has", () => {
  test("register throws on duplicate verb (wiring bug)", () => {
    const registry = new CommandRegistry();
    registry.register(new VersionCommand());
    expect(() => registry.register(new VersionCommand())).toThrow(/already registered/);
  });

  test("has returns false for unregistered known verbs", () => {
    const registry = new CommandRegistry();
    expect(registry.has("info")).toBe(false);
    registry.register(new VersionCommand());
    expect(registry.has("version")).toBe(true);
    expect(registry.has("info")).toBe(false);   // still not registered
  });

  test("has returns false for unknown verbs (even without registration)", () => {
    const registry = new CommandRegistry();
    expect(registry.has("chrome")).toBe(false);
  });

  test("unimplementedVerbs reports every catalog verb without a command", () => {
    const registry = new CommandRegistry();
    registry.register(new VersionCommand());
    const un = registry.unimplementedVerbs();
    expect(un).not.toContain("version");
    expect(un.length).toBeGreaterThan(20);   // most verbs still un-ported in Phase 2
    expect(un).toContain("info");
    expect(un).toContain("migrate");
  });
});
