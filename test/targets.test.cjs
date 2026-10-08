const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

async function setup(t, count, protectedServer = false) {
  const directory = '/tmp/targets-test';
  const files = new Map();
  const terminals = [];
  const servers = [];
  const saved = new Map();
  const root = { fsPath: directory };
  for (let index = 0; index < count; index++) {
    const server = http.createServer((req, res) => {
      if (protectedServer && req.headers.authorization !== `Basic ${Buffer.from('opencode:secret').toString('base64')}`) { res.writeHead(401); res.end('Unauthorized'); return; }
      res.end('{"healthy":true,"version":"1.18.32"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    terminals.push({ name: 'opencode', creationOptions: { env: { _EXTENSION_OPENCODE_PORT: String(port) } } });
    servers.push(server);
    files.set(join(directory, '.opencode', 'ssh-images', `current-${port}.json`), { port, directory, pid: process.pid, sessionID: `ses_${index}`, title: `会话 ${index}`, updatedAt: Date.now() });
  }
  t.after(async () => { for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve)); });
  const pickerCalls = [];
  let selection = items => items[0];
  let prompts = 0;
  const vscode = {
    Uri: { joinPath: (root, ...paths) => ({ fsPath: join(root.fsPath, ...paths) }) },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      fs: {
        readFile: async uri => { if (!files.has(uri.fsPath)) throw new Error('missing'); return Buffer.from(JSON.stringify(files.get(uri.fsPath))); },
        readDirectory: async uri => [...files.keys()].filter(path => path.startsWith(uri.fsPath)).map(path => [path.split('/').pop(), 1]),
      },
    },
    window: {
      terminals, activeTerminal: undefined,
      showQuickPick: async (items, options) => { pickerCalls.push({ items, options }); return selection(items); },
      showInputBox: async () => { prompts++; return 'secret'; },
    },
  };
  const path = join(__dirname, '..', 'src', 'targets.cjs');
  const sandbox = { module: { exports: {} }, Buffer, process, require: name => name === 'vscode' ? vscode : createRequire(path)(name) };
  vm.runInNewContext(await fs.readFile(path, 'utf8'), sandbox, { filename: path });
  const context = { workspaceState: { get: key => saved.get(key), update: async (key, value) => saved.set(key, value) } };
  const manager = sandbox.module.exports.createTargets(context);
  return { manager, root, vscode, files, terminals, servers, saved, pickerCalls, choose: fn => { selection = fn; }, prompts: () => prompts };
}

test('ambiguous targets wait for selection, active target auto-connects, remembered target wins on reopen', async t => {
  const s = await setup(t, 2);
  assert.equal((await s.manager.auto(s.root)).target, undefined);
  assert.equal(s.pickerCalls.length, 0, 'background discovery must not pop dialogs');
  s.vscode.window.activeTerminal = s.terminals[1];
  const selected = (await s.manager.auto(s.root)).target;
  assert.equal(selected.title, '会话 1');
  s.vscode.window.activeTerminal = s.terminals[0];
  assert.equal((await s.manager.auto(s.root)).target.port, selected.port);
  s.choose(items => items.find(item => item.target?.port !== selected.port));
  const switched = await s.manager.pick(s.root, selected);
  assert.equal(switched.title, '会话 0');
  const items = s.pickerCalls[0].items;
  assert.ok(items[0].label.includes('$(check)'));
  assert.ok(items[0].label.includes('会话 1'));
  assert.ok(items[0].detail.includes('ses_1'));
  s.choose(() => undefined);
  assert.equal(await s.manager.pick(s.root, switched), undefined);
  assert.equal((await s.manager.auto(s.root)).target.port, switched.port);
});

test('registry discovers manual CLI and expired session records never become guessed titles', async t => {
  const s = await setup(t, 1);
  const port = Number(s.terminals[0].creationOptions.env._EXTENSION_OPENCODE_PORT);
  s.vscode.window.terminals = [];
  const selected = (await s.manager.auto(s.root)).target;
  assert.equal(selected.title, '会话 0');
  const path = [...s.files.keys()][0];
  s.files.get(path).updatedAt = Date.now() - 10000;
  const expired = await s.manager.inspect(s.root, selected);
  assert.equal(expired.title, '会话待识别');
  assert.equal(expired.session, undefined);
  await new Promise(resolve => s.servers[0].close(resolve));
  const offline = await s.manager.inspect(s.root, selected);
  assert.equal(offline.online, false);
  assert.equal(offline.port, port);
});

test('old image bridge ready record discovers port without terminal or TUI heartbeat', async t => {
  const s = await setup(t, 1);
  const port = Number(s.terminals[0].creationOptions.env._EXTENSION_OPENCODE_PORT);
  s.vscode.window.terminals = [];
  s.files.clear();
  const path = join(s.root.fsPath, '.opencode', 'ssh-images', `ready-${port}.json`);
  s.files.set(path, { version: '0.1.0', directory: s.root.fsPath, pid: process.pid });
  const selected = (await s.manager.auto(s.root)).target;
  assert.equal(selected.port, port);
  assert.equal(selected.source, 'ready');
  assert.equal(selected.title, '会话待识别');
  assert.equal(selected.online, true);
  s.saved.clear();
  s.files.set(path, { directory: s.root.fsPath, pid: process.ppid });
  assert.equal((await s.manager.auto(s.root)).target, undefined, 'stale PID must not associate another server with this project');
  s.files.set(path, { directory: '/other-project', pid: process.pid });
  assert.equal((await s.manager.auto(s.root)).target, undefined);
});

test('password prompt happens only during explicit connect and is cached for refreshes', async t => {
  const s = await setup(t, 1, true);
  assert.equal((await s.manager.auto(s.root)).target, undefined);
  assert.equal(s.prompts(), 0);
  const selected = await s.manager.pick(s.root);
  assert.equal(selected.online, true);
  assert.equal(s.prompts(), 1);
  assert.equal((await s.manager.inspect(s.root, selected)).online, true);
  await s.manager.pick(s.root, selected);
  assert.equal(s.prompts(), 1);
});
