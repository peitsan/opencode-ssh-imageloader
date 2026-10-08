const http = require('node:http');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_IMAGES = 10;

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && /GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('只支持 PNG、JPEG、GIF、WebP 图片。图片内容与格式必须匹配。');
}

function validateImage(image, limit = MAX_BYTES) {
  if (!image || typeof image.dataUrl !== 'string' || image.dataUrl.length > Math.ceil(limit / 3) * 4 + 100) {
    throw new Error('图片缺失或超过大小限制。');
  }
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match) throw new Error('无效的图片数据。');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== match[2]) throw new Error('图片超限或 Base64 数据损坏。');
  const mime = imageMime(bytes);
  if (mime !== match[1]) throw new Error('图片 MIME 与实际内容不符。');
  const filename = String(image.name || 'image').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'image';
  return { filename, mime, dataUrl: image.dataUrl, size: bytes.length };
}

function validateBatch(images, limit) {
  if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES) throw new Error(`请选择 1–${MAX_IMAGES} 张图片。`);
  const result = images.map(image => validateImage(image, limit));
  if (result.reduce((sum, image) => sum + image.size, 0) > MAX_TOTAL_BYTES) throw new Error('图片总大小不能超过 40 MiB。');
  return result;
}

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数。');
  return port;
}

// Always runs in the workspace extension host, so loopback is the SSH server.
function request(port, route, directory, body, auth, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://127.0.0.1:${validPort(port)}${route}`);
    if (directory) url.searchParams.set('directory', directory);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = `Basic ${Buffer.from(`opencode:${auth}`).toString('base64')}`;
    const req = http.request(url, { method: payload === undefined ? 'GET' : 'POST', headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 1024 * 1024) req.destroy(new Error('OpenCode 响应过大。'));
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = Object.assign(new Error(`OpenCode ${route} HTTP ${res.statusCode}: ${data.slice(0, 300)}`), { status: res.statusCode });
          reject(error);
          return;
        }
        try { resolve(JSON.parse(data)); } catch { reject(new Error('OpenCode 返回的不是 JSON。请检查端口。')); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('连接远端 OpenCode 超时。')));
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = { MAX_BYTES, MAX_IMAGES, MAX_TOTAL_BYTES, imageMime, validateImage, validateBatch, validPort, request };
