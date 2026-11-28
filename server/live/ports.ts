// The localhost servers a task's machine listens on, for the Browser panel's Servers list. Read from /proc, read only:
// the two socket tables, and for the pids that own the sockets we kept, their working directory and process name.
// Never a process's command line or environment: they can hold tokens, and neither is needed to open a port.
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { PortServer } from '../../shared/types.ts'

/** at most this many, lowest ports first: a panel list, not an inventory */
export const PORT_CAP = 20

/** one LISTEN socket, as /proc/net/tcp writes it */
export interface Listener {
  port: number
  /** the bound address, as a browser says it: 127.0.0.1, 0.0.0.0, ::1, :: */
  address: string
  /** the socket's inode: how its owning pid is found */
  inode: number
  /** the socket owner's uid */
  uid: number
}

/** a /proc/net/tcp{,6} hex address as a browser says it: each 32-bit word is little-endian (0100007F is 127.0.0.1),
 *  and an IPv4-mapped IPv6 address is shown as that IPv4 address */
export function procAddress(hex: string, v6: boolean): string {
  if (!v6) {
    const b = word(hex)
    return b ? b.join('.') : ''
  }
  const bytes: number[] = []
  for (let i = 0; i < 4; i++) {
    const b = word(hex.slice(i * 8, i * 8 + 8))
    if (!b) return ''
    bytes.push(...b)
  }
  // ::ffff:127.0.0.1, which a dual-stack server may bind
  if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join('.')
  const groups = [0, 2, 4, 6, 8, 10, 12, 14].map((i) => ((bytes[i] << 8) | bytes[i + 1]).toString(16))
  // RFC 5952: the longest run of zero groups is compressed, once
  let best = { at: -1, len: 0 }
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== '0') {
      i++
      continue
    }
    let j = i
    while (j < groups.length && groups[j] === '0') j++
    if (j - i > best.len) best = { at: i, len: j - i }
    i = j
  }
  if (best.len < 2) return groups.join(':')
  return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.len).join(':')}`
}

/** eight hex digits of a word, its bytes in reverse order */
function word(hex: string): number[] | null {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null
  const b = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return b.reverse()
}

/** the LISTEN records of a socket table (state 0A); a kernel socket, with no inode, is left out */
export function parseProcNet(text: string, v6: boolean): Listener[] {
  const out: Listener[] = []
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== '0A') continue
    const [addr, port] = f[1].split(':')
    const inode = Number(f[9])
    if (!addr || !port || !inode) continue
    const address = procAddress(addr, v6)
    if (!address) continue
    out.push({ port: parseInt(port, 16), address, inode, uid: Number(f[7]) })
  }
  return out
}

/** a same-machine browser can open it at the address we give out: 127.0.0.1, ::1, or any address. Another loopback
 *  address (127.0.0.2) or a LAN one is not one the panel can reach at the URL below, so it never shows. */
export function reachable(address: string): boolean {
  return address === '0.0.0.0' || address === '::' || address === '::1' || address === '127.0.0.1'
}

/** what the panel's browser opens: this machine's loopback, or [::1] for a socket bound only there */
export const portUrl = (address: string, port: number) => (address === '::1' ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`)

export interface ReadOptions {
  /** the proc filesystem: /proc here, a stand-in in a test */
  proc?: string
  /** whose listeners: this user's only */
  uid?: number
  /** the task's own worktree, whose servers are marked */
  worktree?: string
  cap?: number
}

/**
 * This user's loopback listeners, lowest port first, with the process and working directory of each when they can be
 * read. Nothing is cached: every call reads /proc again.
 */
export function readPorts(o: ReadOptions = {}): PortServer[] {
  const proc = o.proc ?? '/proc'
  const uid = o.uid ?? process.getuid?.() ?? -1
  const table = (name: string) => {
    try {
      return readFileSync(join(proc, name), 'utf8')
    } catch {
      return ''
    }
  }
  const listeners = [...parseProcNet(table('net/tcp'), false), ...parseProcNet(table('net/tcp6'), true)].filter((l) => l.uid === uid && reachable(l.address))
  return portsFrom(listeners, { proc, worktree: o.worktree, cap: o.cap })
}

/** the list for listeners already parsed: who owns each socket, then the panel's answer */
export function portsFrom(listeners: Listener[], o: { proc?: string; worktree?: string; cap?: number } = {}): PortServer[] {
  const proc = o.proc ?? '/proc'
  const owners = socketOwners(proc, new Set(listeners.map((l) => l.inode)))
  const tree = o.worktree ? real(o.worktree) : undefined
  const seen = new Set<number>()
  const out: PortServer[] = []
  for (const l of [...listeners].sort((a, b) => a.port - b.port)) {
    // a server on both 127.0.0.1 and ::1 is one server: the port is what a browser opens
    if (seen.has(l.port)) continue
    seen.add(l.port)
    const pid = owners.get(l.inode)
    const cwd = pid === undefined ? undefined : cwdOf(proc, pid)
    const server: PortServer = { port: l.port, url: portUrl(l.address, l.port) }
    // a port the directory cannot be read for is a plain port: neither its process nor its directory is shown
    if (pid !== undefined && cwd) {
      const name = commOf(proc, pid)
      if (name) server.process = name
      server.cwd = cwd
      if (tree && (cwd === tree || cwd.startsWith(tree + sep))) server.mine = true
    }
    out.push(server)
    if (out.length >= (o.cap ?? PORT_CAP)) break
  }
  return out
}

/** socket inode → the pid whose file table holds it. Other users' processes can't be read: they are skipped. */
function socketOwners(proc: string, wanted: Set<number>): Map<number, number> {
  const found = new Map<number, number>()
  const left = new Set(wanted)
  if (!left.size) return found
  let pids: string[]
  try {
    pids = readdirSync(proc)
  } catch {
    return found
  }
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue
    let fds: string[]
    try {
      fds = readdirSync(join(proc, name, 'fd'))
    } catch {
      continue
    }
    for (const fd of fds) {
      let target: string
      try {
        target = readlinkSync(join(proc, name, 'fd', fd))
      } catch {
        continue
      }
      const inode = Number(/^socket:\[(\d+)\]$/.exec(target)?.[1])
      if (!inode || !left.has(inode)) continue
      left.delete(inode)
      found.set(inode, Number(name))
      if (!left.size) return found
    }
  }
  return found
}

/** the process's own name, as the kernel keeps it (at most 15 characters), never its command line */
function commOf(proc: string, pid: number): string | undefined {
  try {
    return readFileSync(join(proc, String(pid), 'comm'), 'utf8').trim().slice(0, 40) || undefined
  } catch {
    return undefined
  }
}

/** the directory the process runs in; a deleted one is still a directory it ran in */
function cwdOf(proc: string, pid: number): string | undefined {
  try {
    return readlinkSync(join(proc, String(pid), 'cwd')).replace(/ \(deleted\)$/, '') || undefined
  } catch {
    return undefined
  }
}

/** a worktree path as /proc writes a cwd: resolved through any symlink, when it can be */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
