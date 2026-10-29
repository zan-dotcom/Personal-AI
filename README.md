# Hearth — your personal, local AI

A quiet place to ask questions, write, learn, plan, and work on code. Hearth is a browser chat app that runs on your own computer using [Ollama](https://ollama.com). It needs no cloud AI account, API key, paid subscription, or Python packages.

## Your Linux computer: 16 GB RAM + RTX 5060

Start with **`qwen3:8b`** (about a 5 GB model download). An RTX 5060 typically has 8 GB VRAM; check yours with `nvidia-smi`. This app uses a 4,096-token context to keep memory use manageable. Close GPU-heavy apps if loading is slow or memory runs short. For a lighter option, use `qwen3:4b`.

### 1. Check the NVIDIA driver

```bash
nvidia-smi
python3 --version
```

Use Python 3.10 or newer and a current NVIDIA driver compatible with the RTX 50 series. If `nvidia-smi` fails, install/update the NVIDIA driver through your Linux distribution and reboot. You do not need to install a separate CUDA toolkit for Ollama.

### 2. Install Ollama and get a model

Follow [Ollama's official Linux instructions](https://docs.ollama.com/linux) to install the current release (recent releases support RTX 50-series GPUs). The official installer can be downloaded and inspected before you run it:

```bash
curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
less /tmp/ollama-install.sh
sh /tmp/ollama-install.sh
ollama pull qwen3:8b
```

The installer normally starts Ollama as a service. If it is not running, run `ollama serve` in another terminal. An “address already in use” message usually means the service is already running. Do not start a second copy.

### 3. Start Hearth

From this repository's directory:

```bash
python3 -m personal_ai
```

Open **http://127.0.0.1:8000** on that same computer. Select your model and start a conversation. The first reply can take longer while the model loads. Press Ctrl+C in the terminal to stop the web app; your conversations remain saved.

After your first message, check GPU use:

```bash
ollama ps
nvidia-smi
```

`ollama ps` reports the CPU/GPU split. If it shows CPU only, check the current Ollama version and driver compatibility rather than assuming GPU acceleration works.

## What you can do

- Chat with any installed Ollama chat model and watch replies stream in.
- Continue, delete, or export conversations as Markdown.
- Attach one small UTF-8 text/code file for questions and summaries. The combined message and attachment limit is 12,000 characters; PDF, Office, images, and binary files are not supported yet.
- Set your assistant's instructions and creativity under Settings.
- Stop a reply. Text already generated is retained; stopping is processed when the next token arrives.
- Use Enter to send, Shift+Enter for a new line, and Ctrl/Cmd+Shift+N for a new chat.

For another model, run `ollama pull qwen3:4b`, then refresh the page or choose “Check again” during setup. Installed models appear in the selector.

## Privacy and boundaries

The web app binds only to `127.0.0.1` and talks only to the local Ollama endpoint. There are no analytics, externally loaded fonts/scripts, or cloud AI calls. After installing the software and downloading a model, normal chat works offline. Keep Ollama bound to loopback too; do not expose either service directly to the internet.

Conversations and attachments included in messages are stored **unencrypted** in `data/chats.sqlite3`. Browser preferences are in localStorage. Treat the database as private: use disk encryption and protect backups. Deleting a chat removes its app records, but is not guaranteed forensic erasure from disk, SQLite journals, or backups. `data/` is excluded from Git.

This first version can answer questions and help draft work. It does **not** browse the web, execute commands, control devices, independently read your files, retain permanent knowledge beyond saved chats, or guarantee correct answers. Only recent messages fitting the context budget are sent back to the model; long conversations may lose earlier context. Model knowledge may be out of date. Verify consequential advice and commands before acting on them.

## Configuration

```bash
python3 -m personal_ai --port 8080 --data-dir /path/to/private/chat-data
```

`PERSONAL_AI_DATA_DIR` changes the default data directory. `OLLAMA_URL` or `--ollama-url` can select another **local** HTTP Ollama port (default `http://127.0.0.1:11434`). Relative data paths are relative to your working directory, so launch from the same directory each time or choose an absolute path. No `.env` loader or package installation is required.

If Ollama is offline, start the service and click “Check again.” If a model is missing, download it with `ollama pull MODEL_NAME`. For port conflicts, use `--port 8080`. Check Ollama's logs with `journalctl -u ollama --no-pager -n 50` on systemd systems.

## Development and checks

Python's standard library serves the static frontend, streams the Ollama API, and persists chats in SQLite. No build step is needed.

```bash
python3 -m unittest discover -s tests -v
```

The integration tests start a deterministic local Ollama stand-in and exercise streaming, context/history, persistence, deletion, validation, origin/host checks, and model failure handling. They do not measure real model quality or prove NVIDIA acceleration. Verify those on your home machine with a real conversation and `ollama ps`.
