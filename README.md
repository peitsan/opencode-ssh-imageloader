# OpenCode SSH Images

为 **VS Code Remote-SSH + OpenCode CLI** 提供本地截图粘贴、本地图片选择和拖拽上传。使用 VS Code 自带的 SSH 扩展通信通道，不需要额外 SSH 密码、scp、开放公网端口或本地剪贴板命令。

## 安装与使用

1. 在 VS Code 中连接 Remote-SSH，打开运行 OpenCode 的远端项目文件夹。
2. 命令面板执行 **Extensions: Install from VSIX… / 扩展: 从 VSIX 安装…**，选择 `opencode-ssh-images-0.2.1.vsix`。确认扩展安装在 **SSH 远端**，必要时选择“Install in SSH…”并重新加载窗口。
3. 执行 **OpenCode: 添加本地图片附件 (SSH)**，或按 `Ctrl+Alt+I`（macOS：`Cmd+Alt+I`）。面板首次打开时会安装项目级 CLI 插件。
4. **退出并重新启动 OpenCode CLI**，使它加载新插件。在官方 `sst-dev.opencode` 扩展中打开 CLI 即可自动检测端口；手动启动可使用 `opencode --port 4096`。
5. 面板自动发现并连接 CLI，显示**当前 session 的名称**。需要更换时点击“切换会话 / 终端”，按会话名称搜索并选择；手动端口通过“输入其他端口…”连接。CLI 必须运行在所选项目目录。
6. 点击粘贴区域后按 `Ctrl+V` / `Cmd+V` 粘贴本地截图，也可拖入本地图片或点击“选择本地图片”。文件选择器在本地 Webview 浏览器中运行，因此选择的是本地电脑文件。
7. 点击“添加到 CLI 输入”，然后在 CLI 中输入问题、按 Enter 发送。CLI 输入中会出现 `[[oc-image:…]]` 标记；消息发送时插件将其转换成真正的 `type: "file"`、`mime: "image/…"` 附件，并去掉标记。

支持 PNG、JPEG、GIF、WebP。单张默认 10 MiB（可配置为 1–20 MiB），每次最多 10 张、总大小 40 MiB。所选模型需支持图片输入。

## 语言与界面

面板会根据 VS Code / 系统语言在简体中文和 English 之间切换，并适配 VS Code 的亮色、暗色、高对比度主题以及窄面板宽度。扩展命令和设置也使用 VS Code 标准本地化机制。

英文用户流程见 [USER_GUIDE.md](USER_GUIDE.md)，贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 0.2.1：补充远端端口发现

端口发现不再依赖当前 VS Code 窗口保存的终端对象或会话名称插件。额外读取当前项目图片插件的 `ready-<port>.json`，并在 Linux 中匹配当前用户、当前项目的 OpenCode 进程及其真实 TCP LISTEN socket。支持旧 CLI、窗口重载后丢失终端元数据、tmux 和随机监听端口。只检查已识别 OpenCode 进程拥有的 socket，再验证 `/global/health`，不扫描任意端口；Linux 进程检查每 5 秒最多执行一次。

无终端元数据时列表显示“服务器 CLI (PID …)”与端口；会话名称未同步仍可连接和传图。若只想修复端口发现，安装 0.2.1 并重新加载 VS Code 即可，无需为此重启 CLI。名称同步仍需先安装 TUI 插件并重启 CLI。仅提供 API 的 `serve/web/run/acp` 进程不参与自动进程发现。

## 0.2.0：连接与会话名称

- 打开面板自动连接：优先使用设置端口、上次选择的目标、当前活动的官方 CLI 终端；只有一个在线目标时直接连接。多个目标无法确定时等待选择。
- 顶部连接卡片以 session 名称为标题，附带状态、端口和 session ID；面板标签页也显示会话名称。
- 切换列表以当前会话名称区分终端，支持搜索，勾选当前目标。取消切换保留原连接和待上传图片。
- 每 2 秒刷新连接状态及名称；在 CLI 中切换、重命名会话会同步更新；首页显示“新会话”。离线时保留目标并尝试重连，不自动把待上传图片转到其他终端。
- “显示目标终端”一键回到对应的官方扩展终端。
- 会话名称由一个独立的 TUI 插件读取 `api.route.current` 和 `api.state.session.get()`，而不是从服务器会话列表中猜最近使用的名称。

**从 0.1.0 升级：**安装新版 VSIX，重新加载 VS Code 窗口，打开图片面板使它安装会话名称插件，然后退出并重启 CLI。可使用 OpenCode 的 `--continue` 或 `/sessions` 返回原会话。

## 工作原理

```text
本地 VS Code Webview 的 File / Clipboard API
  → webview.postMessage（VS Code Remote-SSH 通道）
  → 远端 workspace 扩展宿主
  → 项目 .opencode/ssh-images/<UUID>.json
  → 127.0.0.1:<CLI port>/tui/append-prompt 追加图片标记
  → CLI 插件 chat.message hook 转换为内嵌 Base64 图片附件
```

HTTP 只访问远端回环地址，传递的是标记。图片内容通过现有 SSH 通道进入远端，作为 Data URL 加入 OpenCode 消息。扩展仅追加输入，用户按 Enter 才会发送。官方扩展目前的 `/tui/append-prompt` 接口只接受文本，因此需要 CLI hook 完成附件转换。

这是官方 **CLI 终端扩展的伴随扩展**。它有自己的图片上传面板；不会向第三方 `OpenCode GUI` 扩展的聊天框注入附件。纯 SSH 终端、没有 VS Code Remote-SSH 的场景不在此扩展的接入范围内。

## 配置

```json
{
  "opencodeSshImages.port": 0,
  "opencodeSshImages.maxImageSizeMB": 10
}
```

- `port: 0`：发现官方扩展终端及当前项目会话插件发布的端口。手动目标也可在切换列表中输入端口。非零值指定自动连接的优先端口，仍可在列表中切换。
- 若服务启用了 `OPENCODE_SERVER_PASSWORD`，连接时弹出密码输入框，使用默认用户名 `opencode`；密码仅保存在当前面板会话内存中。
- 多根工作区在打开面板时选择对应项目。CLI 的当前目录需要与这个目录相同。

## 生成文件与清理

首次打开面板时安装 `.opencode/plugins/opencode-ssh-images.js` 和 `.opencode/ssh-images-tui.mjs`，也可使用 **OpenCode: 安装/更新图片附件 CLI 插件**。已存在且不同的同名插件会先询问并备份，更新后需重启 CLI。

会话插件注册在项目 TUI 配置的 `plugin` 数组。优先沿用 `.opencode/tui.jsonc`、`.opencode/tui.json`，再查项目根目录中的 TUI 配置；没有时创建 `.opencode/tui.json`。使用 JSONC 局部编辑保留注释、主题、按键和已有插件，修改原有配置前会备份。配置项依据官方 <https://opencode.ai/tui.json> schema。若使用 `OPENCODE_TUI_CONFIG` 自定义配置路径，需要把同一插件的文件 URL 加入该自定义配置的 `plugin` 数组。

图片缓存和插件加载状态存储在 `.opencode/ssh-images/`。可在项目 `.gitignore` 中加入：

```gitignore
.opencode/ssh-images/
```

缓存会保留，以支持同一标记重新发送或编辑消息；确认没有待发送的图片标记后，可以删除整个缓存目录。删除后须重启 CLI 重建加载状态。会话插件会发布 `current-<port>.json` 心跳，停止后 5 秒过期；没有有效心跳时显示“会话待识别”。不自动修改项目 `.gitignore`。

## 开发与验证

需要 Node.js 22.22+（或 24.15+）、npm。

```sh
npm ci
npm run check
npm test
npm run test:bundle
npm run test:live
npm run test:tui
npm run package
```

`test:live` 使用 PATH 中的真实 `opencode`，在临时项目与独立配置目录中启动服务，以 `noReply: true` 发送测试消息，再验证持久化的图片附件；不调用模型生成。

`test:tui` 通过 Python 3 的 PTY 运行真实 OpenCode TUI，验证“首页 → 会话 A → 会话 B → 新会话”的当前会话名称，无模型调用。`npm run test:tui -- --manual` 验证未设置官方终端环境变量、仅 `--port` 启动的场景。

验证基线：VS Code API 1.94、OpenCode CLI / plugin API 1.18.32。桌面截图粘贴和真实 SSH Webview 操作仍需在客户端进行验收：分别上传、粘贴、拖拽一张图片；确认远端 CLI 输入追加标记，发送后模型能看到图片；确认大小超限及未重启 CLI 时显示错误并保留待添加图片。

失败详情见 VS Code 输出面板 **OpenCode SSH Images**。HTTP 请求失败时会保留缓存，避免已到达 CLI 的图片标记失效；若请求响应丢失，重试前请检查 CLI 输入，避免重复追加。

端口发现诊断（在源码目录运行，无需 VS Code 终端记录）：

```sh
node test/discover-live.cjs /path/to/project
```

输出发现的端口、PID、来源、在线状态和名称。没有有效 TUI 心跳时显示“会话待识别”，不会猜测最新会话作为当前会话。
