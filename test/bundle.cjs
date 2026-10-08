const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['--test', 'test/extension.test.cjs'], {
  env: { ...process.env, OPENCODE_SSH_IMAGES_TEST_BUNDLE: '1' }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
