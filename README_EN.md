# Linshe.EXE (邻舍.EXE)

[中文](./README.md) · [Download](https://github.com/Sting255/galgame-with-comfyUI-Re/releases) · [Changelog](https://github.com/Sting255/galgame-with-comfyUI-Re/releases)

A Galgame-inspired AI companion app. The characters you create have their own personality, mood, memory and daily schedule: they message you first, post to a social feed, write letters, bicker in group chats, and can ask ComfyUI to draw a scene from the conversation.

Most AI chat bots answer questions. Linshe tries to make the character feel like **someone who keeps living while you are away**.

> This is a personal enhanced fork of [Linshe.EXE](https://github.com/icecranberry/galgame-with-comfyUI), currently at **v4.2.2**, fully synced with upstream v4.2.1. Feature walkthrough below is kept in Chinese — the UI itself is Chinese-only.

## Download & install

1. Grab the latest bundle from [Releases](https://github.com/Sting255/galgame-with-comfyUI-Re/releases) and extract it (7z format; use 7-Zip or Bandizip)
2. Run `邻舍.EXE.exe`, click "启动邻舍" in the launcher — your browser opens automatically
3. In Settings, fill in your LLM endpoint, API key and model (any OpenAI-compatible API works)
4. For image generation, start ComfyUI (default `http://localhost:8188`) or switch to NovelAI in Settings
5. Create or import a character in "酒馆" and start chatting

The bundle ships its own Node runtime, dependencies and built frontend — no need to install Node or Python.

## Features

- **Companionship** — 1-on-1 chat, group chat, relationship graph, mood and affinity; replies draw on recent turns, rolling summaries and long-term memory
- **Daily life** — proactive messages, schedules, social feed, mailbox, gifts and inventory
- **Encounters** — accept invitations and advance character stories through choices
- **Scene images** — generate pictures from the conversation and character appearance; ComfyUI and NovelAI supported, with gallery, standing art and upscaling
- **Voice** — read chat and standing-touch lines aloud; API voice cloning or local IndexTTS 2.0
- **Customization** — personas, world settings, model profiles; warm-paper and dark themes
- **Multi-device** — desktop browser, or an Android WebView shell pointing at the same PC

Chat logs, characters and images stay on your own machine. Content is only sent to the model or image provider you configure.

## What this fork adds

- **Outfit system rework** — each character can define their own outfit types (workwear, swimsuit, wedding dress…), generated per type with a single click; the type name drives the design, while profession/persona only influence palette. Per-outfit standing art, schedule-driven switching, and manual "wear this now".
- **Per-character negative prompts** — exclude features that make the model draw the wrong character, scoped to single-character images only.
- **Runtime health panel** — recent failures by module, image queue depth, and LLM/ComfyUI connectivity, right on the Settings page.
- **Others** — outfit-override switch across all characters, a world map page, 84 intimate poses wired into dialogue and image prompts, reworked body/appearance system, and a programmable in-world clock.
- Upstream's "town" world page has been removed in this fork.

## Screenshots

See the [Chinese README](./README.md#界面预览).

## Config & data

- Everything is configured in the web UI (Settings) and takes effect immediately
- Character data, chats and images live under `agent-core/data/`; vector index under `vector-service/chroma_data/`
- One-click export/import is available in Settings — remember to enable "include model config", otherwise you will have to re-enter your API key on a new machine

## License

MIT
