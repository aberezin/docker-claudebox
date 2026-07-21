#!/usr/bin/env python3
"""claudebox host agent (Approach 2) — runs an ALLOWLISTED host command
(colima/limactl) on behalf of a claudebot developing the harness *inside* a container.

SECURITY: this is remote command execution against the Mac. It is deliberately narrow:
  - binds ONLY the Colima gateway (192.168.64.1), never 0.0.0.0/LAN;
  - requires a per-session bearer token (CB_HOST_AGENT_TOKEN);
  - allowlists the binary AND subcommand (the fixed set the framework actually uses);
  - opt-in / off by default (only runs while `dridock host-agent up`).
It is a TRUSTED, single-operator tool — for you driving your own harness dev dridock, not a
general claudebot capability. See docs/design/backends.md.

Line protocol (one connection = one command):
  client -> "<token>\n"  then  "<json argv>\n"   (e.g. ["colima","list","--json"])
  server -> combined stdout+stderr stream, then  "__CBEXIT__ <code>\n"
"""
import json, os, socket, subprocess, sys, threading

BIND = os.environ.get("CB_HOST_AGENT_BIND", "192.168.64.1")
PORT = int(os.environ.get("CB_HOST_AGENT_PORT", "9280"))
TOKEN = os.environ.get("CB_HOST_AGENT_TOKEN", "")

# binary -> allowed subcommands (the fixed set wrapper.sh / Makefile use). Narrow on purpose.
ALLOW = {
    "colima":  {"list", "status", "start", "stop", "delete", "ssh", "version", "template"},
    "limactl": {"disk", "list", "sudoers", "--version", "start-at-login"},
}

if not TOKEN:
    print("host-agent: refusing to start without CB_HOST_AGENT_TOKEN", file=sys.stderr)
    sys.exit(1)


def _denied(f, msg):
    f.write((msg + "\n").encode()); f.write(b"__CBEXIT__ 77\n"); f.flush()


def handle(conn):
    try:
        f = conn.makefile("rwb")
        if f.readline().decode("utf-8", "replace").strip() != TOKEN:
            _denied(f, "host-agent: bad token"); return
        try:
            argv = json.loads(f.readline().decode("utf-8", "replace"))
        except Exception:
            _denied(f, "host-agent: malformed request"); return
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            _denied(f, "host-agent: malformed argv"); return
        binary = os.path.basename(argv[0])
        sub = argv[1] if len(argv) > 1 else ""
        if binary not in ALLOW or (sub and sub not in ALLOW[binary]):
            _denied(f, "host-agent: not allowed: %s %s" % (binary, sub)); return
        # run it; stream combined output back live
        try:
            p = subprocess.Popen([binary] + argv[1:], stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT)
        except FileNotFoundError:
            _denied(f, "host-agent: %s not found on the Mac" % binary); return
        for line in iter(p.stdout.readline, b""):
            f.write(line); f.flush()
        p.wait()
        f.write(("__CBEXIT__ %d\n" % p.returncode).encode()); f.flush()
    except Exception as e:
        try:
            conn.sendall(("host-agent error: %s\n__CBEXIT__ 1\n" % e).encode())
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((BIND, PORT))
    except OSError as e:
        print("host-agent: cannot bind %s:%d (%s) — is the Colima gateway up?" % (BIND, PORT, e),
              file=sys.stderr)
        sys.exit(1)
    s.listen(16)
    print("host-agent: listening on %s:%d (allow: %s)" %
          (BIND, PORT, ", ".join(sorted(ALLOW))), file=sys.stderr)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
