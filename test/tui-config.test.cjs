const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('jsonc-parser');
const { registerTuiPlugin } = require('../src/tui-config.cjs');

test('TUI registration preserves comments, preferences and existing plugin entries', () => {
  const text = '{\n  // 我的配置\n  "theme": "opencode",\n  "plugin": [["some-plugin", {"option": true}]],\n  "keybinds": {"leader": "ctrl+a"},\n}\n';
  const updated = registerTuiPlugin(text, 'file:///tmp/ssh-images-tui.mjs');
  assert.ok(updated.includes('// 我的配置'));
  const config = parse(updated);
  assert.equal(config.theme, 'opencode');
  assert.equal(config.keybinds.leader, 'ctrl+a');
  assert.deepEqual(config.plugin, [['some-plugin', { option: true }], 'file:///tmp/ssh-images-tui.mjs']);
  assert.equal(config.$schema, 'https://opencode.ai/tui.json');
  assert.equal(registerTuiPlugin(updated, 'file:///tmp/ssh-images-tui.mjs'), updated);
});

test('invalid TUI configuration is not silently replaced', () => {
  assert.throws(() => registerTuiPlugin('{"plugin": "bad"}', 'x'), /数组/);
  assert.throws(() => registerTuiPlugin('{broken', 'x'), /JSON/);
});
