import { test, expect, describe } from "bun:test";
import { validateProgArgs } from "./ProgArgValidator.ts";
import { DridockError } from "../domain/errors.ts";

describe("validateProgArgs — happy paths", () => {
  test("minimum: -p 'hello'", () => {
    const r = validateProgArgs(["-p", "hello"]);
    expect(r.prompt).toBe("hello");
    expect(r.hasPrint).toBe(true);
    expect(r.outputFormat).toBe("text");
    expect(r.needsVerbose).toBe(false);
    expect(r.claudeArgs).toContain("-p");
    expect(r.claudeArgs).toContain("hello");
    // Default output format appended
    expect(r.claudeArgs).toContain("--output-format");
    expect(r.claudeArgs).toContain("text");
  });

  test("--print is a synonym of -p", () => {
    const r = validateProgArgs(["--print", "hello"]);
    expect(r.hasPrint).toBe(true);
    expect(r.prompt).toBe("hello");
  });

  test("--output-format json: no --verbose", () => {
    const r = validateProgArgs(["-p", "hi", "--output-format", "json"]);
    expect(r.outputFormat).toBe("json");
    expect(r.needsVerbose).toBe(false);
    expect(r.claudeArgs).not.toContain("--verbose");
  });

  test("--output-format stream-json auto-adds --verbose", () => {
    const r = validateProgArgs(["-p", "hi", "--output-format", "stream-json"]);
    expect(r.outputFormat).toBe("stream-json");
    expect(r.needsVerbose).toBe(true);
    expect(r.claudeArgs).toContain("--verbose");
  });

  test("--output-format=json (equals form) parses same", () => {
    const r = validateProgArgs(["-p", "hi", "--output-format=json"]);
    expect(r.outputFormat).toBe("json");
    expect(r.claudeArgs).toContain("--output-format=json");
  });

  test("--effort accepts every valid value", () => {
    for (const v of ["low", "medium", "high", "xhigh", "max"] as const) {
      const r = validateProgArgs(["-p", "hi", "--effort", v]);
      expect(r.claudeArgs).toContain(v);
    }
  });

  test("--effort=high (equals form)", () => {
    const r = validateProgArgs(["-p", "hi", "--effort=high"]);
    expect(r.claudeArgs).toContain("--effort=high");
  });

  test("--no-continue sets noContinue + passes through", () => {
    const r = validateProgArgs(["-p", "hi", "--no-continue"]);
    expect(r.noContinue).toBe(true);
    expect(r.claudeArgs).toContain("--no-continue");
  });

  test("--update sets wantsUpdate + does NOT pass through to claude (it's a wrapper flag)", () => {
    const r = validateProgArgs(["-p", "hi", "--update"]);
    expect(r.wantsUpdate).toBe(true);
    expect(r.claudeArgs).not.toContain("--update");
  });

  test("multiple value-taking flags mixed", () => {
    const r = validateProgArgs([
      "-p", "the prompt",
      "--model", "claude-opus-4-7",
      "--effort", "high",
      "--system-prompt", "you are terse",
    ]);
    expect(r.claudeArgs).toContain("--model");
    expect(r.claudeArgs).toContain("claude-opus-4-7");
    expect(r.claudeArgs).toContain("high");
    expect(r.claudeArgs).toContain("you are terse");
  });
});

describe("validateProgArgs — rejects (the whole reason this validator exists)", () => {
  test("no -p, bare positional → 'Unknown command' (bash-parity, positional before -p is rejected)", () => {
    expect(() => validateProgArgs(["hello"])).toThrow(/Unknown command/);
  });

  test("empty argv → 'requires -p'", () => {
    expect(() => validateProgArgs([])).toThrow(/requires -p/);
  });

  test("-p with no prompt → 'no prompt provided'", () => {
    expect(() => validateProgArgs(["-p"])).toThrow(/no prompt provided/);
  });

  test("unknown --flag → 'Unknown flag'", () => {
    expect(() => validateProgArgs(["-p", "hi", "--nonsense"])).toThrow(/Unknown flag/);
  });

  test("unknown --flag=value form → 'Unknown flag'", () => {
    expect(() => validateProgArgs(["-p", "hi", "--nonsense=bar"])).toThrow(/Unknown flag/);
  });

  test("--effort with invalid value → 'Invalid effort' (matches #31 fix)", () => {
    expect(() => validateProgArgs(["-p", "hi", "--effort", "hihg"])).toThrow(/Invalid effort/);
    expect(() => validateProgArgs(["-p", "hi", "--effort=hihg"])).toThrow(/Invalid effort/);
  });

  test("--output-format with invalid value → 'Invalid output format'", () => {
    expect(() => validateProgArgs(["-p", "hi", "--output-format", "csv"])).toThrow(/Invalid output format/);
    expect(() => validateProgArgs(["-p", "hi", "--output-format=csv"])).toThrow(/Invalid output format/);
  });

  test("value-taking flag with no value → 'Missing value'", () => {
    expect(() => validateProgArgs(["-p", "hi", "--model"])).toThrow(/Missing value/);
  });

  test("positional before -p → 'Unknown command'", () => {
    expect(() => validateProgArgs(["stray", "-p", "hi"])).toThrow(/Unknown command/);
  });

  test("second positional after prompt → 'extra positional'", () => {
    expect(() => validateProgArgs(["-p", "hi", "second"])).toThrow(/extra positional/);
  });

  test("throws DridockError specifically (so CLI can format + exit)", () => {
    try {
      validateProgArgs(["hello"]);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
    }
  });
});
