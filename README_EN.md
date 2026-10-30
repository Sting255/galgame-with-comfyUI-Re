# Linshe.EXE (邻舍.EXE)

[中文](./README.md) · [Download](https://github.com/icecranberry/galgame-with-comfyUI/releases)

A local-first AI character companion inspired by visual novels. Create characters and worlds whose conversations, memories, emotions, schedules, and generated images evolve together.

> [!NOTE]
> **This repo is a personal enhanced fork of [Linshe.EXE](https://github.com/icecranberry/galgame-with-comfyUI)** — upstream baseline v3.10.0, current version **v3.10.1**. On top of upstream: reworked appearance & body-size system, a new "World Map" page (narrative geography skeleton), 84 intimate poses wired into dialogue & image prompts, and a compatibility layer for local OpenAI-compatible gateways that drop `system` messages / ignore `response_format`. The upstream "town" page has been removed locally. Feature walkthrough below is kept in Chinese.

## Project demo video (Chinese)

**[🤯这一定是一个不同以往的浪漫AI小镇♪~【超自定义的素材生成】【邻舍3.5】](https://www.bilibili.com/video/BV1tKab6CEp2/)**

Full link: [https://www.bilibili.com/video/BV1tKab6CEp2/](https://www.bilibili.com/video/BV1tKab6CEp2/)

## Screenshots

### Media & social feeds

Browse newspapers, digital publications, and social feeds to discover character updates and local news across channels.

![Media and social feeds](https://github.com/user-attachments/assets/788b4841-2237-4a33-9bdd-e07ef924a011)

### Immersive visual novel chat

Chat with scene backgrounds, character portraits, changing expressions, and typewriter dialogue. Review the conversation history or type a reply directly.

![Immersive visual novel chat](https://github.com/user-attachments/assets/f5e7183c-f385-4e8b-b415-f6738b05b6e5)

### Town interactions

Meet residents on the map, catch up through dialogue, accept adventure invitations, take on work, or trade.

![Town resident interactions](https://github.com/user-attachments/assets/5cd70530-a961-4770-84c7-bcc9d9aa7a09)

### More screens

| Private chat | Group chat |
| --- | --- |
| ![Private chat](https://github.com/user-attachments/assets/73bb4cae-c191-41a0-a0fb-26c4ec2087fa) | ![Group chat](https://github.com/user-attachments/assets/c2c92fcb-d6f1-4be6-9e96-12d18157b58f) |

| Moments | Schedule |
| --- | --- |
| ![Moments](https://github.com/user-attachments/assets/3d191b4e-2353-4440-ab36-990759ced1ea) | ![Schedule](https://github.com/user-attachments/assets/71c08460-5473-4d8f-a069-7fdf76532e85) |

| Character tavern | Character details |
| --- | --- |
| ![Character tavern](https://github.com/user-attachments/assets/1711b6ee-b7df-4130-a192-d61ca783eb08) | ![Character details](https://github.com/user-attachments/assets/4cd732fa-1e98-4627-af87-5f7fc3b8cddc) |

| Gallery | Adventures |
| --- | --- |
| ![Gallery](https://github.com/user-attachments/assets/6b746150-7974-43fa-b2f5-677406f23bcd) | ![Adventures](https://github.com/user-attachments/assets/c2b80641-54c7-4c08-8d1a-661f14d8da9e) |

**Mobile**

<img src="https://github.com/user-attachments/assets/c8d86580-94a5-4822-96bf-4dc9e459f201" alt="Mobile interface" width="260" />

## Features

- **Character companionship**: private and group chats, relationships, emotions, and affinity, with recent conversations, rolling summaries, and long-term memory informing replies.
- **Daily life**: proactive messages, schedules, social posts, letters, gifts, and inventory.
- **Town & adventures**: explore the town, talk to NPCs, and accept invitations. Choices on the Adventures page advance stories and building services; coins, gifting, and trading are also supported.
- **Scene images**: generate images from conversations and character appearances through ComfyUI or NovelAI, with galleries, standing portraits, and upscaling tools.
- **Customization & devices**: editable personas, world settings, and model profiles; warm and dark themes with time-based switching; browser and Android WebView access.

Chats, characters, and images are stored locally. Cloud language models, image providers, embedding services, and rerankers receive the content needed for their configured tasks.

## Quick start

### Windows release package

1. Download and extract `邻舍.EXE-vX.Y.Z.zip` from [Releases](https://github.com/icecranberry/galgame-with-comfyUI/releases), then run `邻舍.EXE.exe`.
2. Click 「启动邻舍」 on the launcher's home page. The browser opens automatically.
3. Configure the LLM API address, key, and model in web **Settings**. OpenAI-compatible endpoints are supported.
4. Configure image generation as needed: ComfyUI requires the models and nodes used by the workflow (default address: `http://localhost:8188`); NovelAI requires its endpoint and key.
5. Create or import a character in **Tavern** and start chatting.

The package includes portable runtimes, dependencies, and the frontend build. Android connects to the service running on your PC: keep the PC running on the same LAN. Check the selected release's assets for APK availability; see the [Android guide (Chinese)](./android-shell/README.md).

### Run from source

The commands below use **Windows PowerShell**. Use **Node.js 22.18+ (22.x)**, **Python 3.12 with venv**, and **Git** to align with the packaging script.

```powershell
git clone https://github.com/Sting255/linshe-gai.git
cd galgame-with-comfyUI

npm --prefix agent-core install
npm --prefix web-ui install

python -m venv vector-service/venv
./vector-service/venv/Scripts/python.exe -m pip install -r vector-service/requirements.txt
./vector-service/venv/Scripts/python.exe vector-service/download_model.py

npm run dev
```

Open [localhost:5173](http://localhost:5173) and complete the configuration above. The development script starts the frontend on `5173`, backend on `3099`, and vector service on `8765`. Start ComfyUI separately. The initial embedding model download requires network access; the development script also attempts to download it if missing.

On macOS / Linux, create the environment with `python3 -m venv vector-service/venv`, activate it with `source vector-service/venv/bin/activate`, and use `python` for dependency installation and model download before running `npm run dev`. Desktop EXE and release packaging target Windows.

## Configuration & data

- **Settings**: manage LLMs, image providers, and feature switches in the web UI. Values are saved to the database or `agent-core/.env`, depending on the setting. See [`.env.example`](./agent-core/.env.example) for environment variables.
- **Workflows**: missing bundled ComfyUI templates are restored into `workflow/` at backend startup. Install their models and custom nodes separately in ComfyUI.
- **Backups**: stop services, then copy `agent-core/data/`, `agent-core/.env`, and `vector-service/chroma_data/`. Include modified workflows and any custom data locations.

## Development

| Command (repository root) | Purpose |
| --- | --- |
| `npm run dev` / `npm run stop` | Start / stop development services |
| `npm run restart-core` | Restart the backend only |
| `npm --prefix web-ui run build` | Build the frontend into `agent-core/public/` |
| `npm --prefix web-ui test` | Run frontend tests |
| `npm --prefix web-ui run lint` | Run frontend static checks |
| `npm run build` | Build the frontend and Windows launcher |
| `npm run apk` | Build the Android WebView client |
| `npm run release` | Package the Windows release into `release/` |

Use an in-memory database for backend tests to protect local data (PowerShell):

```powershell
$env:DB_PATH = ':memory:'
npm --prefix agent-core test
Remove-Item Env:DB_PATH
```

| Directory | Purpose |
| --- | --- |
| `web-ui/` | Vue 3 + Pinia + Vite frontend, Three.js town renderer |
| `agent-core/` | Node.js + Express backend, SQLite / FTS5, LLM calls, and scheduling |
| `vector-service/` | FastAPI + ChromaDB + ONNX semantic memory retrieval |
| `launcher/` / `android-shell/` | PySide6 launcher / Android WebView client |
| `scripts/` | Development, build, and release scripts |

Read the [contribution conventions](./AGENTS.md) before making changes; UI changes follow the [design system](./docs/design-system.md). Further guides (Chinese): [Testing](./docs/testing.md) · [Town interactions](./docs/town-interactions.md) · [Town economy](./docs/town-economy.md) · [Upscaling](./docs/hires-workflow.md).

## License

MIT
