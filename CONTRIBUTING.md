# Contributing

Thanks for helping improve OpenCode SSH Images.

## Development setup

Use Node.js 22.22+ (or 24.15+) and npm:

```sh
npm ci
npm run check
npm test
```

For changes to the packaged extension, also run `npm run test:bundle` and `npm run package`.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Add or update tests for connection, upload, discovery, and configuration behavior.
- Keep Webview copy available in English and Simplified Chinese.
- Do not commit generated VSIX files, `.opencode/ssh-images/` cache data, credentials, or private workspace paths.
- Confirm that Remote-SSH, light/dark themes, narrow panels, and keyboard paste still work.

## Commit and review notes

Please include the commands you ran and call out any live-test prerequisites. Security-sensitive changes should explain what data crosses the SSH channel and which local files are written.