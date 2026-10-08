const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { validateImage, validateBatch, validPort, request } = require('../src/core.cjs');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AdMOEQH6QSAM1BAQ/oQeJvAAAAAElFTkSuQmCC';

test('validate byte signature, canonical base64, filenames and size', () => {
  assert.equal(validateImage({ dataUrl: PNG, name: '../../截图.png' }).filename, '截图.png');
  assert.throws(() => validateImage({ dataUrl: PNG.replace('image/png', 'image/jpeg') }), /MIME/);
  assert.throws(() => validateImage({ dataUrl: 'data:image/png;base64,aGVsbG8=' }), /格式/);
  assert.throws(() => validateImage({ dataUrl: PNG }, 8), /限制|超限/);
  assert.throws(() => validateImage({ dataUrl: `${PNG}===` }), /数据/);
  assert.throws(() => validateBatch(Array(11).fill({ dataUrl: PNG })), /1–10/);
  assert.throws(() => validateBatch([]), /1–10/);
  assert.throws(() => validPort('4096; rm -rf /'), /端口/);
  assert.throws(() => validPort(65536), /端口/);
});

test('HTTP appends JSON on loopback with correctly encoded workspace and password', async t => {
  const directory = '/tmp/项目 with spaces/#?';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('directory'), directory);
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('opencode:secret').toString('base64')}`);
    assert.equal(req.method, 'POST');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { text: ' [[oc-image:example]] ' });
      res.end('true');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(await request(server.address().port, '/tui/append-prompt', directory, { text: ' [[oc-image:example]] ' }, 'secret'), true);
});

test('HTTP errors are propagated instead of reporting successful attachment', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end('Unauthorized'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(request(server.address().port, '/global/health'), error => error.status === 401);
});

module.exports = { PNG };
