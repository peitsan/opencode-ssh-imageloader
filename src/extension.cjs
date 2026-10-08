const vscode = require('vscode');
const { randomUUID, randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { validateBatch, request } = require('./core.cjs');
const { registerTuiPlugin } = require('./tui-config.cjs');
const { createTargets } = require('./targets.cjs');
const { createI18n } = require('./i18n.cjs');

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
  const t = createI18n(vscode.env?.language);
  const targets = createTargets(context, t);
  context.subscriptions.push(output);
  context.subscriptions.push({ dispose() { clearInterval(timer); panel?.dispose(); } });

  async function workspace() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error(t('workspaceRequired'));
    if (folders.length === 1) return folders[0].uri;
    const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, uri: folder.uri })), { placeHolder: t('chooseWorkspace') });
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
      const choice = await vscode.window.showWarningMessage(t('updatePrompt'), t('update'));
      if (!choice) throw new Error(t('updateCancelled'));
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
      type: 'connection', online: false, title: count > 1 ? t('targetChoose') : t('targetWaiting'),
      titleKey: count > 1 ? 'chooseTarget' : 'waiting',
      hintKey: count > 1 ? 'multipleHint' : 'searchHint',
    };
    const state = JSON.stringify(message);
    if (state !== lastConnectionState) {
      lastConnectionState = state;
      if (panel) panel.title = connection?.session ? t('sessionPanelTitle', connection.title) : t('panelTitle');
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
      throw new Error(t('bridgeMissing'));
    }
    if (ready.version !== VERSION || ready.directory !== root.fsPath) throw new Error(t('bridgeMismatch'));
  }

  async function attach(message) {
    if (!connection) {
      connection = (await targets.auto(root)).target;
      if (!connection) await connect();
    }
    if (!connection) throw new Error(t('notConnected'));
    const checked = await targets.inspect(root, connection);
    connection = checked;
    await publishConnection();
    if (!connection.online) throw new Error(t('targetOffline'));
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
      if (accepted !== true) throw new Error(t('appendNotConfirmed'));
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
    if (busy) throw new Error(t('stillBusy'));
    root = await workspace();
    if (!root) return;
    if (await install(root)) await vscode.window.showInformationMessage(t('installed'));
    connection = undefined;
    lastConnectionState = undefined;
    panel = vscode.window.createWebviewPanel('opencodeSshImages', t('panelTitle'), vscode.ViewColumn.Beside, {
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
    await vscode.window.showInformationMessage(changed ? t('installedBridge') : t('currentBridge'));
  });
}

module.exports = { activate };
