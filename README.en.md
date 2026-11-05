# Hongguo Short Dramas (codex-hongguo)

[中文](README.md) · English

Browse and resume Hongguo short dramas in the right-hand panel of a Codex Desktop conversation. Click the video to pause or resume. When a task in this chat finishes or is interrupted, playback pauses and saves your position. The current version (`0.0.15`) only supports Codex Desktop conversations running on the local executor.

## Usage

| Scenario | How to Open |
| --- | --- |
| Watch while waiting for a task | Click **＋** on the right side of a conversation (or press `⌘T` on macOS to open a new tab), type `红果` in the address bar, and select **红果短剧**; or click **More tools…** (`更多工具…`) and choose **红果短剧** under **Plugins and MCPs** (`插件和 MCP`). The player opens on the right side of that conversation. |
| Watch independently | In Codex Desktop with the plugin installed, click [Open Hongguo Short Dramas](codex://plugins/codex-hongguo@hongguo-local/app/open_drama_panel) to open the standalone catalog. To pause automatically with a running task, open the player from that conversation instead. |

- **Browse & resume**: The catalog shows saved titles as it refreshes. On first use, titles appear as soon as the first batch arrives. Click any show title in Recommendations, Search results, or Watch history (`观看历史`) to start playing. Previously watched shows automatically resume from your last episode and timestamp, with a banner option to **Start over** (`从头播放`). Watch history is grouped by show and supports removing individual entries.
- **Muted by default & playback controls**: Playback starts muted whenever you open the player; click the speaker button or adjust the volume slider to unmute. On-screen controls support scrubbing, playback speed (`0.75×`–`2×`), and fullscreen. The episode selector groups episodes in sets of 50 with Previous, Next, and random episode buttons.
- **Watch while waiting**: While a turn is running, the catalog displays up to 3 quick suggestions (you can turn suggestions off or edit fallback search keywords in **Settings**). When a task in this chat finishes or is interrupted, playback pauses and saves your position. You choose when to play again.
- **Pause and resume.** Click the picture, center button or toolbar playback button to pause. Click again to resume from the same position, during or after a task.
- **Background playback.** Playback continues when you switch windows or tabs. A task ending or being interrupted in this chat also pauses background playback. Closing the player saves your position.
- **Built-in browser split-view fallback**: Full episodes play inside the side panel by default—prepared locally on your machine and streamed to the player in small chunks. If the desktop panel cannot decode an episode's video encoding, select the episode, click **Split view** (`分屏`) next to the show title, and paste the one-time link into the Codex built-in browser within 60 seconds to watch side by side with your conversation.

## Installation & Setup

Requires macOS or Linux, Node.js >=22.16, a Codex CLI supporting npm plugin sources, and FFmpeg (>=8 recommended). On macOS, install dependencies with `brew install node ffmpeg`. The Windows npm launcher is pending implementation and device verification.

First npm/GitHub publication is pending. The online commands become available after the initial release; use the offline archive below in the meantime. See the [distribution notes](docs/npm-distribution.md).

```sh
npx codex-hongguo@latest setup
```

The setup command checks dependencies and installs through Codex's native marketplace. The Git index pins a published npm version. The complete package includes runtime dependencies, the player and WASM; its launcher discovers Node and FFmpeg automatically. Open a new local conversation after installing, run plugin Setup, and review the Hooks.

### Offline package

Extract `codex-hongguo-<version>.zip` into a permanent directory and run from its root:

```sh
node plugins/codex-hongguo/bin/codex-hongguo.mjs setup --marketplace .
```

The offline archive uses the same build as npm. For offline updates, point `--marketplace` at the new directory. No `configure.mjs` step is needed.

### Post-Install Setup

- **Run the Setup guide**: Run **Setup** from the plugin details view (which invokes `hongguo-setup`), or say `配置红果短剧` in a local conversation. The setup check verifies Node, the progress database, FFmpeg, and whether all three plugin Hooks are trusted and enabled.
- **In-player getting started guide**: The player shows a getting started guide (`使用指南`) the first time it opens. Clicking **Browse shows** (`开始选剧`) dismisses the guide. It appears again if an update requires hook review. You can reopen it anytime from **Settings → Getting started** (`设置 → 使用指南`) and click **Check again** (`重新检查`), or run **Diagnostics** (`自检`) in Settings.
- **Review and trust Hooks**: For turn-linked automatic pausing, open Codex Desktop **Settings → Hooks** (`设置 → Hooks`), review and trust Hongguo's `UserPromptSubmit`, `Stop`, and `Interrupt` hooks, and then run the check again. Installation and Setup never trust Hooks automatically on your behalf and never treat past turn records as proof that Hooks are configured; if host trust status cannot be read, it is shown as **Unverified** (`待确认`). You can watch manually before completing Hook setup.
- **No extra accounts or permissions**: Normal browsing and playback do not require a Hongguo account, API key, or browser automation permissions.

### Updating, Disabling & Uninstalling

Close all open player panels and split-view browser tabs before updating or uninstalling. Open a new conversation to verify after managing plugins.

```sh
npx codex-hongguo@latest update
```

Native updates can also use `codex plugin marketplace upgrade hongguo-local`. The installer keeps the same `codex-hongguo@hongguo-local` identity. ZIP migration replaces the old source and attempts to restore it on failure; viewing data remains in its original location. Use `setup --dry-run` to preview the plan. After updating, open a new conversation and review changed Hooks when prompted.

- **Disable or uninstall**: Disable the plugin in Codex plugin settings, or run `codex plugin remove codex-hongguo@hongguo-local`. After uninstalling, you can keep or manually remove the dedicated user data directory below:

| OS | User Data Directory |
| --- | --- |
| macOS | `~/Library/Application Support/CodexHongguo/` |
| Windows | `%LOCALAPPDATA%\CodexHongguo` |
| Linux | `codex-hongguo` under `XDG_DATA_HOME` (defaults to `~/.local/share/codex-hongguo/`) |

Inside this folder, `player.sqlite` (along with its WAL/SHM files) stores watch progress, turn state, and player settings; `media/` caches locally prepared full episodes (capped at 40 episodes and 1 GiB, with a hold period for active files); `device/` holds the anonymous device profile managed independently by the upstream SDK. This plugin does not write raw hook payloads, prompts, or assistant replies to disk. Third-party runtime dependency notices are bundled under `licenses/` in the plugin root.

## Features & Limitations

| Area | Behavior & Scope |
| --- | --- |
| Host scope | Supports only Codex Desktop conversations running on the local executor; does not support cloud/remote executors or other host applications. |
| Content source & streams | Connects to the Hongguo catalog only (no multi-provider source switcher); when an episode offers multiple streams, the player selects a playable stream automatically without a manual quality selector. |
| Recommendations & search | Catalog browsing and search rely on the anonymous upstream SDK; the home view prioritizes unwatched shows in batches of up to 12 (cached for 15 minutes) and falls back to configurable search keywords when recommendations are sparse. |
| Anonymous rate-limit recovery | When an anonymous device is rejected or streams come back empty, the SDK performs bounded retries and device resets before surfacing the failure reason with a retry action. |
| Progress persistence | Saves playback position locally every ~5 seconds while playing, as well as on pause, seek, episode change, or panel hide. |
| Turn linkage & autoplay | Playback pauses once when a task in this chat ends or is interrupted. Press Play to resume. Autoplay advances to the next episode by default. Turning it off also applies the next time you open the player. |
| Appearance & locale | Adapts to narrow sidebars (episodes below video) and wide panels (episodes beside video), following Codex light/dark themes and Chinese/English UI locales. |
| Verification status | 41 regression tests, native npm/npx installation, old-ZIP migration with progress retention, and live app-server catalog checks pass. Desktop video rendering and natural turn auto-pause were not observed in this installation test; Linux device checks and the Windows launcher remain pending. |

<!-- development -->

## Contributing

Build, test, release packaging, isolated installation verification, environment variables, and versioning rules live in [CONTRIBUTING.md](CONTRIBUTING.md).

See [npm distribution, upgrades and publishing](docs/npm-distribution.md) for package structure and release maintenance.

## License & Credits

- **Project license**: This repository currently does not include a project `LICENSE` file, and no project license has been specified yet. Third-party notices for bundled runtime dependencies are provided separately under `plugins/codex-hongguo/licenses/` in packaged archives. Copyrights for drama series, covers, and media streams belong to their respective rightsholders.
- **Upstream & specifications**: Inspired by [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo), with Hongguo catalog and playback resolution powered by [openhongguo](https://github.com/beilunyang/openhongguo). Host integration follows [OpenAI Plugin Extensions](https://developers.openai.com/plugins/build/extensions), [Plugin Packaging](https://developers.openai.com/plugins/build/plugins), and [Codex Hooks](https://learn.chatgpt.com/docs/hooks).
