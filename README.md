# OpenClaw 长期记忆插件 (mem0)

让你的 AI 助手拥有**真正的记忆力**。

---

## 🤔 为什么需要这个插件？

**问题：AI 会遗忘一切**

普通 AI 助手每次对话都从零开始。上次告诉它你喜欢什么、讨厌什么、工作是什么——下次全忘了。

**解决方案：mem0 长期记忆**

这个插件让 AI 像人一样记住你：

| 传统 AI | 使用 mem0 后 |
|---------|-------------|
| ❌ 每次对话都是陌生人 | ✅ 记住你的喜好和习惯 |
| ❌ 重复回答同样的问题 | ✅ 自动关联历史对话 |
| ❌ 无法进行长期项目协作 | ✅ 持续积累项目背景 |

**核心优势：**

- 🧠 **自动记忆** — 对话结束后自动提取并保存重要信息
- 🔍 **智能回忆** — 每次对话前自动搜索相关记忆注入上下文
- 🏠 **完全本地** — 支持本地嵌入模型，无需 API 密钥，数据不出本机
- 🌍 **多语言** — Qwen3 嵌入模型支持 100+ 语言（包括中文）

---

## 🚀 快速开始

### 1. 安装插件

```bash
openclaw plugins install https://github.com/1960697431/openclaw-mem0
```

### 2. 配置 (openclaw.json)

在 `plugins.entries` 中添加：

```json
"openclaw-mem0": {
  "enabled": true,
  "config": {
    "mode": "open-source",
    "userId": "你的用户名",
    "autoRecall": true,
    "autoCapture": true,
    "oss": {
      "embedder": {
        "provider": "transformersjs",
        "config": { "model": "onnx-community/Qwen3-Embedding-0.6B-ONNX" }
      },
      "vectorStore": {
        "provider": "memory",
        "config": {
          "dimension": 1024,
          "dbPath": "~/.openclaw/mem0-vectors.db"
        }
      },
      "llm": {
        "provider": "openai",
        "config": {
          "apiKey": "你的API密钥",
          "model": "gpt-4o",
          "baseURL": "https://api.openai.com/v1"
        }
      },
      "historyDbPath": "~/.openclaw/mem0-history.db"
    }
  }
}
```

### 3. 重启 OpenClaw

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

首次启动会自动下载嵌入模型（约 700MB）。

---

## 🔧 配置详解

### 本地嵌入模型 (推荐)

使用 `transformersjs` 运行本地 ONNX 模型，**无需 Ollama、无需 Python、无需 API**：

| 模型 | 维度 | 大小 | 语言 |
|------|------|------|------|
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` ⭐ | 1024 | ~700MB | 100+ |
| `Xenova/bge-small-en-v1.5` | 384 | ~130MB | 英文 |
| `Xenova/multilingual-e5-large` | 1024 | ~2GB | 多语言 |

### 使用 Antigravity 代理 (推荐给国内用户)

如果你使用 [Antigravity](https://antigravity.ai) 代理服务，可以这样配置 LLM：

```json
"llm": {
  "provider": "openai",
  "config": {
    "apiKey": "你的Antigravity密钥",
    "model": "gemini-3-flash",
    "baseURL": "http://localhost:8045/v1"
  }
}
```

> ⚠️ **注意**：Gemini 等模型返回 JSON 时会包装在 markdown 代码块中。本插件已内置 `JsonCleaningLLM` 自动处理此问题。

### 使用 OpenAI API

```json
"llm": {
  "provider": "openai",
  "config": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o"
  }
}
```

### 使用 Ollama (本地 LLM)

```json
"llm": {
  "provider": "ollama",
  "config": {
    "model": "llama3",
    "baseURL": "http://localhost:11434"
  }
}
```

---

## 🛠️ AI 工具

安装后，AI 助手可以使用以下工具：

| 工具 | 说明 |
|------|------|
| `memory_search` | 搜索记忆 |
| `memory_store` | 保存记忆 |
| `memory_list` | 列出所有记忆 |
| `memory_get` | 获取指定记忆 |
| `memory_forget` | 删除记忆 |

---

## 📋 CLI 命令

```bash
# 搜索记忆
openclaw mem0 search "用户的编程偏好"

# 查看统计
openclaw mem0 stats

# 列出所有记忆
openclaw mem0 list
```

---

## ❓ 常见问题

**Q: 记忆存储在哪里？**
A: 默认在 `~/.openclaw/mem0-vectors.db`，通过 `dbPath` 可自定义。

**Q: 需要翻墙吗？**
A: 使用本地嵌入模型 (`transformersjs`) 不需要。LLM 部分取决于你的配置。

**Q: 支持多用户吗？**
A: 支持。设置不同的 `userId` 即可隔离记忆。

---

## 📄 License

Apache 2.0

---

<details>
<summary><strong>🇬🇧 English Documentation</strong></summary>

## What is this?

Long-term memory plugin for [OpenClaw](https://github.com/openclaw/openclaw) agents, powered by [Mem0](https://mem0.ai).

Your agent forgets everything between sessions. This plugin fixes that. It watches conversations, extracts what matters, and brings it back when relevant — automatically.

### Features

- **Auto-Recall** — Injects relevant memories before each response
- **Auto-Capture** — Extracts and stores facts after each exchange
- **Local Embeddings** — Run ONNX models locally via transformers.js
- **Multi-language** — Qwen3 supports 100+ languages

### Quick Start

```bash
openclaw plugins install https://github.com/1960697431/openclaw-mem0
```

See the Chinese documentation above for detailed configuration.

</details>
