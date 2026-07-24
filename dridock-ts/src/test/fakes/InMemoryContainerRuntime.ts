import type { ContainerRuntime, RunArgs, PsRow } from "../../infra/ContainerRuntime.ts";

/**
 * Fake ContainerRuntime — records what would have run without spawning
 * docker. Tests inspect `.runs`, `.starts`, `.stops`, `.execs` to assert
 * the composition, and seed `psRows` to control container-exists lookups.
 */
export class InMemoryContainerRuntime implements ContainerRuntime {
  readonly runs: RunArgs[] = [];
  readonly starts: Array<{ context: string; container: string }> = [];
  readonly backgroundStarts: Array<{ context: string; container: string }> = [];
  readonly stops: Array<{ context: string; container: string }> = [];
  readonly execs: Array<{ context: string; container: string; cmd: readonly string[] }> = [];
  private readonly psRows = new Map<string, PsRow>();
  /** Deterministic exit codes for scripted scenarios. Key is
   *  "<verb>:<container>" (e.g. "run:claude-_p"). Default 0. */
  readonly nextRc = new Map<string, number>();

  seedPs(containerName: string, row: PsRow): void {
    this.psRows.set(containerName, row);
  }

  async runInteractive(args: RunArgs): Promise<number> {
    this.runs.push(args);
    return this.nextRc.get(`run:${args.containerName}`) ?? 0;
  }

  async startAttached(context: string, containerName: string): Promise<number> {
    this.starts.push({ context, container: containerName });
    return this.nextRc.get(`start:${containerName}`) ?? 0;
  }

  async startBackground(context: string, containerName: string): Promise<number> {
    this.backgroundStarts.push({ context, container: containerName });
    return this.nextRc.get(`start-bg:${containerName}`) ?? 0;
  }

  async stop(context: string, containerName: string): Promise<void> {
    this.stops.push({ context, container: containerName });
  }

  async psFilter(_context: string, nameExact: string): Promise<PsRow | undefined> {
    return this.psRows.get(nameExact);
  }

  async execDetached(context: string, containerName: string, cmd: readonly string[]): Promise<number> {
    this.execs.push({ context, container: containerName, cmd });
    return this.nextRc.get(`exec:${containerName}`) ?? 0;
  }
}
