// Real OpenCode server integration. noReply avoids model generation/API costs.
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');
const { request } = require('../src/core.cjs');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC';

async function main() {
  const base = await fs.mkdtemp(join(tmpdir(), 'oc-ssh-live-'));
  const directory = join(base, 'workspace');
  const plugins = join(directory, '.opencode', 'plugins');
  await fs.mkdir(plugins, { recursive: true });
  await fs.copyFile(join(__dirname, '..', 'assets', 'ssh-images.mjs'), join(plugins, 'opencode-ssh-images.js'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env,
    XDG_CONFIG_HOME: join(base, 'config'), XDG_DATA_HOME: join(base, 'data'), XDG_CACHE_HOME: join(base, 'cache'), XDG_STATE_HOME: join(base, 'state'),
    OPENCODE_CONFIG_DIR: join(base, 'config', 'opencode'),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'test/vision', provider: { test: { npm: '@ai-sdk/openai-compatible', name: 'Test', options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'unused' }, models: { vision: { name: 'Test Vision', attachment: true, modalities: { input: ['text', 'image'], output: ['text'] } } } } } }),
  };
  for (const key of ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_PURE', 'OPENCODE_CONFIG', 'OPENCODE_DISABLE_PROJECT_CONFIG']) delete env[key];
  let logs = '';
  const child = spawn('opencode', ['serve', '--print-logs', '--log-level', 'DEBUG', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  try {
    let started = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`OpenCode exited: ${child.exitCode}\n${logs}`);
      try { started = (await request(port, '/global/health', directory)).healthy; } catch {}
      if (started) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(started, `Server did not start:\n${logs}`);
    const session = await request(port, '/session', directory, { title: 'SSH attachment integration test' });
    const cache = join(directory, '.opencode', 'ssh-images');
    const ready = JSON.parse(await fs.readFile(join(cache, `ready-${port}.json`), 'utf8'));
    assert.equal(ready.version, '0.1.0');
    const id = randomUUID();
    await fs.writeFile(join(cache, `${id}.json`), JSON.stringify({ filename: 'live.png', mime: 'image/png', dataUrl: PNG }));
    const result = await request(port, `/session/${session.id}/message`, directory, {
      noReply: true, model: { providerID: 'test', modelID: 'vision' },
      parts: [{ type: 'text', text: `Inspect this screenshot [[oc-image:${id}]]` }],
    });
    assert.ok(result.info?.id, `Unexpected message response: ${JSON.stringify(result)}`);
    const messages = await request(port, `/session/${session.id}/message`, directory);
    const user = messages.find(message => message.info.role === 'user');
    assert.ok(user, 'User message not persisted');
    const file = user.parts.find(part => part.type === 'file');
    assert.equal(file?.mime, 'image/png');
    assert.equal(file?.url, PNG);
    assert.equal(file?.filename, 'live.png');
    assert.ok(!user.parts.find(part => part.type === 'text').text.includes('oc-image:'));
    console.log(`PASS: real OpenCode persisted a PNG file attachment (port ${port}, noReply=true).`);
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && !spawnError) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
