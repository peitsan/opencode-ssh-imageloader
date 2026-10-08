// Loaded by tui.json, separate from the server chat.message plugin.
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

function cliPort() {
  // The official VS Code terminal passes this env var to the TUI process.
  if (process.env._EXTENSION_OPENCODE_PORT) return Number(process.env._EXTENSION_OPENCODE_PORT);
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--port') return Number(process.argv[i + 1]);
    if (process.argv[i].startsWith('--port=')) return Number(process.argv[i].slice(7));
    if (process.argv[i] === 'attach' && process.argv[i + 1]) {
      try { return Number(new URL(process.argv[i + 1]).port); } catch {}
    }
  }
}

export default {
  id: 'opencode-ssh-images-session',
  tui: async api => {
    const port = cliPort();
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const directory = api.state.path.directory;
    const cache = join(directory, '.opencode', 'ssh-images');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const path = join(cache, `current-${port}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    let writing = false;
    let disposed = false;
    async function publish() {
      if (writing || disposed) return;
      writing = true;
      try {
        const route = api.route.current;
        const sessionID = route.name === 'session' ? route.params?.sessionID : undefined;
        const session = sessionID ? api.state.session.get(sessionID) : undefined;
        const record = {
          version: '0.2.0', pid: process.pid, port, directory,
          sessionID, title: session?.title || (sessionID ? '未命名会话' : '新会话'),
          route: route.name, updatedAt: Date.now(),
        };
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await rename(temporary, path);
      } catch {
        // Session discovery should never interrupt the user's CLI.
      } finally { writing = false; }
    }
    await publish();
    const timer = setInterval(() => { void publish(); }, 500);
    api.lifecycle.onDispose(async () => {
      disposed = true;
      clearInterval(timer);
      // Heartbeat expiry invalidates the record; don't delete another TUI's state.
      await unlink(temporary).catch(() => {});
    });
  },
};
