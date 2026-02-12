# 🧠 OpenClaw Mem0 智能记忆插件

> **让 AI 拥有长期记忆，同时节省 70% 的 Token 消耗**

基于 Mem0 构建的下一代智能记忆系统，专为 OpenClaw 设计。

<p align="center">
  <img src="https://img.shields.io/badge/version-0.5.0-blue.svg" alt="Version" />
  <img src="https://img.shields.io/badge/OpenClaw-2026.2+-green.svg" alt="OpenClaw" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-orange.svg" alt="License" />
</p>

---

## ⚡ 30 秒极速安装

```bash
curl -sL https://raw.githubusercontent.com/1960697431/openclaw-mem0/main/install.sh | bash
```

安装完成后重启 Gateway：
```bash
openclaw gateway restart
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
| `memory_list` | 列出记忆 | 按 Session/Long-term 筛选 |
| `memory_forget` | 删除记忆 | 先归档再删除 |
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

---

## 🔄 版本历史

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
