const vscode = require('vscode');
const { randomUUID, randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { validateBatch, request } = require('./core.cjs');
const { registerTuiPlugin } = require('./tui-config.cjs');
const { createTargets } = require('./targets.cjs');

const BRIDGE = 'opencode-ssh-images.js';
const VERSION = '0.1.0';

function activate(context) {
  let panel;
  let root;
  let connection;
  let busy = false;
  let refreshing = false;
  let timer;
  let lastConnectionState;
  const output = vscode.window.createOutputChannel('OpenCode SSH Images');
  const targets = createTargets(context);
  context.subscriptions.push(output);
  context.subscriptions.push({ dispose() { clearInterval(timer); panel?.dispose(); } });

  async function workspace() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('请先在 Remote-SSH 窗口中打开远端项目文件夹。');
    if (folders.length === 1) return folders[0].uri;
    const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, uri: folder.uri })), { placeHolder: '选择 OpenCode CLI 所在的项目目录' });
    return choice?.uri;
  }

  async function install(uri) {
    async function readOptional(target) {
      try { return await vscode.workspace.fs.readFile(target); }
      catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error; }
    }
    const tui = vscode.Uri.joinPath(uri, '.opencode', 'ssh-images-tui.mjs');
    let configUri = vscode.Uri.joinPath(uri, '.opencode', 'tui.json');
    let configBytes;
    for (const parts of [['.opencode', 'tui.jsonc'], ['.opencode', 'tui.json'], ['tui.jsonc'], ['tui.json']]) {
      const candidate = vscode.Uri.joinPath(uri, ...parts);
      const bytes = await readOptional(candidate);
      if (bytes) { configUri = candidate; configBytes = bytes; break; }
    }
    const configText = configBytes ? Buffer.from(configBytes).toString() : '{}\n';
    const updatedConfig = registerTuiPlugin(configText, pathToFileURL(tui.fsPath).href);
    const files = [
      { target: vscode.Uri.joinPath(uri, '.opencode', 'plugins', BRIDGE), source: 'ssh-images.mjs' },
      { target: tui, source: 'ssh-images-tui.mjs' },
    ];
    const changes = [];
    for (const file of files) {
      const source = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'assets', file.source));
      const existing = await readOptional(file.target);
      if (!existing || !Buffer.from(existing).equals(Buffer.from(source))) changes.push({ ...file, source, existing });
    }
    if (changes.some(file => file.existing)) {
      const choice = await vscode.window.showWarningMessage('图片 CLI 插件有更新，是否更新？原文件将备份。', '更新并备份');
      if (!choice) throw new Error('已取消插件更新。');
    }
    const stamp = Date.now();
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '.opencode', 'plugins'));
    for (const file of changes) {
      if (file.existing) await vscode.workspace.fs.writeFile(file.target.with({ path: `${file.target.path}.${stamp}.bak` }), file.existing);
      await vscode.workspace.fs.writeFile(file.target, file.source);
    }
    if (updatedConfig !== configText) {
      if (configBytes) await vscode.workspace.fs.writeFile(configUri.with({ path: `${configUri.path}.${stamp}.bak` }), configBytes);
      await vscode.workspace.fs.writeFile(configUri, Buffer.from(updatedConfig));
    }
    return changes.length > 0 || updatedConfig !== configText;
  }

  async function publishConnection(count = 0) {
    const message = connection ? {
      type: 'connection', online: connection.online, title: connection.title,
      port: connection.port, terminal: connection.terminal?.name,
      sessionID: connection.session?.sessionID,
      pid: connection.pid,
      directory: root.fsPath, version: connection.health?.version,
      hintKey: !connection.online ? 'targetHint'
        : !connection.session ? 'sessionHint' : '',
    } : {
      type: 'connection', online: false, title: count > 1 ? '请选择目标会话' : '等待 OpenCode CLI',
      titleKey: count > 1 ? 'chooseTarget' : 'waiting',
      hintKey: count > 1 ? 'multipleHint' : 'searchHint',
    };
    const state = JSON.stringify(message);
    if (state !== lastConnectionState) {
      lastConnectionState = state;
      if (panel) panel.title = connection?.session ? `图片附件 · ${connection.title}` : 'OpenCode 图片附件';
      await panel?.webview.postMessage(message);
    }
  }

  async function refresh() {
    if (!panel || busy || refreshing) return;
    refreshing = true;
    const owner = panel;
    try {
      if (connection) {
        const updated = await targets.inspect(root, connection);
        if (owner !== panel || busy) return;
        connection = updated;
        await publishConnection();
      } else {
        const found = await targets.auto(root);
        if (owner !== panel || busy) return;
        connection = found.target;
        await publishConnection(found.count);
      }
    } catch (error) { output.appendLine(error.message); }
    finally { refreshing = false; }
  }

  async function connect() {
    const target = await targets.pick(root, connection);
    if (!target) return false;
    connection = target;
    await publishConnection();
    return true;
  }

  async function requireBridge() {
    let ready;
    try {
      ready = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.opencode', 'ssh-images', `ready-${connection.port}.json`))).toString());
      process.kill(ready.pid, 0);
    } catch {
      throw new Error('CLI 图片插件尚未加载。请退出并重新启动此项目中的 OpenCode CLI，再重试。');
    }
    if (ready.version !== VERSION || ready.directory !== root.fsPath) throw new Error('CLI 图片插件版本或项目目录不匹配。请在选定项目目录中重启 OpenCode CLI。');
  }

  async function attach(message) {
    if (!connection) {
      connection = (await targets.auto(root)).target;
      if (!connection) await connect();
    }
    if (!connection) throw new Error('尚未连接 OpenCode CLI。');
    const checked = await targets.inspect(root, connection);
    connection = checked;
    await publishConnection();
    if (!connection.online) throw new Error('当前目标已离线。请重启该 CLI 或点击“连接 / 切换”选择其他目标。');
    await requireBridge();
    const limit = vscode.workspace.getConfiguration('opencodeSshImages', root).get('maxImageSizeMB', 10) * 1024 * 1024;
    const images = validateBatch(message.images, limit);
    const cache = vscode.Uri.joinPath(root, '.opencode', 'ssh-images');
    await vscode.workspace.fs.createDirectory(cache);
    const saved = [];
    try {
      const markers = [];
      for (const image of images) {
        const id = randomUUID();
        const uri = vscode.Uri.joinPath(cache, `${id}.json`);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(image)));
        saved.push(uri);
        markers.push(`[[oc-image:${id}]]`);
      }
      // Append only: Enter in the CLI remains the user's send action.
      const text = ` ${markers.join(' ')} `;
      const accepted = await request(connection.port, '/tui/append-prompt', root.fsPath, { text }, connection.password);
      if (accepted !== true) throw new Error('OpenCode 未确认追加附件。');
    } catch (error) {
      // The HTTP request may have arrived even if its response was lost.
      // Retain cache so any already-appended markers remain valid.
      output.appendLine(`附件追加失败；缓存保留: ${saved.map(uri => uri.fsPath).join(', ')}`);
      throw error;
    }
    await panel?.webview.postMessage({ type: 'attached', count: images.length });
    connection.terminal?.show(true);
  }

  async function show() {
    if (panel) { panel.reveal(); return; }
    if (busy) throw new Error('上一批图片仍在处理中，请稍后再打开面板。');
    root = await workspace();
    if (!root) return;
    if (await install(root)) await vscode.window.showInformationMessage('图片与会话名称插件已安装。请退出并重启此项目中的 OpenCode CLI；面板会自动连接。');
    connection = undefined;
    lastConnectionState = undefined;
    panel = vscode.window.createWebviewPanel('opencodeSshImages', 'OpenCode 图片附件', vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    const nonce = randomBytes(18).toString('base64');
    const template = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.html'))).toString();
    panel.webview.html = template.replaceAll('{{nonce}}', nonce)
      .replaceAll('{{cspSource}}', panel.webview.cspSource)
      .replace('{{script}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.js')).toString())
      .replace('{{style}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.css')).toString());
    panel.onDidDispose(() => { clearInterval(timer); panel = undefined; connection = undefined; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async message => {
      if (!message) return;
      if (message.type === 'ready') { lastConnectionState = undefined; await refresh(); return; }
      if (message.type === 'refresh') { await refresh(); return; }
      if (message.type === 'focusTerminal') { connection?.terminal?.show(); return; }
      if (busy || !['connect', 'attach'].includes(message.type)) return;
      busy = true;
      try {
        if (message.type === 'connect') {
          const changed = await connect();
          await panel?.webview.postMessage(changed ? { type: 'notice', connected: connection.title } : { type: 'notice', cancelled: true });
        }
        else await attach(message);
      } catch (error) {
        output.appendLine(error.stack || error.message);
        await panel?.webview.postMessage({ type: 'error', text: error.message });
      } finally {
        busy = false;
        await panel?.webview.postMessage({ type: 'idle' });
      }
    }, null, context.subscriptions);
    timer = setInterval(() => { void refresh(); }, 2000);
  }

  function command(name, fn) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      try { await fn(); } catch (error) { output.appendLine(error.stack || error.message); await vscode.window.showErrorMessage(error.message); }
    }));
  }
  command('opencodeSshImages.open', show);
  command('opencodeSshImages.installBridge', async () => {
    const uri = await workspace();
    if (!uri) return;
    const changed = await install(uri);
    await vscode.window.showInformationMessage(changed ? '图片 CLI 插件已安装/更新。请退出并重新启动 OpenCode CLI。' : 'CLI 插件已是当前版本。若尚未加载，请重启 OpenCode CLI。');
  });
}

module.exports = { activate };
