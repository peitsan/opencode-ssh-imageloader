const fs = require('node:fs/promises');
const { join, basename } = require('node:path');

// Match socket inodes to LISTEN rows; never scan arbitrary TCP ports.
function listeningSockets(text) {
  const sockets = new Map();
  for (const line of text.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10 || columns[3] !== '0A') continue;
    const [address, hexPort] = columns[1].split(':');
    // The HTTP client uses IPv4 loopback. IPv6 wildcard may also be dual-stack.
    if (!['0100007F', '00000000', '00000000000000000000000000000000'].includes(address)) continue;
    const port = parseInt(hexPort, 16);
    if (port > 0 && port <= 65535) sockets.set(columns[9], port);
  }
  return sockets;
}

async function processTargets(directory, options = {}) {
  if (process.platform !== 'linux' && !options.procRoot) return [];
  const proc = options.procRoot || '/proc';
  const io = options.fs || fs;
  const uid = options.uid ?? process.getuid?.();
  let root;
  let pids;
  try {
    root = await io.realpath(directory);
    pids = (await io.readdir(proc)).filter(name => /^\d+$/.test(name));
  } catch { return []; }
  const found = [];
  let cursor = 0;
  async function worker() {
    while (cursor < pids.length) {
      const pid = pids[cursor++];
      const path = join(proc, pid);
      try {
        const stat = await io.stat(path);
        if (uid !== undefined && stat.uid !== uid) continue;
        const name = (await io.readFile(join(path, 'comm'), 'utf8')).trim();
        if (!/^opencode(?:[-.].*)?$/.test(name)) continue;
        const executable = await io.readlink(join(path, 'exe'));
        if (!/^opencode(?:[-.].*)?$/.test(basename(executable).replace(/ \(deleted\)$/, ''))) continue;
        const cwd = await io.realpath(join(path, 'cwd'));
        if (cwd !== root) continue;
        const argv = (await io.readFile(join(path, 'cmdline'), 'utf8')).split('\0');
        // GUI/headless servers have no terminal prompt to receive images.
        if (argv.slice(1).some(arg => ['serve', 'web', 'run', 'acp'].includes(arg))) continue;
        const sockets = new Map();
        for (const family of ['tcp', 'tcp6']) {
          try {
            for (const [inode, port] of listeningSockets(await io.readFile(join(path, 'net', family), 'utf8'))) sockets.set(inode, port);
          } catch {}
        }
        const ports = new Set();
        for (const fd of await io.readdir(join(path, 'fd'))) {
          try {
            const link = await io.readlink(join(path, 'fd', fd));
            const match = /^socket:\[(\d+)\]$/.exec(link);
            if (match && sockets.has(match[1])) ports.add(sockets.get(match[1]));
          } catch {}
        }
        for (const port of ports) found.push({ port, pid: Number(pid), source: 'process', directory: cwd });
      } catch {
        // Processes may exit during enumeration; inaccessible users are skipped.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, pids.length) }, worker));
  return found;
}

async function isHeadless(pid) {
  if (process.platform !== 'linux') return false;
  try {
    const argv = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    return argv.slice(1).some(arg => ['serve', 'web', 'run', 'acp'].includes(arg));
  } catch { return false; }
}

async function ownsListeningPort(pid, port) {
  if (process.platform !== 'linux') return true;
  try {
    const path = `/proc/${pid}`;
    const inodes = new Set();
    for (const family of ['tcp', 'tcp6']) {
      try {
        for (const [inode, listeningPort] of listeningSockets(await fs.readFile(`${path}/net/${family}`, 'utf8'))) {
          if (listeningPort === port) inodes.add(inode);
        }
      } catch {}
    }
    for (const fd of await fs.readdir(`${path}/fd`)) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(await fs.readlink(`${path}/fd/${fd}`));
        if (match && inodes.has(match[1])) return true;
      } catch {}
    }
    return false;
  } catch { return false; }
}

module.exports = { processTargets, listeningSockets, isHeadless, ownsListeningPort };
