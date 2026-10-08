const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');
const { request } = require('../src/core.cjs');
const { processTargets } = require('../src/process-discovery.cjs');

async function main() {
  const base = await fs.mkdtemp(join(tmpdir(), 'oc-ssh-tui-'));
  const directory = join(base, 'workspace');
  const config = join(directory, '.opencode');
  await fs.mkdir(join(config, 'plugins'), { recursive: true });
  await fs.copyFile(join(__dirname, '..', 'assets', 'ssh-images.mjs'), join(config, 'plugins', 'opencode-ssh-images.js'));
  await fs.copyFile(join(__dirname, '..', 'assets', 'ssh-images-tui.mjs'), join(config, 'ssh-images-tui.mjs'));
  await fs.writeFile(join(config, 'tui.json'), JSON.stringify({ $schema: 'https://opencode.ai/tui.json', plugin: [pathToFileURL(join(config, 'ssh-images-tui.mjs')).href] }));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, TERM: 'xterm-256color', _EXTENSION_OPENCODE_PORT: String(port),
    XDG_CONFIG_HOME: join(base, 'config'), XDG_DATA_HOME: join(base, 'data'), XDG_CACHE_HOME: join(base, 'cache'), XDG_STATE_HOME: join(base, 'state'),
    OPENCODE_CONFIG_DIR: join(base, 'config', 'opencode'), OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_CONFIG_CONTENT: '{"$schema":"https://opencode.ai/config.json"}',
  };
  for (const key of ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_PURE', 'OPENCODE_CONFIG', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_TUI_CONFIG']) delete env[key];
  if (process.argv.includes('--manual')) delete env._EXTENSION_OPENCODE_PORT;
  const child = spawn('python3', [join(__dirname, 'tui-driver.py'), 'opencode', '--port', String(port)], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', data => { logs = (logs + data).slice(-100000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-100000); });
  const statePath = join(config, 'ssh-images', `current-${port}.json`);
  async function waitFor(predicate, label) {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (child.exitCode !== null) throw new Error(`TUI exited (${child.exitCode})\n${logs}`);
      try { const state = JSON.parse(await fs.readFile(statePath, 'utf8')); if (predicate(state)) return state; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out: ${label}\n${logs.slice(-1500)}`);
  }
  try {
    const home = await waitFor(state => state.route === 'home', 'TUI plugin home state');
    assert.equal(home.title, '新会话');
    const detected = await processTargets(directory);
    assert.ok(detected.some(target => target.port === port), 'Linux process discovery should find the real CLI port');
    const first = await request(port, '/session', directory, { title: '图片附件测试会话 A' });
    const second = await request(port, '/session', directory, { title: '图片附件测试会话 B' });
    await request(port, '/tui/select-session', directory, { sessionID: first.id });
    await waitFor(state => state.sessionID === first.id && state.title === '图片附件测试会话 A', 'session A');
    const renamed = await fetch(`http://127.0.0.1:${port}/session/${first.id}?directory=${encodeURIComponent(directory)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '图片附件测试会话 A（重命名）' }),
    });
    assert.equal(renamed.status, 200);
    await waitFor(state => state.sessionID === first.id && state.title === '图片附件测试会话 A（重命名）', 'renamed session A');
    await request(port, '/tui/select-session', directory, { sessionID: second.id });
    await waitFor(state => state.sessionID === second.id && state.title === '图片附件测试会话 B', 'session B');
    // Return to home, proving that the displayed name doesn't stick to the last message.
    child.stdin.write('\x18'); // Ctrl+X leader, then N (new session).
    await new Promise(resolve => setTimeout(resolve, 150));
    child.stdin.write('n');
    await waitFor(state => state.route === 'home' && !state.sessionID, 'new session home');
    console.log('PASS: real OpenCode TUI reports session A → renamed A → session B → new session, without model calls.');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
