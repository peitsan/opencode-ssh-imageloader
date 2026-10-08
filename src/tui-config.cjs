const { parse, modify, applyEdits } = require('jsonc-parser');

// Surgical edits preserve comments, keybindings and unrelated plugin entries.
function registerTuiPlugin(text, spec) {
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || Array.isArray(config) || typeof config !== 'object') throw new Error('TUI 配置不是有效的 JSON/JSONC，请先修复后再安装。');
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error('TUI 配置 plugin 必须为数组。');
  const plugins = config.plugin || [];
  const present = plugins.some(entry => (Array.isArray(entry) ? entry[0] : entry) === spec);
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } };
  if (!config.$schema) text = applyEdits(text, modify(text, ['$schema'], 'https://opencode.ai/tui.json', options));
  if (!present) text = applyEdits(text, modify(text, config.plugin ? ['plugin', -1] : ['plugin'], config.plugin ? spec : [spec], options));
  return text;
}

module.exports = { registerTuiPlugin };
