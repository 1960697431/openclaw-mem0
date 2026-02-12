# 🧠 OpenClaw 长期记忆插件 (Mem0)

> **让你的 AI 助手拥有“大象般的记忆”与“猎豹般的速度”。**
> 基于 Mem0 构建的下一代智能记忆系统，支持语义搜索、自动归档与主动提醒。

<p align="center">
  <img src="assets/architecture.png" alt="架构图" width="700" />
</p>

---

## ⚡ 极速安装 (v0.4.6+)

**只需运行这一行命令，剩下的全自动完成（包括配置启用）：**

```bash
curl -sL https://raw.githubusercontent.com/1960697431/openclaw-mem0/main/install.sh | bash
```

**安装脚本会自动：**
1. 下载并安装插件
2. **自动修改** `openclaw.json` 启用插件
3. 自动继承你的主 LLM 配置
4. 自动禁用 OpenClaw 自带的旧版记忆功能（防止冲突）

**安装完成后，直接重启 Gateway 即可：**
```bash
openclaw gateway restart
```

*首次启动会自动下载嵌入模型（约 417MB，国内加速），请耐心等待几分钟。*

---

## 🔄 从旧版本升级

如果你是 **v0.3.x 或更早版本**的用户，为了确保获得最新的架构和自动修复功能，**强烈建议**重新运行一次上方的安装脚本：

```bash
curl -sL https://raw.githubusercontent.com/1960697431/openclaw-mem0/main/install.sh | bash
```
*(放心：这只会升级代码结构，**绝不会删除**你现有的记忆数据)*

---

## 🔧 进阶配置（可选）

如果你想让记忆插件使用**独立**的模型（例如：主程序用 GPT-4o，记忆整理用便宜的 DeepSeek），可以添加 `config` 字段：

```json
"openclaw-mem0": {
  "enabled": true,
  "config": {
    "provider": "deepseek",
    "apiKey": "sk-xxxxxxxxxxxxxxxx"
  }
}
```

| 参数 | 说明 |
| :--- | :--- |
| `provider` | 支持 `deepseek`, `ollama`, `openai`, `moonshot`, `dashscope` 等，自动补全 URL。 |
| `maxMemoryCount` | **(重要)** 默认为 `2000`。超过此数量的记忆会被移入冷库（文件归档），防止内存爆炸。 |

---

## 🌟 核心优势：为什么选择这个插件？

大多数记忆插件面临一个两难困境：**存得越多，系统越慢。**
我们通过独创的 **“冷热分离架构 (Hot/Cold Architecture)”** 完美解决了这个问题。

### 1. 🔥 热库 + 🧊 冷库：永不卡顿
| 特性 | 🔥 **热库 (Vector DB)** | 🧊 **冷库 (Archive)** |
| :--- | :--- | :--- |
| **内容** | 最近、最活跃的记忆 | 所有的历史记忆 (无限容量) |
| **速度** | **毫秒级** (语义搜索) | 秒级 (深度扫描) |
| **内存占用** | 固定 (约 1.5GB) | **接近 0** |
| **自动维护** | 超过 2000 条自动“退休”到冷库 | 永久保存，数据永不丢失 |

### 2. 🕵️ 深度检索 (Deep Search)
如果热库里找不到？
AI 会像人类一样思考：**“这事儿好像很久以前提过...”**，然后自动开启 **Deep Search** 模式去翻阅冷库归档。绝不错过任何细节，也绝不浪费资源。

### 3. 🧠 主动大脑 (Active Brain)
- **持久化待办**：从对话中捕捉“明天提醒我...”的意图，并保存到磁盘。重启不忘。
- **三级推送**：支持 Telegram/飞书/微信 等渠道的主动推送。

---

## 🛠️ CLI 与工具

| 工具 | 说明 | 智能特性 |
| :--- | :--- | :--- |
| `memory_search` | 搜索记忆 | 支持 `deep: true` 参数，穿透热库直达冷库 |
| `memory_store` | 存储记忆 | 自动去重，提取关键事实 |
| `memory_list` | 列出记忆 | 支持按 Session 或 Long-term 筛选 |
| `memory_forget` | 遗忘记忆 | 真正的删除（GDPR 合规） |

---

## 🔄 版本历史

### v0.4.6 (数据安全)
- **Data Migration**: 新增 `import-legacy` 工具，支持从旧版 `memory.md` 迁移数据。
- **Hotfix**: 修复了自动更新时的文件缺失隐患。

### v0.4.5 (零配置)
- **Zero Config**: 自动继承 OpenClaw 主 LLM 配置，实现安装即用。
- **Auto Fix**: 增强配置纠错能力。

### v0.4.3 (深度检索)
- **Deep Search**: 引入冷库流式搜索，AI 可按需查阅历史归档。

### v0.4.2 (安全修剪)
- **Safe Pruning**: 记忆修剪升级为“先归档，后删除”，彻底解决数据丢失焦虑。

### v0.4.0 (重构版)
- **架构升级**: 模块化重构，支持持久化大脑。

---

## 📄 License

Apache 2.0
