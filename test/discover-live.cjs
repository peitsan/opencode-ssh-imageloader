// Exercise discovery without any VS Code terminal metadata or remembered port.
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const assert = require('node:assert/strict');

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node test/discover-live.cjs <project-directory> [expected-port]');
  const file = join(__dirname, '..', 'src', 'targets.cjs');
  const vscode = {
    Uri: { joinPath: (root, ...parts) => ({ fsPath: join(root.fsPath, ...parts) }) },
    window: { terminals: [] },
    workspace: {
      getConfiguration: () => ({ get: (_name, fallback) => fallback }),
      fs: {
        readFile: uri => fs.readFile(uri.fsPath),
        readDirectory: async uri => (await fs.readdir(uri.fsPath)).map(name => [name, 1]),
      },
    },
  };
  const sandbox = { module: { exports: {} }, process, Buffer, require: name => name === 'vscode' ? vscode : createRequire(file)(name) };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), sandbox, { filename: file });
  const manager = sandbox.module.exports.createTargets({});
  const targets = await manager.discover({ fsPath: directory });
  console.table(targets.map(target => ({ port: target.port, pid: target.pid, source: target.source, online: target.online, title: target.title })));
  if (process.argv[3]) assert.ok(targets.some(target => target.port === Number(process.argv[3]) && target.online), 'Expected CLI port was not discovered');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
