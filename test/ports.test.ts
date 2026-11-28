// The localhost servers a task's machine listens on: the /proc/net/tcp{,6} records (the hex forms, LISTEN only) and
// the read of a stand-in /proc, where a pid's working directory marks the task's own worktree.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProcNet, PORT_CAP, portUrl, procAddress, reachable, readPorts } from '../server/live/ports.ts'

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** a stand-in /proc: socket tables, and pids with an fd holding a socket, a comm and maybe a cwd */
function fakeProc(o: { tcp?: string; tcp6?: string; pids?: Record<string, { sockets?: number[]; comm?: string; cwd?: string }> }) {
  const root = mkdtempSync(join(tmpdir(), 'shep-proc-'))
  dirs.push(root)
  mkdirSync(join(root, 'net'))
  writeFileSync(join(root, 'net/tcp'), o.tcp ?? '')
  writeFileSync(join(root, 'net/tcp6'), o.tcp6 ?? '')
  for (const [pid, p] of Object.entries(o.pids ?? {})) {
    const at = join(root, pid)
    mkdirSync(join(at, 'fd'), { recursive: true })
    if (p.comm !== undefined) writeFileSync(join(at, 'comm'), `${p.comm}\n`)
    if (p.cwd) symlinkSync(p.cwd, join(at, 'cwd'))
    ;(p.sockets ?? []).forEach((inode, i) => symlinkSync(`socket:[${inode}]`, join(at, 'fd', String(i + 3))))
  }
  return root
}

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
/** one /proc/net/tcp line: address:port, state, uid, inode */
const rec = (addr: string, port: number, state: string, uid: number, inode: number) =>
  `   0: ${addr}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`

describe('the socket tables', () => {
  test('a hex address, IPv4 and IPv6, as a browser says it', () => {
    expect(procAddress('0100007F', false)).toBe('127.0.0.1')
    expect(procAddress('00000000', false)).toBe('0.0.0.0')
    expect(procAddress('0A00000A', false)).toBe('10.0.0.10')
    // each 32-bit word is little-endian: ::1, ::
    expect(procAddress('00000000000000000000000001000000', true)).toBe('::1')
    expect(procAddress('00000000000000000000000000000000', true)).toBe('::')
    expect(procAddress('000080FE000000000000000000000000', true)).toBe('fe80::')
    expect(procAddress('000080FE000000000000000001000000', true)).toBe('fe80::1')
    // a dual-stack server's IPv4-mapped address is that IPv4 address
    expect(procAddress('0000000000000000FFFF00000100007F', true)).toBe('127.0.0.1')
    expect(procAddress('nonsense', false)).toBe('')
  })

  test('LISTEN records only, with their port, uid and inode', () => {
    const got = parseProcNet(HEAD + rec('0100007F', 3000, '0A', 1000, 111) + rec('0100007F', 3000, '01', 1000, 444) + rec('00000000', 4000, '0A', 1000, 222), false)
    expect(got).toEqual([
      { port: 3000, address: '127.0.0.1', inode: 111, uid: 1000 },
      { port: 4000, address: '0.0.0.0', inode: 222, uid: 1000 },
    ])
    // a kernel socket, with no inode to own, is left out
    expect(parseProcNet(HEAD + rec('0100007F', 5000, '0A', 1000, 0), false)).toEqual([])
  })

  test('only what a same-machine browser can reach', () => {
    expect(reachable('127.0.0.1')).toBe(true)
    expect(reachable('0.0.0.0')).toBe(true)
    expect(reachable('::1')).toBe(true)
    expect(reachable('::')).toBe(true)
    // another loopback address, or a LAN one, is not where the URL below points
    expect(reachable('127.0.0.2')).toBe(false)
    expect(reachable('10.0.0.10')).toBe(false)
    expect(reachable('fe80::1')).toBe(false)
  })
})

describe('the list', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'shep-wt-'))
  dirs.push(worktree)
  const other = mkdtempSync(join(tmpdir(), 'shep-other-'))
  dirs.push(other)
  const tcp =
    HEAD +
    rec('0100007F', 3000, '0A', 1000, 111) +
    rec('00000000', 4000, '0A', 1000, 333) +
    rec('00000000', 8080, '0A', 1000, 222) +
    rec('0100007F', 9000, '0A', 0, 555) +
    rec('0A00000A', 9001, '0A', 1000, 888) +
    rec('0200007F', 9002, '0A', 1000, 999) +
    rec('0100007F', 11000, '0A', 1000, 777)
  const tcp6 =
    HEAD +
    rec('00000000000000000000000001000000', 3000, '0A', 1000, 666) +
    rec('00000000000000000000000001000000', 3002, '0A', 1000, 667)
  const proc = fakeProc({
    tcp,
    tcp6,
    pids: {
      '1234': { sockets: [111], comm: 'bun', cwd: join(worktree, 'server') },
      '2345': { sockets: [333], comm: 'vite', cwd: other },
      '3456': { sockets: [666, 667], comm: 'node', cwd: other },
      '4567': { sockets: [222], comm: 'python3' },
    },
  })

  test('this user’s reachable listeners, lowest port first, once per port, with what can be read of each', () => {
    expect(readPorts({ proc, uid: 1000, worktree })).toEqual([
      // its directory is in the task's worktree: marked, whatever the process
      { port: 3000, url: 'http://127.0.0.1:3000', process: 'bun', cwd: join(worktree, 'server'), mine: true },
      // bound only to ::1: opened there, not at a 127.0.0.1 where nothing listens
      { port: 3002, url: 'http://[::1]:3002', process: 'node', cwd: other },
      { port: 4000, url: 'http://127.0.0.1:4000', process: 'vite', cwd: other },
      // its cwd could not be read: a plain port and nothing else
      { port: 8080, url: 'http://127.0.0.1:8080' },
      // no process holds it: a plain port
      { port: 11000, url: 'http://127.0.0.1:11000' },
    ])
    // never a socket another user owns, nor one the panel's browser cannot open at the URL we give
    const ports = readPorts({ proc, uid: 1000, worktree }).map((s) => s.port)
    expect(ports).not.toContain(9000)
    expect(ports).not.toContain(9001)
    expect(ports).not.toContain(9002)
  })

  test('a task’s own worktree, not one whose path starts the same', () => {
    const sibling = fakeProc({
      tcp: HEAD + rec('0100007F', 3000, '0A', 1000, 111) + rec('0100007F', 3001, '0A', 1000, 222),
      pids: { '1234': { sockets: [111], comm: 'bun', cwd: worktree }, '2345': { sockets: [222], comm: 'bun', cwd: `${worktree}-old` } },
    })
    const list = readPorts({ proc: sibling, uid: 1000, worktree })
    expect(list.map((s) => [s.port, !!s.mine])).toEqual([
      [3000, true],
      [3001, false],
    ])
  })

  test('at most the cap, and nothing when there is no table', () => {
    const many = fakeProc({
      tcp: HEAD + Array.from({ length: PORT_CAP + 5 }, (_, i) => rec('0100007F', 7000 + i, '0A', 1000, 100 + i)).join(''),
    })
    const list = readPorts({ proc: many, uid: 1000 })
    expect(list.length).toBe(PORT_CAP)
    expect(list.at(0)!.port).toBe(7000)
    expect(list.at(-1)!.port).toBe(7000 + PORT_CAP - 1)
    expect(readPorts({ proc: fakeProc({}), uid: 1000 })).toEqual([])
    expect(readPorts({ proc: join(tmpdir(), 'shep-proc-does-not-exist'), uid: 1000 })).toEqual([])
  })

  test('the URL a press opens is one the socket answers on', () => {
    expect(portUrl('0.0.0.0', 5173)).toBe('http://127.0.0.1:5173')
    expect(portUrl('127.0.0.1', 5173)).toBe('http://127.0.0.1:5173')
    expect(portUrl('::', 5173)).toBe('http://127.0.0.1:5173')
    expect(portUrl('::1', 5173)).toBe('http://[::1]:5173')
  })
})
