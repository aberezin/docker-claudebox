/**
 * A narrow subset of the `docker` CLI dridock actually shells out to when
 * running the claudebot. Split from `Docker.ts` (which only knows about
 * image labels) so unit tests can inject a fake without also mocking the
 * label surface. Real impl uses Bun.spawn.
 *
 * Kept small on purpose: `runInteractive`, `startAttached`, `stop`,
 * `psFilter`, `execDetached`. Every method aligns 1:1 with the `docker`
 * commands wrapper.sh assembles at container launch time (wrapper.sh
 * lines 2830-3050ish).
 */

/** Common shape for the two "spawn a container that inherits our TTY" paths. */
export interface RunArgs {
  readonly context: string;
  readonly containerName: string;
  readonly image: string;
  readonly mounts: readonly { host: string; container: string; ro?: boolean }[];
  readonly envFile?: string;
  /** Env pairs, listed on the command line as `-e KEY=VALUE`. */
  readonly env: readonly { readonly key: string; readonly value: string }[];
  readonly workdir?: string;
  readonly network?: string;
  /** Detached vs interactive: `-it` (foreground) or `-d` (detached). */
  readonly mode: "interactive" | "detached";
  /** Command + args to run inside the container. */
  readonly cmd: readonly string[];
  /** Extra `-p HOST:CONTAINER` port publishes. */
  readonly publishPorts: readonly string[];
}

export interface PsRow {
  readonly name: string;
  readonly status: string; // e.g. "Up 3 minutes", "Exited (0) 2 hours ago"
  readonly image: string;
}

export interface ContainerRuntime {
  /**
   * Spin up a container with a fresh docker run. Returns the exit code of
   * the process — bash uses this to propagate the container's rc back to
   * the user. For `-it`, the calling process's stdio is inherited.
   */
  runInteractive(args: RunArgs): Promise<number>;

  /** `docker start -ai` — reattach to an existing stopped container. */
  startAttached(context: string, containerName: string): Promise<number>;

  /** `docker stop <name>` — SIGTERM then SIGKILL. Ignores "not found". */
  stop(context: string, containerName: string): Promise<void>;

  /** `docker ps --filter name=^<name>$ --format '{{.Names}}\t{{.Status}}\t{{.Image}}'`. */
  psFilter(context: string, nameExact: string): Promise<PsRow | undefined>;

  /** Detached exec inside a running container. Returns rc; stdout+stderr streamed. */
  execDetached(context: string, containerName: string, cmd: readonly string[]): Promise<number>;
}

export class RealContainerRuntime implements ContainerRuntime {
  async runInteractive(args: RunArgs): Promise<number> {
    const argv = buildRunArgv(args);
    const proc = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
  }

  async startAttached(context: string, containerName: string): Promise<number> {
    const proc = Bun.spawn(["docker", "--context", context, "start", "-ai", containerName], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  }

  async stop(context: string, containerName: string): Promise<void> {
    const proc = Bun.spawn(["docker", "--context", context, "stop", containerName], {
      stdout: "ignore", stderr: "ignore",
    });
    await proc.exited; // rc ignored — "not found" is fine
  }

  async psFilter(context: string, nameExact: string): Promise<PsRow | undefined> {
    const proc = Bun.spawn([
      "docker", "--context", context, "ps", "-a",
      "--filter", `name=^${nameExact}$`,
      "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}",
    ], { stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    if (text === "") return undefined;
    const [name, status, image] = text.split("\t");
    return { name: name ?? "", status: status ?? "", image: image ?? "" };
  }

  async execDetached(context: string, containerName: string, cmd: readonly string[]): Promise<number> {
    const proc = Bun.spawn(["docker", "--context", context, "exec", containerName, ...cmd], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  }
}

/** Build the `docker run ...` argv from RunArgs. Exposed so unit tests can
 *  assert the exact command line without spawning docker. */
export function buildRunArgv(args: RunArgs): string[] {
  const argv: string[] = ["docker", "--context", args.context, "run"];
  argv.push("--name", args.containerName);
  if (args.mode === "interactive") argv.push("-it");
  else argv.push("-d");
  if (args.network !== undefined) argv.push("--network", args.network);
  if (args.workdir !== undefined) argv.push("-w", args.workdir);
  if (args.envFile !== undefined) argv.push("--env-file", args.envFile);
  for (const e of args.env) argv.push("-e", `${e.key}=${e.value}`);
  for (const m of args.mounts) {
    const spec = m.ro === true
      ? `${m.host}:${m.container}:ro`
      : `${m.host}:${m.container}`;
    argv.push("-v", spec);
  }
  for (const p of args.publishPorts) argv.push("-p", p);
  argv.push(args.image);
  argv.push(...args.cmd);
  return argv;
}
