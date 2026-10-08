# User Guide

## First use

1. Open a remote project with VS Code Remote-SSH.
2. Start OpenCode CLI in that same remote project directory.
3. Run `OpenCode: Add local image attachments (SSH)` from the Command Palette, or press `Ctrl+Alt+I` (`Cmd+Alt+I` on macOS).
4. Restart OpenCode CLI when the extension asks you to load its project plugin.
5. The panel will detect the CLI. Use **Connect / switch** when more than one CLI target is available.

## Attach an image

Click the drop area and paste a screenshot, drag local image files into it, or choose files. Then select **Add to CLI input**, continue typing in OpenCode, and press Enter to send.

Supported formats are PNG, JPEG, GIF, and WebP. The default limit is 10 MiB per image, with up to 10 images and 40 MiB total. The limit can be changed with `opencodeSshImages.maxImageSizeMB` from 1 to 20 MiB.

## Troubleshooting

- Restart OpenCode CLI after installing or updating the project plugin.
- Make sure the CLI working directory matches the project selected in the panel.
- Use **Show target terminal** to return to the matching OpenCode terminal.
- Inspect the **OpenCode SSH Images** output channel for connection details.
- If an upload fails after the marker was appended, check the CLI input before retrying. The remote cache is intentionally retained so an already-appended marker remains valid.

The extension communicates with the remote CLI through the existing VS Code SSH channel and only contacts the CLI's remote loopback HTTP endpoint.