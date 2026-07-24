import { DridockError } from "../domain/errors.ts";

/**
 * The programmatic-mode arg allowlist — matches wrapper.sh:3150-3240.
 * The safety win from moving this to TS: instead of a 90-line bash case
 * statement, we get a compile-time-checked closed set + a single-pass
 * parser that fails FAST + LOUD on any deviation.
 *
 * Bugs the allowlist protects against (#17, #31, #37):
 *   - `claude` silently ignores unknown flags — an unallowlisted flag
 *     that the user THINKS is doing something would run at default.
 *   - `--effort` accepts any string, silently degrading to default.
 *   - `--no-continue` and `--update` are wrapper flags, not claude
 *     flags — they only apply here.
 */

export const ALLOWED_FLAGS = new Set([
  "-p", "--print",
  "--output-format", "--model", "--system-prompt", "--append-system-prompt",
  "--json-schema", "--effort", "--resume",
  "--no-continue", "--update",
] as const);

export const ALLOWED_OUTPUT_FORMATS = new Set(["text", "json", "json-verbose", "stream-json"] as const);
export const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"] as const);

/** Flags that take a value (either `--flag X` or `--flag=X`). */
const FLAGS_TAKING_VALUE = new Set([
  "--output-format", "--model", "--system-prompt", "--append-system-prompt",
  "--json-schema", "--effort", "--resume",
] as const);

export type OutputFormat = "text" | "json" | "json-verbose" | "stream-json";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ProgArgs {
  /** The prompt (the positional arg after -p). Required. */
  readonly prompt: string;
  /** The full args to pass through to `claude` inside the container. */
  readonly claudeArgs: readonly string[];
  /** Whether -p (or --print) was passed — must be true. */
  readonly hasPrint: boolean;
  /** true when the user passed --no-continue. */
  readonly noContinue: boolean;
  /** true when the user passed --update. */
  readonly wantsUpdate: boolean;
  /** the resolved output format (default "text"). */
  readonly outputFormat: OutputFormat;
  /** true when we should also pass --verbose (stream-json / json-verbose). */
  readonly needsVerbose: boolean;
}

/**
 * Validate + normalize the args passed to `dridock start -p "..."`.
 * Throws DridockError with the same emoji + advice as bash on any
 * rejection — the CLI wrapper catches + prints.
 */
export function validateProgArgs(argv: readonly string[]): ProgArgs {
  let hasPrint = false;
  let hasPrompt = false;
  let noContinue = false;
  let wantsUpdate = false;
  let outputFormat: OutputFormat = "text";
  let sawOutputFormat = false;
  let needsVerbose = false;
  const passArgs: string[] = [];
  let prompt = "";

  let expectValue: string | undefined;
  for (const arg of argv) {
    if (expectValue !== undefined) {
      validateValueForFlag(expectValue, arg);
      if (expectValue === "--output-format") {
        outputFormat = arg as OutputFormat;
        sawOutputFormat = true;
        if (outputFormat === "stream-json" || outputFormat === "json-verbose") needsVerbose = true;
      }
      passArgs.push(expectValue, arg);
      expectValue = undefined;
      continue;
    }

    if (arg === "-p" || arg === "--print") { hasPrint = true; continue; }
    if (arg === "--no-continue") { noContinue = true; passArgs.push(arg); continue; }
    if (arg === "--update") { wantsUpdate = true; continue; }

    if (FLAGS_TAKING_VALUE.has(arg as never)) {
      expectValue = arg;
      continue;
    }

    // --flag=VALUE combined form
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      const flag = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (!FLAGS_TAKING_VALUE.has(flag as never)) {
        throw unknownFlag(arg);
      }
      validateValueForFlag(flag, value);
      if (flag === "--output-format") {
        outputFormat = value as OutputFormat;
        sawOutputFormat = true;
        if (outputFormat === "stream-json" || outputFormat === "json-verbose") needsVerbose = true;
      }
      passArgs.push(arg);
      continue;
    }

    if (arg.startsWith("-")) throw unknownFlag(arg);

    // Positional — the prompt itself. Only accepted once -p was seen.
    if (!hasPrint) {
      throw new DridockError(`Unknown command: ${arg}\n   Use -p or --print for programmatic mode: claude -p "your prompt"`);
    }
    if (hasPrompt) {
      throw new DridockError(`extra positional after prompt: '${arg}' (only one prompt allowed)`);
    }
    hasPrompt = true;
    prompt = arg;
    passArgs.push(arg);
  }

  if (expectValue !== undefined) {
    throw new DridockError(`Missing value for ${expectValue}`);
  }
  if (!hasPrint) {
    throw new DridockError(`programmatic mode requires -p (or --print): dridock start -p "your prompt"`);
  }
  if (!hasPrompt) {
    throw new DridockError(`-p passed but no prompt provided`);
  }

  const claudeArgs: string[] = ["-p", ...passArgs.filter((a) => a !== "-p" && a !== "--print"), ...(!sawOutputFormat ? ["--output-format", outputFormat] : [])];
  if (needsVerbose) claudeArgs.push("--verbose");

  return { prompt, claudeArgs, hasPrint, noContinue, wantsUpdate, outputFormat, needsVerbose };
}

function validateValueForFlag(flag: string, value: string): void {
  if (flag === "--output-format") {
    if (!ALLOWED_OUTPUT_FORMATS.has(value as never)) {
      throw new DridockError(`Invalid output format: ${value} (allowed: text, json, json-verbose, stream-json)`);
    }
  }
  if (flag === "--effort") {
    if (!ALLOWED_EFFORTS.has(value as never)) {
      throw new DridockError(`Invalid effort: ${value} (allowed: low, medium, high, xhigh, max)`);
    }
  }
}

function unknownFlag(flag: string): DridockError {
  return new DridockError(`Unknown flag: ${flag} (allowed: -p, --print, --output-format, --model, --system-prompt, --append-system-prompt, --json-schema, --effort, --resume, --no-continue, --update)`);
}
