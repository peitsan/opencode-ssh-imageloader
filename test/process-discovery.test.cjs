const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processTargets, listeningSockets } = require('../src/process-discovery.cjs');

const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
function row(port, inode, address = '0100007F', state = '0A') {
  return `  0: ${address}:${port.toString(16).padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1\n`;
}

test('socket parser identifies only reachable listening ports by inode', () => {
  const text = header + row(39730, 1234) + row(4000, 2234, '00000000') + row(4001, 3234, '0100007F', '01') + row(9000, 4234, '0100A8C0');
  assert.deepEqual([...listeningSockets(text)], [['1234', 39730], ['2234', 4000]]);
});

test('process discovery matches socket ownership, user and project, skips headless servers', async () => {
  const processes = {
    10: { uid: 1000, name: 'opencode', cwd: '/project', argv: ['opencode', '--port', '0'], inode: '100', port: 39730 },
    11: { uid: 1000, name: 'opencode', cwd: '/other-project', argv: ['opencode'], inode: '101', port: 39731 },
    12: { uid: 1001, name: 'opencode', cwd: '/project', argv: ['opencode'], inode: '102', port: 39732 },
    13: { uid: 1000, name: 'node', cwd: '/project', argv: ['node'], inode: '103', port: 39733 },
    14: { uid: 1000, name: 'opencode', cwd: '/project', argv: ['opencode', 'serve'], inode: '104', port: 39734 },
  };
  const paths = path => { const [, pid, ...rest] = path.slice(1).split('/'); return { process: processes[pid], item: rest.join('/') }; };
  const io = {
    async stat(path) { return { uid: paths(path).process.uid }; },
    async readdir(path) { return path === '/fake-proc' ? [...Object.keys(processes), 'net', 'self'] : ['13', '14']; },
    async realpath(path) { return path.startsWith('/fake-proc') ? paths(path).process.cwd : '/project'; },
    async readFile(path) {
      const { process, item } = paths(path);
      if (item === 'comm') return process.name;
      if (item === 'cmdline') return process.argv.join('\0');
      if (item === 'net/tcp') return header + Object.values(processes).map(p => row(p.port, p.inode)).join('');
      if (item === 'net/tcp6') return header;
      throw new Error('not found');
    },
    async readlink(path) {
      const { process, item } = paths(path);
      return item === 'exe' ? `/snap/opencode/237/bin/${process.name}` : item === 'fd/13' ? `socket:[${process.inode}]` : '/dev/pts/1';
    },
  };
  assert.deepEqual(await processTargets('/project', { procRoot: '/fake-proc', fs: io, uid: 1000 }), [
    { port: 39730, pid: 10, source: 'process', directory: '/project' },
  ]);
});
