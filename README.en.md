# Hongguo Short Dramas (codex-hongguo)

[中文](README.md) · English

Watch Hongguo short dramas in the right-hand panel while Codex works on a task. By default, a new task resumes the selected episode; finishing or interrupting the task pauses playback and saves your position. You can turn off either behavior independently in Settings. The plugin supports local-executor Codex Desktop conversations.

After installation and Hook review, continue working normally. The optional **Watch while you wait** card offers up to three shows per turn. It prioritizes **Continue watching**, or **Watch next** when the saved episode is complete and another episode is available. Other slots rotate unwatched shows. Clicking a title opens the player in that chat and starts muted playback.

## Usage

| Scenario | How to Open |
| --- | --- |
| Start from a task suggestion | Click a title in **Watch while you wait** during a running turn. At most one card is offered per turn; you can ignore it and continue the task. No new card is requested when suggestions are disabled or this conversation already has a visible player. |
| Watch while waiting for a task | Click **＋** on the right side of a conversation (or press `⌘T` on macOS to open a new tab), type `红果` in the address bar, and select **红果短剧**; or click **More tools…** (`更多工具…`) and choose **红果短剧** under **Plugins and MCPs** (`插件和 MCP`). The player opens on the right side of that conversation. |
| Watch independently | In Codex Desktop with the plugin installed, click [Open Hongguo Short Dramas](codex://plugins/codex-hongguo@hongguo-local/app/open_drama_panel) to open the standalone catalog. To play and pause automatically with tasks, open the player from the corresponding chat instead. |

- **Browse & resume**: The catalog shows saved titles as it refreshes. On first use, titles appear as soon as the first batch arrives. Click any show title in Recommendations, Search results, or Watch history (`观看历史`) to start playing. Previously watched shows automatically resume from your last episode and timestamp, with a banner option to **Start over** (`从头播放`). Watch history is grouped by show and supports removing individual entries.
- **Muted by default & playback controls**: Playback starts muted whenever you open the player; click the speaker button or adjust the volume slider to unmute. On-screen controls support scrubbing, playback speed (`0.75×`–`2×`), and fullscreen. The episode selector groups episodes in sets of 50 with Previous, Next, and random episode buttons.
- **Watch while waiting**: Both the conversation card and catalog can offer up to 3 titles. Choices stay fixed within a turn. Chats share local rotation records, which advance after titles become visible. Disable suggestions or edit additional search keywords in **Settings**.
- **Pause and resume.** Click the picture, center button or toolbar playback button to pause. Click again to resume from the same position, during or after a task.
- **Background playback.** Playback continues when you switch windows or tabs. When automatic pausing is enabled, a task ending or being interrupted in this chat also pauses background playback. Closing the player saves your position.
- **Local preparation and split view**: Episodes are prepared locally and sent to the side panel in small chunks. HEVC video is converted to H.264 and non-AAC audio is converted to AAC as needed, so initial preparation can take time. The regular player offers **Split view** (`分屏`) after selecting an episode; open its one-time link in the Codex built-in browser within 60 seconds. Players opened from an inline suggestion card do not show this button; open the regular player from the right-side **＋** when needed.

### Global playback settings

Open **Settings** at the top right of the player, make your changes, and click **Save settings**.

| Setting | Default | Behavior |
| --- | --- | --- |
| Pause automatically when a task ends | On | Pause and save your position when a task in this chat finishes or is interrupted. Turn it off for continuous playback. |
| Play automatically when a task starts | On | Play the selected episode from its current position when a new task starts in the same chat. |

The switches are independent, saved across restarts, and shared by all chats. Other open players sync saved settings. Autoplay requires an open player with an episode selected; it does not choose a show or reopen a closed player. Manual pausing lasts for the current task; the autoplay switch determines whether the next task resumes playback. Updates preserve saved choices.

## Installation & Setup

Requires macOS or Linux, Node.js >=22.16 with npm, a Codex CLI supporting npm plugin sources, and FFmpeg (>=8 recommended). On macOS, install dependencies with `brew install node ffmpeg`. Local verification uses Codex CLI 0.157.1. Linux desktop verification is pending. The offline ZIP includes a native Windows x64 preview launcher; Windows npm installation remains gated until desktop acceptance. See the [Windows preview guide](docs/windows-support.md).

First npm/GitHub publication is pending: the source repository is public, but the npm package and GitHub Releases installers have not been published. For now, build from source or use an offline ZIP provided by the maintainer. The online commands below require the first npm release. See the [distribution notes](docs/npm-distribution.md).

### Build from source

In addition to the runtime dependencies, building requires Go >=1.25 to generate the Windows launcher.

```sh
git clone https://github.com/mreasonyang/codex-hongguo.git
cd codex-hongguo
npm ci
npm run package
```

This generates `release/codex-hongguo-<version>/` and a ZIP with the same name. Enter the generated directory and follow the installation command below. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow.

### Offline package

Extract `codex-hongguo-<version>.zip` into a permanent directory, or enter `release/codex-hongguo-<version>/` after building from source. Run from that directory:

```sh
node plugins/codex-hongguo/bin/codex-hongguo.mjs setup --marketplace .
```

The offline archive uses the same build as npm, with automatic runtime discovery. Repeat this command for offline updates, pointing `--marketplace` at the new directory. Always repeat this option for custom sources; omitting it selects the default GitHub marketplace.

### Online installation

After the first npm release, use:

```sh
npx @kyun.si/codex-hongguo@latest setup
```

The setup command checks dependencies and installs a pinned package version through Codex's native marketplace. The package includes JavaScript dependencies, the player and WASM; Node, npm and FFmpeg remain local prerequisites. The launcher discovers them automatically. Open a new local chat after installing, run plugin Setup, and review the Hooks.

### Post-Install Setup

- **Run the Setup guide**: Run **Setup** from the plugin details view (which invokes `hongguo-setup`), or say `配置红果短剧` in a local conversation. The setup check verifies Node, the progress database, FFmpeg, and whether all three plugin Hooks are trusted and enabled.
- **In-player getting started guide**: The player shows a getting started guide (`使用指南`) the first time it opens. Clicking **Browse shows** (`开始选剧`) dismisses the guide. It appears again if an update requires hook review. You can reopen it anytime from **Settings → Getting started** (`设置 → 使用指南`) and click **Check again** (`重新检查`), or run **Diagnostics** (`自检`) in Settings.
- **Review and trust Hooks**: For task-start and task-end playback control, open Codex Desktop **Settings → Hooks** (`设置 → Hooks`), review and trust Hongguo's `UserPromptSubmit`, `Stop`, and `Interrupt` hooks, and then run the check again. Installation and Setup never trust Hooks automatically on your behalf and never treat past turn records as proof that Hooks are configured; if host trust status cannot be read, it is shown as **Unverified** (`待确认`). You can watch manually before completing Hook setup.
- **No extra accounts or permissions**: Normal browsing and playback do not require a Hongguo account, API key, or browser automation permissions.

### Troubleshooting

- **No task suggestions**: Enable suggestions, trust all three Hooks, and retry in a new local turn with no visible player. If the catalog returns no candidates or the host does not display the card, use the right-side **＋** to open the player.
- **FFmpeg missing**: Install it, restart Codex, then check again in **Settings → Getting started**.
- **Turn linkage is unverified**: Check all three events in Codex **Settings → Hooks**. A passing environment check does not establish that automatic pausing works; manual playback remains available.

- **Playback pauses too often**: Turn off **Pause automatically when a task ends** in the player's Settings and save to keep watching continuously.
- **A new task does not resume playback**: Enable and save **Play automatically when a task starts**. Keep the player open in that chat with an episode selected. New defaults do not override a previously saved off setting.

### Updating, Disabling & Uninstalling

Close all open player panels and split-view browser tabs before updating or uninstalling. Open a new conversation to verify after managing plugins.

For offline installations, follow the offline package instructions above. After the first npm release, online installations can use:

```sh
npx @kyun.si/codex-hongguo@latest update
```

These commands apply to online installations; native updates can also use `codex plugin marketplace upgrade hongguo-local`. Follow the offline instructions for ZIP installations. The installer keeps the same `codex-hongguo@hongguo-local` identity. Migrating a ZIP installation to the online source replaces its marketplace and attempts to restore the old source on failure. Viewing data stays in its original location. Use `setup --dry-run` to preview the plan; this still checks dependencies. After updating, open a new conversation and review changed Hooks when prompted.

- **Disable or uninstall**: Disable the plugin in Codex plugin settings, or run `codex plugin remove codex-hongguo@hongguo-local`. After uninstalling, you can keep or manually remove the dedicated user data directory below:

| OS | User Data Directory |
| --- | --- |
| macOS | `~/Library/Application Support/CodexHongguo/` |
| Windows x64 (preview) | `%LOCALAPPDATA%\CodexHongguo\` |
| Linux | `codex-hongguo` under `XDG_DATA_HOME` (defaults to `~/.local/share/codex-hongguo/`) |

Inside this folder, `player.sqlite` and its WAL/SHM files store progress, turn state, recommendation rotation and settings. `media/` holds prepared full episodes, capped at 40 episodes and 1 GiB with protection for active files. `panel-media/` contains temporary panel fragments with separate cleanup; its size is outside that 1 GiB limit. `device/` holds the upstream SDK's anonymous device profile. Raw hook payloads, prompts and assistant replies are not written to disk. Third-party runtime dependency notices are under `licenses/` in the plugin root.

## Features & Limitations

| Area | Behavior & Scope |
| --- | --- |
| Host scope | Supports only Codex Desktop conversations running on the local executor; does not support cloud/remote executors or other host applications. |
| Content source & streams | Connects to the Hongguo catalog only (no multi-provider source switcher); when an episode offers multiple streams, the player selects a playable stream automatically without a manual quality selector. |
| Recommendations & search | Catalog browsing and search rely on the anonymous upstream SDK; the home view prioritizes unwatched shows in batches of up to 12 (cached for 15 minutes) and falls back to configurable search keywords when recommendations are sparse. |
| Anonymous rate-limit recovery | When an anonymous device is rejected or streams come back empty, the SDK performs bounded retries and device resets before surfacing the failure reason with a retry action. |
| Progress persistence | Saves playback position locally every ~5 seconds while playing, as well as on pause, seek, episode change, or panel hide. |
| Turn linkage & autoplay | Task-start autoplay and task-end automatic pausing both default to on; see Global playback settings above. Autoplay next is enabled by default and remembers changes. |
| Appearance & locale | Adapts to narrow sidebars (episodes below video) and wide panels (episodes beside video), following Codex light/dark themes and Chinese/English UI locales. |
| Verification status | macOS local regression, isolated npm/npx installation and source migration, live host catalog/episode access, and fragment decoding have been verified. See [GitHub Actions](https://github.com/mreasonyang/codex-hongguo/actions) for cross-platform CI status. Full Windows/Linux desktop and natural task-playback acceptance remain pending. The public npm package and GitHub Releases installers have not been published. |

<!-- development -->

## Contributing

Build, test, release packaging, isolated installation verification, environment variables, and versioning rules live in [CONTRIBUTING.md](CONTRIBUTING.md).

See [npm distribution, upgrades and publishing](docs/npm-distribution.md) for package structure and release maintenance.

## License & Credits

- **Project license**: No project license has been specified; npm artifacts use `UNLICENSED`. Bundled third-party dependency notices are under `licenses/` in the plugin root. Copyrights for drama series, covers and media streams belong to their respective rightsholders.
- **Upstream & specifications**: Inspired by [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo), with Hongguo catalog and playback resolution powered by [openhongguo](https://github.com/beilunyang/openhongguo). Host integration follows [OpenAI Plugin Extensions](https://developers.openai.com/plugins/build/extensions), [Plugin Packaging](https://developers.openai.com/plugins/build/plugins), and [Codex Hooks](https://learn.chatgpt.com/docs/hooks).
