import { test, expect, describe } from "bun:test";
import { BridgeStateReader } from "./BridgeStateReader.ts";
import { HOST_AGENT_DEFAULT_BIND, HOST_AGENT_DEFAULT_PORT } from "./HostAgentService.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { StubProcessProbe } from "../infra/ProcessProbe.ts";

/**
 * The host-agent URL handed to every container is composed here. Its port
 * default was retyped rather than shared, and drifted: this file said 8790
 * (a bash-wrapper-era value) while HostAgentService, host-agent.py and their
 * tests all said 9280.
 *
 * Nothing caught it because HostAgentService sets DRIDOCK_HOST_AGENT_PORT only
 * in the SPAWNED CHILD's env — the host binary's own environment never has it.
 * So the default branch is the normal path, not an edge case, and every
 * container was told the agent lived on a port with nothing listening.
 */
function seedLiveAgent(): { fs: InMemoryFileSystem; probe: StubProcessProbe } {
  const fs = new InMemoryFileSystem();
  const xdg = "/home/alan/.config/dridock";
  fs.seed(`${xdg}/host-agent/pid`, "1000\n");
  fs.seed(`${xdg}/host-agent/token`, "tok\n");
  const probe = new StubProcessProbe();
  probe.seedAlive(1000, true);
  return { fs, probe };
}

describe("BridgeStateReader — host-agent URL", () => {
  test("with no env set, uses the port the agent actually binds", async () => {
    const { fs, probe } = seedLiveAgent();
    const { url, token } = await new BridgeStateReader(fs, {}, "/home/alan", probe).hostAgentState();
    expect(url).toBe(`${HOST_AGENT_DEFAULT_BIND}:${HOST_AGENT_DEFAULT_PORT}`);
    expect(url).toContain("9280");
    expect(url).not.toContain("8790");
    expect(token).toBe("tok");
  });

  test("an explicit DRIDOCK_HOST_AGENT_PORT still wins", async () => {
    const { fs, probe } = seedLiveAgent();
    const env = { DRIDOCK_HOST_AGENT_PORT: "9999", DRIDOCK_HOST_AGENT_BIND: "10.0.0.1" };
    const { url } = await new BridgeStateReader(fs, env, "/home/alan", probe).hostAgentState();
    expect(url).toBe("10.0.0.1:9999");
  });

  test("a dead pid yields no url (nothing to hand the container)", async () => {
    const { fs } = seedLiveAgent();
    const probe = new StubProcessProbe();
    probe.seedAlive(1000, false);
    const { url, token } = await new BridgeStateReader(fs, {}, "/home/alan", probe).hostAgentState();
    expect(url).toBe("");
    expect(token).toBe("");
  });
});
