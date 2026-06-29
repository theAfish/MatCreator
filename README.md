<p align="center">
  <img src="docs/images/logo.png" width="180" alt="MatCreator Logo">
</p>

<h1 align="center">MatCreator</h1>

<p align="center">
An <b>agentic AI platform for computational materials science</b>.
<br>
Build workflows, generate structures, run simulations, and continuously acquire new skills.
</p>

<p align="center">

![Python](https://img.shields.io/badge/Python-3.12+-blue)
![License](https://img.shields.io/badge/license-Apache--2.0-green)
![Status](https://img.shields.io/badge/status-active-success)

</p>

---

## ✨ Features

- 🧠 **Agentic workflow planning** using graph-based execution
- 🔬 **Materials science focused**, from crystal generation to MLFF workflows
- 🧩 **Skill-based architecture** — capabilities are modular and extensible
- 📚 **Self-improving knowledge graph** that accumulates experience over time
- 🌐 **Modern Web UI** with graph visualization and artifact management
- ⚡ **CLI + API + Web** interfaces

---

## Quick Start

### Installation

```bash
git clone https://github.com/AI4MS/MatCreator.git
cd MatCreator

pip install uv
uv venv .venv --python 3.12
source .venv/bin/activate

uv pip install -e .
```

Configure your LLM credentials through the MatCreator CLI

```bash
matcreator config set llm.model=openai/qwen3-plus
matcreator config set llm.api_key=your-api-key
matcreator config set llm.base_url=https://api.example.com/v1
```

Start an interactive session from the workspace you want MatCreator to use

```bash
matcreator chat --workspace .
```

### [Optional] Install vite
For using vite web frontend, you need to install it first:
```bash
cd web/vite-frontend
npm install
````
Make sure your system has node.js installed before installing vite.

Check vite installation with:
```bash
npx vite --version
```

---

## Launch

### Web Interface (Recommended)

```bash
bash script/start_matcreator.sh
```

This starts

- ADK API
- FastAPI backend
- Vite frontend

---

### CLI

```bash
matcreator chat

matcreator chat --workspace ~/materials-project
```

By default, `matcreator chat` starts in Flash mode for fast direct interaction. Use `matcreator chat --plan` when you want the full planning and graph-execution workflow.

---

## Documentation

Detailed installation, configuration, and deployment instructions will live on the GitHub Pages documentation site: [ai4ms.github.io/MatCreator](https://ai4ms.github.io/MatCreator/).

---

## Vision

MatCreator aims to become a continually evolving AI scientist for computational materials research by combining

- Large language models
- Scientific software
- Modular skills
- Long-term knowledge accumulation

into a unified agentic system.

---

## License

Apache 2.0