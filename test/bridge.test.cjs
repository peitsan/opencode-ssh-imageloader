const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC';

async function setup(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'oc-ssh-hook-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const factory = (await import('../assets/ssh-images.mjs')).default;
  const hooks = await factory({ directory, serverUrl: new URL('http://localhost:4096') });
  const id = randomUUID();
  const cache = join(directory, '.opencode', 'ssh-images');
  await fs.writeFile(join(cache, `${id}.json`), JSON.stringify({ filename: '截图.png', mime: 'image/png', dataUrl: PNG }));
  return { hooks, id, directory, cache };
}

test('converts markers into persisted multimodal file parts and deduplicates', async t => {
  const { hooks, id, cache } = await setup(t);
  const ready = JSON.parse(await fs.readFile(join(cache, 'ready-4096.json')));
  assert.equal(ready.pid, process.pid);
  const output = {
    message: { id: 'msg_abc', sessionID: 'ses_abc' },
    parts: [{ type: 'text', text: `分析截图 [[oc-image:${id}]] [[oc-image:${id}]]` }],
  };
  await hooks['chat.message']({}, output);
  assert.equal(output.parts.length, 2);
  assert.equal(output.parts[0].text, '分析截图  ');
  assert.deepEqual({ ...output.parts[1], id: undefined }, {
    id: undefined, sessionID: 'ses_abc', messageID: 'msg_abc', type: 'file', mime: 'image/png', filename: '截图.png', url: PNG,
  });
  await hooks['chat.message']({}, output);
  assert.equal(output.parts.length, 2);
});

test('missing image fails atomically instead of stripping markers or sending plain text', async t => {
  const { hooks, id } = await setup(t);
  const output = { message: { id: 'msg_a', sessionID: 'ses_a' }, parts: [{ type: 'text', text: `[[oc-image:${id}]] [[oc-image:${randomUUID()}]]` }] };
  const before = structuredClone(output);
  await assert.rejects(hooks['chat.message']({}, output), /ENOENT/);
  assert.deepEqual(output, before);
});

test('ignores synthetic text and never resolves arbitrary file paths', async t => {
  const { hooks, id } = await setup(t);
  const output = { message: {}, parts: [
    { type: 'text', text: `[[oc-image:${id}]]`, synthetic: true },
    { type: 'text', text: '[[oc-image:../../etc/passwd]]' },
  ] };
  const before = structuredClone(output);
  await hooks['chat.message']({}, output);
  assert.deepEqual(output, before);
});

test('rejects symlink cache and MIME substitution', async t => {
  const { hooks, id, cache } = await setup(t);
  const path = join(cache, `${id}.json`);
  const output = { message: {}, parts: [{ type: 'text', text: `[[oc-image:${id}]]` }] };
  await fs.writeFile(path, JSON.stringify({ filename: 'x', mime: 'image/jpeg', dataUrl: PNG }));
  await assert.rejects(hooks['chat.message']({}, output), /MIME/);
  await fs.rename(path, `${path}.real`);
  await fs.symlink(`${path}.real`, path);
  await assert.rejects(hooks['chat.message']({}, output), /缓存/);
});
