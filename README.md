# 🧠 OpenClaw Mem0 智能记忆插件

> **让 AI 拥有长期记忆，同时节省 70% 的 Token 消耗**

基于 Mem0 构建的下一代智能记忆系统，专为 OpenClaw 设计。

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.3-blue.svg" alt="Version" />
  <img src="https://img.shields.io/badge/OpenClaw-2026.2+-green.svg" alt="OpenClaw" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-orange.svg" alt="License" />
</p>

---

## ⚡ 30 秒极速安装

```bash
curl -fsSL https://raw.githubusercontent.com/1960697431/openclaw-mem0/main/install.sh | bash
```

安装脚本会自动检查 `curl`/`unzip`/`npm`，并在下载失败时自动重试。

安装完成后重启 Gateway：
```bash
openclaw gateway restart
```

如果你是老版本（如 `0.4.6`）且启动时报错 `Cannot find module ...contextManager.js`，请执行一次强制重装：

```bash
rm -rf ~/.openclaw/extensions/openclaw-mem0 ~/.openclaw/extensions/openclaw-meme
curl -fsSL https://raw.githubusercontent.com/1960697431/openclaw-mem0/main/install.sh | bash
openclaw gateway restart
```

可选：检查当前插件版本

```bash
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.openclaw/extensions/openclaw-mem0/package.json")
print(json.load(open(p, "r", encoding="utf-8")).get("version"))
PY
```

*首次启动会自动下载嵌入模型（~417MB），请等待 2-3 分钟。*

---

## 🏆 三方对比：为什么选择我们？

| 特性 | OpenClaw Mem0 | 自带记忆 | 传统方案 |
| :--- | :---: | :---: | :---: |
| Token 智能管理 | ✅ 自动预算 | ❌ 无限制 | ❌ 全量读取 |
| 语义搜索 | ✅ 向量检索 | ❌ 关键词 | ⚠️ 基础搜索 |
| 冷热分离 | ✅ 自动归档 | ❌ 单文件 | ❌ 无分层 |
| 记忆修剪 | ✅ 智能清理 | ❌ 永久堆积 | ❌ 手动管理 |
| 并发安全 | ✅ 写入队列 | ❌ 无保护 | ⚠️ 可能锁死 |
| 国产模型适配 | ✅ 自动修正 | ⚠️ 手动配置 | ⚠️ 手动配置 |
| 零配置启动 | ✅ 继承配置 | ✅ 默认启用 | ❌ 复杂配置 |
| 自动更新 | ✅ 后台静默 | ❌ 手动升级 | ❌ 手动升级 |
| 状态监控 | ✅ 实时面板 | ❌ 无 | ❌ 无 |

### 💰 Token 节省实测

在 1000+ 条记忆的场景下：

| 方案 | 注入 Token | 有效信息比 |
| :--- | :---: | :---: |
| OpenClaw Mem0 | ~800 | 92% ✅ |
| 全量注入 | ~8000 | 15% ❌ |
| 关键词匹配 | ~3000 | 45% ⚠️ |

**结论：我们的方案在保证信息质量的同时，节省了约 70-90% 的 Token。**

---

## 🌟 核心技术

### 1. 📊 智能上下文注入 (Smart Context Injection)

**这是我们的核心优势，也是节省 Token 的关键：**

```
┌─────────────────────────────────────────────────────────┐
│                    Token 预算管理器                      │
├─────────────────────────────────────────────────────────┤
│  模型上下文: 128,000 tokens (GPT-4o)                     │
│  记忆预算:   1,920 tokens (1.5%)                         │
│                                                         │
│  100 条记忆 → 智能筛选 → 5 条最相关 → 800 tokens 注入   │
│                                                         │
│  ✅ 按相关度排序  ✅ 中英文 Token 估算  ✅ 自动截断      │
└─────────────────────────────────────────────────────────┘
```

**支持的模型上下文限制：**
- GPT-4o / GPT-4-Turbo: 128K tokens
- Claude 3.x: 200K tokens
- DeepSeek: 64K tokens
- Moonshot: 32K tokens
- 自动识别，无需配置

### 2. 🔥 冷热分离架构

| | 🔥 **热库 (Hot)** | 🧊 **冷库 (Cold)** |
|:---|:---|:---|
| **存储** | SQLite + 向量索引 | JSONL 归档文件 |
| **容量** | ≤ 2000 条 (可配置) | 无限 |
| **速度** | 毫秒级 | 秒级 |
| **内存** | ~1.5GB | ~0MB |
| **场景** | 日常对话 | 历史查询 |

### 3. 🔒 并发写入保护

```typescript
WriteQueue → 串行化写入 → 防止 SQLITE_BUSY → 稳定可靠
```

### 4. 📊 实时状态监控

```bash
# CLI 命令
openclaw mem0 stats      # 简洁统计
openclaw mem0 dashboard  # 美化面板

# 或查看状态文件
cat ~/.openclaw/data/mem0/mem0-status.json
```

---

## 🛠️ 可用工具

| 工具 | 功能 | 智能特性 |
|:---|:---|:---|
| `memory_search` | 搜索记忆 | `deep: true` 穿透冷库 |
| `memory_store` | 存储记忆 | 自动去重、提取事实 |
| `memory_list` | 列出记忆 | 显示 `id + 摘要`，支持 `limit` |
| `memory_forget` | 删除记忆 | 支持 `query + deleteAll` 批量删除 |
| `memory_stats` | 🆕 状态统计 | Token、存储、队列信息 |

---

## 🔧 配置选项

### 极简模式（推荐）

```json
"openclaw-mem0": {
  "enabled": true
}
```

自动继承 OpenClaw 主 LLM 配置，开箱即用。

### 进阶模式

```json
"openclaw-mem0": {
  "enabled": true,
  "config": {
    "provider": "deepseek",
    "apiKey": "sk-xxx",
    "maxMemoryCount": 2000,
    "topK": 5,
    "searchThreshold": 0.5
  }
}
```

| 参数 | 说明 | 默认值 |
|:---|:---|:---|
| `provider` | LLM 提供商 (deepseek/moonshot/openai...) | 继承主配置 |
| `maxMemoryCount` | 热库最大记忆数 | 2000 |
| `topK` | 搜索返回数量 | 5 |
| `searchThreshold` | 相关度阈值 | 0.5 |

### MiniMax 推荐配置（避坑）

如果你使用 MiniMax，建议显式指定 `baseURL` 为 v2 聊天端点，避免返回 HTML 页面或空 JSON 导致事实提取失败：

```json
"openclaw-mem0": {
  "enabled": true,
  "config": {
    "provider": "minimax",
    "apiKey": "your-minimax-api-key",
    "baseURL": "https://api.minimaxi.com/v1/text/chatcompletion_v2",
    "model": "abab6.5-chat"
  }
}
```

补充说明：
- 插件已支持自动清理 `<think>`/`reasoning` 等思考内容，再做 JSON 解析。
- 当模型在 JSON 模式下返回空内容或无效 JSON 时，会自动降级为 `{}`，避免 `Unexpected end of JSON input` 中断写入。

### 自动捕捉调优（高级）

如果你发现自动捕捉太“敏感”或太“保守”，可以用以下环境变量微调：

| 变量名 | 说明 | 默认值 |
|:---|:---|:---|
| `MEM0_CAPTURE_BATCH_WINDOW_MS` | 批量窗口（毫秒） | `1200` |
| `MEM0_CAPTURE_BATCH_MAX_MSGS` | 每次写入最多消息条数 | `16` |
| `MEM0_CAPTURE_INPUT_MAX_MSGS` | 缓冲区保留的输入消息数 | `12` |
| `MEM0_CAPTURE_MAX_CHARS_PER_MSG` | 单条消息最大字符 | `500` |
| `MEM0_CAPTURE_MAX_TOTAL_CHARS` | 单批总字符预算 | `2600` |
| `MEM0_CAPTURE_MIN_CHARS` | 过滤超短低价值消息阈值 | `6` |
| `MEM0_CAPTURE_DUP_TTL_MS` | 重复批次去重 TTL（毫秒） | `600000` |
| `MEM0_CAPTURE_DUP_MAX` | 重复指纹缓存上限 | `1024` |

自动捕捉现在会优先过滤低信号回复、截断超长消息、跳过重复批次，并确保批次中至少包含用户消息，避免噪音写入。

---

## 🔄 版本历史

### v0.6.3 (兼容性修复)
- 🛟 **老版本救援**: 插件入口切换为桥接 `index.ts`，启动时可自动补齐缺失 `src/*` 文件，避免因部分更新直接崩溃。
- 🛠️ **拼写兼容**: 新增 `contextMenager.ts` 兼容别名，修复旧版错误导入导致的 `Cannot find module`。
- 🧰 **安装器增强**: 安装时自动清理旧目录 `openclaw-meme`，减少升级残留冲突。

### v0.6.2 (自动捕捉与可用性优化)
- 🆕 **自动捕捉降噪**: 增加低信号消息过滤、超长内容预算裁剪、重复批次去重（TTL 指纹），减少无效写入。
- 🆕 **删除体验增强**: `memory_list`/`memory_search` 直接展示 `id`，`memory_forget` 支持 `query + deleteAll` 批量删除。
- 🐛 **稳定性改进**: 自动捕捉仅在含用户消息时触发，并过滤大段结构化噪音，降低 JSON 解析异常概率。

### v0.6.1 (兼容性热修复)
- 🐛 修复部分模型在 `json_object` 模式下返回空内容导致 `Unexpected end of JSON input` 的问题（增加 JSON 兜底）。
- 🐛 修复部分错误 `baseURL` 返回 HTML（`<!DOCTYPE ...`）时的解析失败，错误信息更明确。
- ✅ MiniMax 端点规范化：默认与推荐配置统一到 `.../v1/text/chatcompletion_v2`。

### v0.6.0 (重大性能与兼容性更新)
- 🆕 **多格式远端 Embedding**: 支持 Gemini、Ollama、OpenAI 等多种远端向量模型，不再局限于本地运行。
- 🆕 **速度大幅提升**: 搜索请求并行化处理，增加搜索结果 LRU 缓存，对话捕获改为异步批处理。
- 🆕 **国产模型深度适配**: 增强了对 DeepSeek、Kimi、智谱、MiniMax、通义千问等国产模型的思考模式（Thinking/Reasoning）识别与过滤。
- 🆕 **反思引擎重构**: `ReflectionEngine` 现在复用统一 LLM 适配层，支持所有已配置的提供商。
- 🐛 **稳定性修复**: 补齐了自动更新漏掉的核心文件，修复了 SQLite 并发初始化锁竞争问题。

### v0.5.0 (通用模型支持)
- 🆕 **Universal LLM Support**: 支持所有 OpenAI 兼容的 LLM 提供商
- 🐛 修复 MiniMax 等国产模型不支持 `response_format: json_object` 的问题
- 🆕 自动检测提供商并应用 JSON 模式变通方案
- ✅ 已测试：MiniMax、DeepSeek、Moonshot、智谱、零一万物

### v0.4.9 (零配置增强)
- 🐛 修复 `{ "enabled": true }` 最小配置启动失败的问题
- 🆕 支持 OpenClaw 新版 `models.providers` 配置格式
- 🐛 修复 README 表格对齐问题

### v0.4.8 (智能优化)
- 🆕 **Smart Context Injection**: Token 预算管理，自动适配模型上下文
- 🆕 **Write Queue**: 并发写入保护，彻底解决 SQLITE_BUSY
- 🆕 **Status Dashboard**: 实时监控面板，CLI 命令增强

### v0.4.7 (稳定性)
- 🐛 修复 SQLITE_CANTOPEN 错误
- 🐛 修复自动更新死循环

### v0.4.6 (数据安全)
- 🆕 旧版 memory.md 数据迁移工具

### v0.4.5 (零配置)
- 🆕 自动继承主 LLM 配置

### v0.4.3 (深度检索)
- 🆕 冷库搜索功能

---

## 📄 License

Apache 2.0

---

## 🙏 致谢

- [Mem0](https://github.com/mem0ai/mem0) - 核心记忆引擎
- [OpenClaw](https://github.com/qingchencloud/openclaw) - 宿主平台
