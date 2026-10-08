/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
let images = [];
let busy = false;
let reading = false;
let target;
const locale = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
const messages = {
  en: {
    title: 'OpenCode Image Attachments', subtitle: 'Local images through VS Code SSH to your remote CLI.', badge: 'Image input', restartHint: 'Restart OpenCode CLI after the first install or an update.', connect: 'Connect / switch', showTerminal: 'Show target terminal', refresh: 'Refresh', dropTitle: 'Click here, then press Ctrl+V / ⌘V to paste a screenshot', dropBody: 'Drop local images here, or choose files below.', chooseImages: 'Choose local images', limits: 'PNG / JPEG / GIF / WebP · up to 10 images · 40 MiB total.', attach: 'Add to CLI input', clear: 'Clear selected images', sendHint: 'After adding, continue typing in the CLI and press Enter to send. Your model must support image input.', remove: 'Remove', selected: count => `${count} image${count === 1 ? '' : 's'} selected. Click “Add to CLI input” to upload.`, cleared: 'Selection cleared.', connecting: 'Connecting to remote OpenCode…', uploading: 'Uploading through SSH and adding attachments…', attached: count => `${count} image${count === 1 ? '' : 's'} added. Type your question in the CLI and press Enter to send.`, connected: title => `Connected: ${title}`, cancelled: 'Switch cancelled; current target kept.', invalidType: name => `${name || 'This file'} is not a supported image format.`, tooMany: 'You can add up to 10 images.', tooLarge: name => `${name} is larger than 20 MiB.`, totalTooLarge: 'Total image size exceeds 40 MiB.', readFailed: 'Could not read the local image.', connectedState: 'Connected', offlineState: 'Offline', serverCli: pid => `Server CLI (PID ${pid})`, manualCli: 'Manual CLI', connectButton: 'Connect / switch', switchButton: 'Switch session / terminal', looking: 'Looking for OpenCode CLI…', chooseTarget: 'Choose a target session', waiting: 'Waiting for OpenCode CLI', targetHint: 'The target is offline. Waiting to reconnect; you can also switch targets manually.', sessionHint: 'CLI port found; session name is not synced yet. Restart CLI to load the session plugin.', multipleHint: 'Multiple terminals detected. Click “Connect / switch” to choose one.', searchHint: 'Looking for the current project CLI listening port. You can also enter a port manually.'
  },
  zh: {
    title: 'OpenCode 图片附件', subtitle: '通过 VS Code SSH 通道，将本地图片发送到远端 CLI。', badge: '图片输入', restartHint: '首次安装或更新后，请重启 OpenCode CLI。', connect: '连接 / 切换', showTerminal: '显示目标终端', refresh: '刷新', dropTitle: '点击此处，然后按 Ctrl+V / ⌘V 粘贴截图', dropBody: '也可将本地图片拖入，或使用下方按钮选择。', chooseImages: '选择本地图片', limits: '支持 PNG / JPEG / GIF / WebP · 最多 10 张 · 总大小 40 MiB。', attach: '添加到 CLI 输入', clear: '清空待添加图片', sendHint: '添加后在 CLI 中继续输入问题，按 Enter 发送。模型需支持图片输入。', remove: '移除', selected: count => `已选择 ${count} 张图片，点击“添加到 CLI 输入”上传。`, cleared: '已清空。', connecting: '正在连接远端 OpenCode…', uploading: '正在通过 SSH 上传并追加附件…', attached: count => `已添加 ${count} 张图片。请在 CLI 中输入问题并按 Enter 发送。`, connected: title => `已连接：${title}`, cancelled: '已取消切换，保留当前目标。', invalidType: name => `不支持 ${name || '此文件'} 的图片格式。`, tooMany: '最多添加 10 张图片。', tooLarge: name => `${name} 超过 20 MiB。`, totalTooLarge: '图片总大小超过 40 MiB。', readFailed: '读取本地图片失败。', connectedState: '已连接', offlineState: '离线', serverCli: pid => `服务器 CLI (PID ${pid})`, manualCli: '手动 CLI', connectButton: '连接 / 切换', switchButton: '切换会话 / 终端', looking: '正在寻找 OpenCode CLI…', chooseTarget: '请选择目标会话', waiting: '等待 OpenCode CLI', targetHint: '目标已离线，正在等待重新连接；也可手动切换目标。', sessionHint: '已找到 CLI 端口；会话名称尚未同步，请退出并重启 CLI 加载会话插件。', multipleHint: '检测到多个终端，请点击“连接 / 切换”选择。', searchHint: '正在寻找当前项目 CLI 的监听端口。也可点击“连接 / 切换”手动输入端口。'
  }
};
const text = messages[locale];
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = text[element.dataset.i18n]; });

function status(text) { byId('status').textContent = text; }
function render() {
  byId('previews').replaceChildren();
  for (const [index, image] of images.entries()) {
    const card = document.createElement('div');
    card.className = 'card';
    const preview = document.createElement('img');
    preview.src = image.dataUrl;
    preview.alt = image.name;
    const label = document.createElement('span');
    label.textContent = `${image.name} (${(image.size / 1024).toFixed(0)} KiB)`;
    const remove = document.createElement('button');
    remove.textContent = text.remove;
    remove.disabled = busy || reading;
    remove.addEventListener('click', () => { images.splice(index, 1); render(); });
    card.append(preview, label, remove);
    byId('previews').append(card);
  }
  byId('attach').disabled = busy || reading || !images.length;
  byId('clear').disabled = busy || reading || !images.length;
  byId('connect').disabled = busy || reading;
  byId('refresh').disabled = busy;
  byId('focusTerminal').disabled = !target?.terminal;
  byId('files').disabled = busy || reading;
}

async function addFiles(files) {
  if (busy || reading) return;
  reading = true;
  render();
  try {
    for (const file of files) {
      if (images.length >= 10) throw new Error(text.tooMany);
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) throw new Error(text.invalidType(file.name));
      if (file.size > 20 * 1024 * 1024) throw new Error(text.tooLarge(file.name));
      if (images.reduce((total, image) => total + image.size, 0) + file.size > 40 * 1024 * 1024) throw new Error(text.totalTooLarge);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(text.readFailed));
        reader.readAsDataURL(file);
      });
      images.push({ name: file.name || `screenshot-${Date.now()}.png`, dataUrl, size: file.size });
    }
    status(text.selected(images.length));
  } catch (error) { status(error.message); }
  finally { reading = false; render(); }
}

byId('files').addEventListener('change', async event => {
  await addFiles(Array.from(event.target.files || []));
  event.target.value = '';
});
document.addEventListener('paste', event => {
  const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); void addFiles(files); }
});
document.addEventListener('dragover', event => { event.preventDefault(); });
document.addEventListener('drop', event => { event.preventDefault(); void addFiles(Array.from(event.dataTransfer?.files || [])); });
byId('clear').addEventListener('click', () => { images = []; render(); status(text.cleared); });
byId('connect').addEventListener('click', () => { busy = true; render(); status(text.connecting); vscode.postMessage({ type: 'connect' }); });
byId('focusTerminal').addEventListener('click', () => vscode.postMessage({ type: 'focusTerminal' }));
byId('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
byId('attach').addEventListener('click', () => { busy = true; render(); status(text.uploading); vscode.postMessage({ type: 'attach', images }); });
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'connection') {
    target = message;
    byId('sessionTitle').textContent = message.title;
    byId('indicator').classList.toggle('online', message.online);
    byId('connectionDetail').textContent = message.port ? `${message.online ? text.connectedState : text.offlineState} · ${message.terminal || (message.pid ? text.serverCli(message.pid) : text.manualCli)} · :${message.port}${message.sessionID ? ` · ${message.sessionID}` : ''}` : '';
    byId('connectionDetail').title = message.directory || '';
    byId('connectionHint').textContent = message.hint || '';
    byId('connect').textContent = message.online ? text.switchButton : text.connectButton;
  }
  if (message.type === 'attached') { images = []; status(text.attached(message.count)); }
  if (message.type === 'error') status(message.text);
  if (message.type === 'notice') status(message.connected ? text.connected(message.connected) : message.cancelled ? text.cancelled : message.text);
  if (message.type === 'connection') {
    byId('sessionTitle').textContent = message.titleKey === 'chooseTarget' ? text.chooseTarget : message.titleKey === 'waiting' ? text.waiting : message.title;
    byId('connectionHint').textContent = message.hintKey ? text[message.hintKey] : message.hint || '';
  }
  if (message.type === 'idle') busy = false;
  render();
});
render();
vscode.postMessage({ type: 'ready' });
