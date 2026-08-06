# Windows Setup

Prime Agent runs natively on Windows. The agent, the IPython kernel, background
services, and session resume all work without WSL.

## Install

```powershell
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

To install the latest beta built from `main`:

```powershell
irm https://app.primeintellect.ai/prime-agent/install-beta.ps1 | iex
```

The installer needs Node.js 20.6.0 or newer and npm. It downloads a versioned
release, verifies its SHA-256 checksum, installs the `prime-agent` command with
`npm install -g`, and offers to prepare the IPython runtime.

To run a source checkout instead:

```powershell
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
.\prime-agent.ps1
```

`prime-agent.cmd` is the same runner for `cmd.exe`.

## Bash

The `bash` tool and the `!` shell command run through a bash shell. Checked
locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.
Nothing else in Prime Agent depends on it — the IPython kernel, subagents, and
background services all run natively.

### Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Python kernel

The kernel venv lives at `%USERPROFILE%\.prime\agent\kernel-venv` and uses the
Windows layout (`Scripts\python.exe`). `uv` builds it on first use; install `uv`
yourself, or let Prime Agent install it, or point
`PRIME_AGENT_KERNEL_PYTHON` at an interpreter that already has `ipykernel` and
`prime-agent-runtime`.

## Background services

Daemons and their workers listen on named pipes rather than unix sockets. Pipe
names are scoped per user (`\\.\pipe\prime-agent-<user>-<id>-daemon`), so
concurrent users on one machine never share a daemon. `prime-agent agents`,
`status`, `doctor`, and `shutdown` discover daemons by enumerating that
namespace.

Two Windows differences are worth knowing:

- A named pipe exists only while its server holds it open, so there is no
  orphaned-socket-file case to clean up.
- The pipe namespace names listeners without naming their owner. Prime Agent
  takes each daemon's pid from its own handshake, so a **hung** daemon that
  answers nothing reports as unreachable without a pid. Stop it from Task
  Manager if `prime-agent shutdown --force` cannot.

## Known gaps

- `ctrl+z` suspend has no default binding; Windows terminals have no job control.
- The kernel forkserver is Linux-only. Windows spawns kernels directly, which is
  slower to start but otherwise identical.
- IPython's own `%%bash` cell magic resolves whatever `bash` it finds on PATH,
  which can be WSL's — a separate environment with its own filesystem view
  (`/mnt/c/...`) that does not inherit the kernel's variables. Prime Agent's
  `bash` tool and `!` command do not go through that magic; they use the shell
  resolved above. Set `shellPath` if you want a specific one.
- Self-update infers a custom npm prefix only when npm's own shim sits beside
  the install. Otherwise `prime-agent update` targets npm's default prefix.
- A daemon-backed run is slow to start. It boots three Node processes, and a
  cold worker needs roughly nine seconds to reach `listen()` on Windows, so a
  one-shot `--print` against a fresh daemon can take the better part of a
  minute. Reattaching to a running daemon skips most of that.
- Killing a frontend outright does not close its owned worker's sessions
  cleanly. The worker still dies with the frontend — that guarantee holds — but
  Windows tears it down before any JavaScript runs, so no shutdown listener
  fires: a child in that shape sees no `disconnect`, no `uncaughtException`, and
  not even its own `exit` handler. A frontend that exits normally still unwinds
  gracefully through stdin EOF.
- Kernel-backed tests can time out under the full suite's parallelism. Each one
  starts a real IPython kernel, and Windows process startup is slow enough that
  several at once can exceed a 30s test timeout. They pass run individually; if
  you see them fail together, re-run the file on its own before believing it.
