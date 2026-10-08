const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC';

test('workspace host installs CLI bridge, uploads local webview data and appends on remote loopback', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'oc-ssh-extension-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const appended = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('directory'), directory);
    if (url.pathname === '/global/health') { res.end(JSON.stringify({ healthy: true, version: '1.18.32' })); return; }
    assert.equal(url.pathname, '/tui/append-prompt');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { appended.push(JSON.parse(body).text); res.end('true'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const uri = fsPath => ({ fsPath, path: fsPath, with: change => uri(change.path), toString: () => `file://${fsPath}` });
  const root = uri(directory);
  const commands = new Map();
  const messages = [];
  const notices = [];
  let select;
  const stored = new Map();
  let receive;
  let shown = 0;
  let html;
  const panel = {
    reveal() {},
    onDidDispose() {},
    dispose() {},
    webview: {
      cspSource: 'vscode-webview://test',
      asWebviewUri: value => value,
      set html(value) { html = value; },
      async postMessage(message) { messages.push(message); return true; },
      onDidReceiveMessage(callback) { receive = callback; },
    },
  };
  class FileSystemError extends Error { constructor(message, code) { super(message); this.code = code; } }
  const vscode = {
    FileSystemError,
    Uri: { joinPath: (base, ...paths) => uri(join(base.fsPath, ...paths)) },
    ViewColumn: { Beside: 2 },
    workspace: {
      workspaceFolders: [{ name: 'test', uri: root }],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      fs: {
        async readFile(value) {
          try { return await fs.readFile(value.fsPath); }
          catch (error) { if (error.code === 'ENOENT') throw new FileSystemError(error.message, 'FileNotFound'); throw error; }
        },
        writeFile: (value, content) => fs.writeFile(value.fsPath, content),
        createDirectory: value => fs.mkdir(value.fsPath, { recursive: true }),
      },
    },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: {
      terminals: [{ name: 'opencode', creationOptions: { env: { _EXTENSION_OPENCODE_PORT: String(port) } }, show() { shown++; } }],
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showInformationMessage: async message => { notices.push(message); },
      showErrorMessage: async message => { assert.fail(message); },
      showQuickPick: async items => select ? select(items) : items[0],
      createWebviewPanel: () => panel,
    },
  };
  const extensionPath = join(__dirname, '..', process.env.OPENCODE_SSH_IMAGES_TEST_BUNDLE ? 'dist' : 'src', 'extension.cjs');
  const targetPath = join(__dirname, '..', 'src', 'targets.cjs');
  const targetSandbox = { require: name => name === 'vscode' ? vscode : createRequire(targetPath)(name), module: { exports: {} }, Buffer, process };
  vm.runInNewContext(await fs.readFile(targetPath, 'utf8'), targetSandbox, { filename: targetPath });
  const localRequire = createRequire(extensionPath);
  const sandbox = { require: name => name === 'vscode' ? vscode : name === './targets.cjs' ? targetSandbox.module.exports : localRequire(name), module: { exports: {} }, Buffer, process, URL, setInterval, clearInterval };
  vm.runInNewContext(await fs.readFile(extensionPath, 'utf8'), sandbox, { filename: extensionPath });
  const subscriptions = [];
  t.after(() => subscriptions.forEach(item => item.dispose?.()));
  sandbox.module.exports.activate({ extensionUri: uri(join(__dirname, '..')), subscriptions, workspaceState: { get: key => stored.get(key), update: async (key, value) => stored.set(key, value) } });
  await commands.get('opencodeSshImages.open')();
  assert.ok(html.includes("script-src 'nonce-"));
  assert.ok(!html.includes('{{'));
  assert.ok(notices.some(message => message.includes('重启')));
  assert.equal(await fs.readFile(join(directory, '.opencode', 'plugins', 'opencode-ssh-images.js'), 'utf8'), await fs.readFile(join(__dirname, '..', 'assets', 'ssh-images.mjs'), 'utf8'));
  await receive({ type: 'ready' });
  assert.ok(messages.some(message => message.type === 'connection' && message.online));
  assert.equal(stored.get(`sshImages.target:${directory}`).port, port);
  await receive({ type: 'attach', images: [{ name: 'local.png', dataUrl: PNG }] });
  assert.equal(appended.length, 0, 'must not append before CLI has loaded bridge');
  assert.ok(messages.some(message => message.type === 'error' && message.text.includes('重新启动')));
  const hooks = await (await import('../assets/ssh-images.mjs')).default({ directory, serverUrl: new URL(`http://localhost:${port}`) });
  const sessionPath = join(directory, '.opencode', 'ssh-images', `current-${port}.json`);
  const current = { port, pid: process.pid, directory, sessionID: 'ses_exact', title: '当前终端的真实会话名称', updatedAt: Date.now() };
  await fs.writeFile(sessionPath, JSON.stringify(current));
  await receive({ type: 'refresh' });
  assert.equal(messages.at(-1).title, current.title);
  assert.equal(messages.at(-1).sessionID, 'ses_exact');
  assert.equal(panel.title, `图片附件 · ${current.title}`);
  select = items => {
    assert.ok(items[0].label.includes(current.title));
    assert.ok(items[0].label.includes('$(check)'));
    return undefined; // Cancellation must keep the previous connection.
  };
  await receive({ type: 'connect' });
  await receive({ type: 'attach', images: [{ name: 'local.png', dataUrl: PNG }] });
  assert.equal(appended.length, 1);
  assert.equal(shown, 1);
  assert.ok(messages.some(message => message.type === 'attached' && message.count === 1));
  const result = { message: { id: 'msg_test', sessionID: 'ses_test' }, parts: [{ type: 'text', text: appended[0] }] };
  await hooks['chat.message']({}, result);
  assert.equal(result.parts[1].url, PNG);
  assert.equal(result.parts[1].filename, 'local.png');
  await receive({ type: 'attach', images: [{ name: 'bad.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }] });
  assert.equal(appended.length, 1, 'bad image must not append a marker');
  await fs.writeFile(sessionPath, JSON.stringify({ ...current, title: '切换后的会话', sessionID: 'ses_next', updatedAt: Date.now() }));
  await receive({ type: 'refresh' });
  assert.equal(messages.at(-1).title, '切换后的会话');
  await fs.writeFile(sessionPath, JSON.stringify({ ...current, updatedAt: Date.now() - 10000 }));
  await receive({ type: 'refresh' });
  assert.equal(messages.at(-1).title, '会话待识别', 'must not show stale session or guess from most recent session');
});
