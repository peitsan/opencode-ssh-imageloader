const vscode = require('vscode');
const { request, validPort } = require('./core.cjs');
const { processTargets, isHeadless, ownsListeningPort } = require('./process-discovery.cjs');

function terminalPort(terminal) {
  try { return validPort(terminal?.creationOptions?.env?._EXTENSION_OPENCODE_PORT); } catch { return undefined; }
}

function createTargets(context) {
  const passwords = new Map();
  function key(root) { return `sshImages.target:${root.fsPath}`; }
  function remembered(root) { return context.workspaceState?.get(key(root)); }
  let processCache;
  async function processes(root) {
    if (!processCache || processCache.directory !== root.fsPath || Date.now() - processCache.time > 5000) {
      processCache = { directory: root.fsPath, time: Date.now(), targets: await processTargets(root.fsPath) };
    }
    return processCache.targets;
  }
  async function readSession(root, port) {
    try {
      const uri = vscode.Uri.joinPath(root, '.opencode', 'ssh-images', `current-${port}.json`);
      const record = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString());
      if (record.directory !== root.fsPath || record.port !== port || record.updatedAt > Date.now() + 2000 || Date.now() - record.updatedAt > 5000) return;
      process.kill(record.pid, 0);
      return record;
    } catch { return undefined; }
  }

  async function inspect(root, candidate) {
    const session = await readSession(root, candidate.port);
    const password = passwords.get(candidate.port);
    let health;
    let error;
    try { health = await request(candidate.port, '/global/health', root.fsPath, undefined, password, 1500); }
    catch (failure) { error = failure; }
    return { ...candidate, password, session, health, error,
      online: health?.healthy === true,
      title: session?.title || '会话待识别',
    };
  }

  async function readReady(root, port) {
    try {
      const uri = vscode.Uri.joinPath(root, '.opencode', 'ssh-images', `ready-${port}.json`);
      const record = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString());
      if (record.directory !== root.fsPath || !Number.isInteger(record.pid) || record.pid < 1) return;
      process.kill(record.pid, 0);
      if (await isHeadless(record.pid)) return;
      if (!await ownsListeningPort(record.pid, port)) return;
      return record;
    } catch { return undefined; }
  }

  async function discover(root, current) {
    const candidates = new Map();
    function add(port, terminal, extra = {}) {
      try {
        port = validPort(port);
        const prior = candidates.get(port);
        candidates.set(port, { ...prior, ...extra, port, terminal: terminal || prior?.terminal });
      } catch {}
    }
    const setting = vscode.workspace.getConfiguration('opencodeSshImages', root).get('port', 0);
    if (setting) add(setting);
    if (remembered(root)?.port) add(remembered(root).port);
    if (current) add(current.port, current.terminal);
    for (const terminal of vscode.window.terminals) add(terminalPort(terminal), terminal);
    for (const target of await processes(root)) add(target.port, undefined, target);
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, '.opencode', 'ssh-images'));
      for (const [name] of entries) {
        const match = /^(current|ready)-(\d+)\.json$/.exec(name);
        if (!match) continue;
        const port = Number(match[2]);
        const record = match[1] === 'current' ? await readSession(root, port) : await readReady(root, port);
        if (record) add(port, undefined, { pid: record.pid, source: match[1] });
      }
    } catch {}
    return Promise.all([...candidates.values()].map(candidate => inspect(root, candidate)));
  }

  async function authorize(root, candidate) {
    let target = await inspect(root, candidate);
    if (target.error?.status === 401) {
      const password = await vscode.window.showInputBox({ prompt: 'OpenCode 服务密码 (OPENCODE_SERVER_PASSWORD)', password: true, ignoreFocusOut: true });
      if (password === undefined) return;
      const prior = passwords.get(target.port);
      passwords.set(target.port, password);
      target = await inspect(root, candidate);
      if (!target.online) {
        if (prior === undefined) passwords.delete(target.port);
        else passwords.set(target.port, prior);
      }
    }
    if (!target.online) throw target.error || new Error('目标端口不是健康的 OpenCode 服务。');
    await context.workspaceState?.update(key(root), { port: target.port });
    return target;
  }

  async function auto(root) {
    const targets = (await discover(root)).filter(target => target.online);
    const setting = vscode.workspace.getConfiguration('opencodeSshImages', root).get('port', 0);
    const saved = remembered(root)?.port;
    const active = terminalPort(vscode.window.activeTerminal);
    const target = targets.find(target => target.port === setting)
      || targets.find(target => target.port === saved)
      || targets.find(target => target.port === active)
      || (targets.length === 1 ? targets[0] : undefined);
    if (target) await context.workspaceState?.update(key(root), { port: target.port });
    return { target, count: targets.length };
  }

  async function pick(root, current) {
    const targets = await discover(root, current);
    const items = targets.map(target => ({
      label: `${target.port === current?.port ? '$(check) ' : ''}${target.title}`,
      description: `${target.terminal?.name || (target.pid ? `服务器 CLI (PID ${target.pid})` : '手动 CLI')} · :${target.port}${target.online ? '' : target.error?.status === 401 ? ' · 需要密码' : ' · 离线'}`,
      detail: target.session ? `${target.session.sessionID || '首页 / 新会话'} · ${root.fsPath}` : '尚未获取当前会话名称，升级后请重启 OpenCode CLI',
      target,
    }));
    items.sort((a, b) => Number(b.target.port === current?.port) - Number(a.target.port === current?.port));
    const choice = await vscode.window.showQuickPick([...items, { label: '$(add) 输入其他端口…', description: '手动连接远端 OpenCode CLI', target: undefined }], {
      title: '切换 OpenCode 图片接收目标', placeHolder: '按 session 名称或端口搜索', matchOnDescription: true, matchOnDetail: true,
    });
    if (!choice) return;
    if (choice.target) return authorize(root, choice.target);
    const value = await vscode.window.showInputBox({ prompt: '远端 OpenCode CLI 端口', value: String(current?.port || remembered(root)?.port || 4096), validateInput: value => { try { validPort(value); } catch (error) { return error.message; } } });
    if (value === undefined) return;
    const port = validPort(value);
    return authorize(root, { port, terminal: vscode.window.terminals.find(terminal => terminalPort(terminal) === port) });
  }

  return { auto, pick, inspect, readSession, discover };
}

module.exports = { createTargets, terminalPort };
