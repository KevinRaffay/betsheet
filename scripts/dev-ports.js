// Who is holding a dev port, and which process is the one worth killing.
//
// Why this exists: a stale `npm run dev` stack keeps 8788 (and 5175) forever,
// and the only symptom is one line of EADDRINUSE naming no culprit. Worse,
// killing the process that actually holds the port is usually WRONG - it is a
// supervised child (`node --watch`, or scripts/dev-watch.js), so the
// supervisor immediately respawns it and the port never frees. Found live
// 2026-09-04: an `npm run dev` from an hour earlier still owned 8788 through
// a `node --watch` parent that had respawned its child minutes before, while
// a fresh `npm run dev` sat there with a dead API.
//
// So the useful answer is not "who holds the port" but "what is the ROOT of
// the process tree that holds the port" - the `npm run dev` at the top, whose
// death takes the whole stack with it. That is what `holderTree` returns.
//
// Used by scripts/dev-watch.js (preflight, diagnose only) and
// scripts/dev-clean.js (the CLI that kills).

import { execFileSync } from 'node:child_process';
import net from 'node:net';

/** Command lines that are part of a BetSheet dev stack. */
const DEV_STACK = /npm-cli\.js["' ]+run["' ]+dev|concurrently|dev-watch\.js|vite\.js|["' ]vite["' ]|server[\\/]index\.js|node --watch/i;
/** Process names an ancestor walk may pass through. Never a shell/terminal. */
const WALKABLE = /^(node\.exe|cmd\.exe|npm\.cmd|node)$/i;

/** One bind attempt. Free unless the address is actually taken. */
function bindable(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, host);
    } catch {
      resolve(true); // e.g. no IPv6 stack: nothing can be holding it there
    }
  });
}

/**
 * Is `port` free on loopback?
 *
 * A real bind attempt, not a scan - it asks exactly what a server is about to
 * ask, with no parsing and no privileges. BOTH families are probed, and that
 * is not pedantry: the API binds 127.0.0.1 (invariant 10) while vite binds
 * ::1 on Windows, so a v4-only probe calls a port vite is holding "free".
 * Caught exactly that way while testing this script against a live orphan.
 */
export async function probePort(port) {
  const [v4, v6] = await Promise.all([bindable(port, '127.0.0.1'), bindable(port, '::1')]);
  return v4 && v6;
}

/**
 * The listener's process chain, leaf first, as
 * [{ pid, name, cmd, started, parent }]. Windows only; [] anywhere else (and
 * on any failure - this is diagnostics, it must never throw into a caller).
 */
function processChain(port) {
  if (process.platform !== 'win32') return [];
  // $pid is a PowerShell automatic variable (the shell's own id) - shadowing
  // it silently walks the wrong tree, so this uses $procId throughout.
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$conn = Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1
if (-not $conn) { '[]'; exit }
$procId = $conn.OwningProcess
$out = @()
while ($procId -and $procId -ne 0 -and $out.Count -lt 12) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId"
  if (-not $p) { break }
  $out += [PSCustomObject]@{
    pid = [int]$p.ProcessId
    name = $p.Name
    cmd = ($p.CommandLine -replace '\\s+', ' ')
    started = $(if ($p.CreationDate) { $p.CreationDate.ToString('HH:mm:ss') } else { '' })
    parent = [int]$p.ParentProcessId
  }
  $procId = $p.ParentProcessId
}
$out | ConvertTo-Json -Depth 3 -Compress`;
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Windows PowerShell 5.1 has no ConvertTo-Json -AsArray, and its usual
    // workaround (the `,$out` array-wrap) serializes as
    // {"value":[...],"Count":n} rather than a bare array - so the script emits
    // $out plainly and the two real shapes are normalized here: one row comes
    // back as an object, several as an array.
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.value)) return parsed.value;
    return parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

/**
 * What holds `port`, and what to kill to free it.
 *
 * `leaf` is the listener itself; `root` is the topmost ancestor still
 * recognisable as part of a dev stack - killing that tree is what actually
 * frees the port, because killing the leaf alone just lets its supervisor
 * respawn it. The walk stops at the first ancestor that is a shell or does
 * not look like a dev process, so a terminal is never a kill target.
 *
 * Returns null when the port is free or the holder cannot be identified.
 */
export function holderTree(port) {
  const chain = processChain(port);
  if (chain.length === 0) return null;

  const leaf = chain[0];
  let root = leaf;
  for (const p of chain.slice(1)) {
    if (!WALKABLE.test(p.name ?? '')) break;      // a shell/terminal: stop
    if (!DEV_STACK.test(p.cmd ?? '')) break;      // not part of the stack
    root = p;
  }
  return { leaf, root, chain, sameProcess: leaf.pid === root.pid };
}

/** One-line description of a process for a terminal message. */
export function describe(p) {
  const cmd = (p.cmd ?? '').replace(/^"?[A-Za-z]:[\\/][^"]*[\\/]node(\.exe)?"?\s*/i, 'node ');
  const short = cmd.length > 110 ? `${cmd.slice(0, 107)}...` : cmd;
  return `PID ${p.pid}${p.started ? ` (started ${p.started})` : ''}: ${short}`;
}
