// Installed as .opencode/plugins/opencode-ssh-images.js. No npm dependencies.
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const VERSION = '0.1.0';
const MAX_BYTES = 20 * 1024 * 1024;
const MARKER = /\[\[oc-image:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\]/g;

function checkImage(record) {
  if (!record || typeof record.dataUrl !== 'string') throw new Error('图片附件数据缺失');
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(record.dataUrl);
  if (!match) throw new Error('图片附件格式无效');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== match[2]) throw new Error('图片附件损坏或超过 20 MiB');
  let mime;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) mime = 'image/gif';
  else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
  if (mime !== match[1] || record.mime !== mime) throw new Error('图片附件 MIME 与实际内容不符');
  return { mime, size: bytes.length };
}

export default async function sshImages({ directory, serverUrl }) {
  const cache = join(directory, '.opencode', 'ssh-images');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const port = new URL(serverUrl).port;
  if (port) await writeFile(join(cache, `ready-${port}.json`), JSON.stringify({ version: VERSION, pid: process.pid, directory }), { mode: 0o600 });

  return {
    'chat.message': async (_input, output) => {
      const ids = new Set();
      for (const part of output.parts) {
        if (part.type !== 'text' || part.synthetic || part.ignored) continue;
        for (const match of part.text.matchAll(MARKER)) ids.add(match[1]);
      }
      if (!ids.size) return;
      if (ids.size > 10) throw new Error('每条消息最多 10 张 SSH 图片附件');
      const files = [];
      let total = 0;
      for (const id of ids) {
        const path = join(cache, `${id}.json`);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > Math.ceil(MAX_BYTES / 3) * 4 + 4096) throw new Error('图片附件缓存无效或过大');
        const record = JSON.parse(await readFile(path, 'utf8'));
        const { mime, size } = checkImage(record);
        total += size;
        if (total > 40 * 1024 * 1024) throw new Error('图片附件总大小超过 40 MiB');
        files.push({
          id: `prt_${Date.now().toString(16)}${randomBytes(12).toString('hex')}`,
          sessionID: output.message.sessionID,
          messageID: output.message.id,
          type: 'file', mime,
          filename: String(record.filename || 'image').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180),
          url: record.dataUrl,
        });
      }
      // Commit only after every attachment is loaded successfully.
      for (const part of output.parts) {
        if (part.type === 'text' && !part.synthetic && !part.ignored) part.text = part.text.replace(MARKER, '');
      }
      output.parts.push(...files);
    },
  };
}
