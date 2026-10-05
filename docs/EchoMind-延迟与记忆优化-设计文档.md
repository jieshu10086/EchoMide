# EchoMind 延迟优化与记忆模块重构 设计文档

| 项 | 内容 |
| --- | --- |
| 文档版本 | v1.0（草案，待评审） |
| 编写日期 | 2026-10-04 |
| 适用系统 | EchoMind 智能客服（Python 版后端 + Vue 前端） |
| 涉及仓库 | `EchoMind/`（后端）、`EchoMindFrontend/`（前端），两者同属 `EchoMind所有代码+简历/` |
| 涉及模块 | `api/`、`agents/`、`core/`、`memory/`、`mcp/`、`monitor/`、`skills/` |
| 目标读者 | 后端开发、前端开发、项目负责人 |

> 说明：本文档中的路径均以 `EchoMind所有代码+简历/` 为根，例如 `EchoMind/api/main.py:270` 表示后端仓库中该文件第 270 行。所有实测数据采集自 2026-10-04 本机运行中的容器环境。

#### 一、背景与现状

##### 1.1 实测性能数据

（1）采集方式：容器 `echomind-app` 运行中，直接调用只读监控接口。

```bash
curl -s http://127.0.0.1:8000/monitor
```

（2）采集结果：

| 指标 | 实测值 | 系统阈值 | 结论 |
| --- | --- | --- | --- |
| `billing_0.avg_ms`（账单 Agent） | **8589.9 ms** | 3000 ms（WARNING） | 严重超标 |
| `general_0.avg_ms`（通用 Agent） | 2808.1 ms | 3000 ms | 临界 |
| `technical_0` | 无样本 | 3000 ms | — |
| `knowledge_search.avg_latency_ms` | **60.9 ms** | 5000 ms（ERROR） | 非瓶颈 |
| 活动告警条数 | 10 条（内容重复） | — | 缺少告警去重 |

（3）结论：**瓶颈完全在 LLM 调用环节，不在检索。** 向量检索只占 60 ms 左右，而账单类问题端到端要 8.6 秒。

##### 1.2 一次 `/chat` 请求的完整调用链

（1）现状链路（`EchoMind/api/main.py:258` 起）：

| 顺序 | 阶段 | 代码位置 | 是否调用 LLM | 输出上限 |
| --- | --- | --- | --- | --- |
| 1 | 读取记忆上下文 | `api/main.py:273` | 否 | — |
| 2 | 意图识别（三路投票，LLM 路**无条件执行**） | `core/intent_recognizer.py:272` | **是** | 256 |
| 3 | 查询改写（生成 3 个子查询） | `mcp/tool_manager.py:299` | **是** | 256 |
| 4 | 并行向量召回 + 去重 | `mcp/tool_manager.py:330` | 否 | — |
| 5 | 结果重排（LLM 打分） | `mcp/tool_manager.py:378` | **是** | 256 |
| 6 | 主回答生成 | `agents/agent_orchestrator.py:179` | **是** | 1024 |
| 7 | 写入工作记忆（含满 15 条触发的压缩） | `api/main.py:305-306`、`memory/conversation_memory.py:157` | **是**（压缩时） | 256 |
| 8 | 异步更新用户画像 | `api/main.py:309` | **是**（每轮都跑） | 512 |

（2）关键事实：

- **一次业务类提问最多串行触发 4~5 次 LLM 往返**，且全部使用同一个模型（`ANTHROPIC_MODEL=deepseek-v4-pro`，见 `EchoMind/.env`）。
- **全项目没有流式输出**：搜索 `StreamingResponse` 无结果，用户必须等整段生成完毕。
- **第 7 步的记忆压缩是 `await` 阻塞的**：`memory/conversation_memory.py:157` 在消息数达到 15 时同步调用 `_compress()`，会给该轮响应额外增加一次 LLM 往返。
- **第 8 步的画像更新每轮请求都执行**：`api/main.py:309` 用 `asyncio.create_task` 不阻塞响应，但**没有任何节流**，等于每轮白烧一次 LLM 调用。

##### 1.3 记忆模块现状

（1）三级存储的实际分工：

| 存储 | 内容 | Key / 集合 | 生命周期 | 实测现状 |
| --- | --- | --- | --- | --- |
| Redis | 最近对话（工作记忆） | `wm:{user_id}:{conv_id}` | TTL 86400s | 有 1 个 key，`llen=10`，TTL≈19h |
| Redis | **会话摘要**（累积拼接） | `summary:{user_id}:{conv_id}` | TTL 86400s | 尚未生成 |
| ChromaDB | 情景记忆（压缩产出的摘要片段） | 集合 `episodic` | 永久 | **0 条** |
| ChromaDB | 用户画像 | 集合 `user_profile` | 永久 | 1 条 |
| ChromaDB | 知识库（RAG） | 集合 `knowledge_base` | 永久 | 6 条 |

（2）三个关键常量（`memory/conversation_memory.py:83-85`）：

- `WORKING_MAX = 20`：每次读取工作记忆的上限
- `COMPRESS_AT = 15`：消息数达到 15 触发压缩
- 压缩后保留最近 5 条，`HISTORY_TOP_K = 5`：情景记忆检索返回条数

（3）摘要的写入是**双写**（`memory/conversation_memory.py:269-275`）：

```python
# ① 写 Redis：累积拼接（注意不是覆盖）
new_summary = self._safe_text(f"{old_summary}\n{summary}").strip()
await self._redis.setex(skey, 86400, new_summary)

# ② 写 ChromaDB：作为一条情景记忆文档，但 documents 存的是摘要而非原文
await self._store_episodic(user_id, conv_id, text, summary)   # documents=[summary]
```

（4）注入主回答的 `[背景信息]` 由四段组成（`memory/conversation_memory.py:60-73`）：

| 注入段 | 来源 | 取值方式 |
| --- | --- | --- |
| `[会话摘要]` | Redis `summary:*` | **直接取**，无条件注入 |
| `[相关历史]` | Chroma `episodic` | **语义检索**（top-5 取前 3） |
| `[用户画像]` | Chroma `user_profile` | **直接取**（`get(where user_id, limit=1)`） |
| `[最近对话]` | Redis `wm:*` | **直接取** |

> tip：四段中只有 `[相关历史]` 走语义检索，另外三段都是按 key 直接取。这一点容易误解，评审时需注意。

##### 1.4 问题清单

| 编号 | 问题 | 严重度 | 证据位置 |
| --- | --- | --- | --- |
| P1 | 一次请求 4~5 次串行 LLM 调用，全部使用大模型 | 高 | §1.2 |
| P2 | 无流式输出，用户需等待整段生成 | 高 | 全项目无 `StreamingResponse` |
| P3 | 会话边界缺失：`conv_id` 永久复用，记忆只增不减 | 高 | `EchoMindFrontend/src/App.vue:220` |
| P4 | 情景记忆检索**无相似度阈值**，永远返回 5 条 | 高 | `memory/conversation_memory.py:304-321` |
| P5 | 摘要双写且语义分叉：Redis 是累积长文，Chroma 是碎片 | 中 | §1.3（3） |
| P6 | 摘要 TTL 只在压缩时续期，慢节奏长会话会静默丢失中段记忆 | 中 | `:154` 对比 `:272` |
| P7 | 摘要只增不减（无长度上限），越用越长、越用越串味 | 中 | `:271` |
| P8 | 情景记忆的 `metadata.full_text` 存了但从未被读取 | 低 | `:337`（仅写入处出现） |
| P9 | 技能注入是硬截断，可能切掉文末的"禁止事项"安全条款 | 低 | `core/skill_loader.py:142` |
| P10 | 画像更新无节流，每轮多烧一次 LLM | 中 | `api/main.py:309` |

> 待确认：P3 相关的"会话边界"预期行为需要产品确认——用户主动换话题时，是**自动开新会话**还是**弹提示让用户选择**。

#### 二、优化目标与验收

##### 2.1 量化目标

| 目标项 | 现状 | 目标值 | 测量方式 |
| --- | --- | --- | --- |
| 业务类问答 P50 延迟 | 8589.9 ms | **≤ 3000 ms** | `/monitor` 的 `agent_avg_ms` |
| 单次请求 LLM 往返次数 | 4~5 次 | **≤ 2 次** | 日志计数（按 `call_id` 聚合） |
| 首字可见时间（流式后） | 等同总耗时 | **≤ 1000 ms** | 前端埋点 |
| 无关历史注入 | 每次必注入 3 条 | **0 条** | `[相关历史]` 为空的比例 |
| 新会话串味 | 无法隔离 | 新会话不携带旧话题摘要与历史 | 回归用例 |
| 检索误召 | 无阈值，恒返回 | 距离超阈值即丢弃 | 灰度日志统计 |

##### 2.2 验收方法

（1）构造固定回归集（20 问），分三类：

- 账单类 10 问（命中 `billing_support` 技能）
- 技术类 5 问
- 寒暄 / 话题切换 5 问（用于串味回归）

（2）每类连续跑 3 轮，记录 P50 / P90：

```bash
# 逐条调用并记录端到端耗时
curl -s -o /dev/null -w '%{time_total}\n' -X POST http://127.0.0.1:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"我上个月被重复扣款了，怎么办","user_id":"u1001"}'
```

（3）串味回归用例（关键）：先问账单问题 → 再问"今天天气怎么样" → 检查后端日志中 `[相关历史]` 是否为空、`[会话摘要]` 是否包含账单内容。

（4）质量回归：调用既有评测接口，避免"为了快而变傻"。

```bash
curl -X POST http://127.0.0.1:8000/eval/run
```

##### 2.3 范围边界

（1）本期**做**：LLM 调用裁剪、流式输出、会话边界、检索阈值、摘要与原文分离、摘要生命周期治理。

（2）本期**不做**（记录为后续项）：API 鉴权与多租户隔离、向量库选型更换、多语言支持、前端整体重构。

> tip：当前后端**无任何鉴权**且 CORS 为 `allow_origins=["*"]`（`EchoMind/api/main.py:197-202`），而记忆按 `user_id` 分区，`user_id` 完全由客户端传入。这属于独立的安全议题，不塞进本期范围，但建议单独立项。

#### 三、方案一：减少 LLM 调用

##### 3.1 改造项总览

| 编号 | 改造项 | 省下的 LLM 往返 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- |
| L1 | 意图识别改为"规则/向量优先，低置信度才调 LLM" | 1 次（约 1~3s） | 小 | P1 |
| L2 | 结果重排默认关闭 LLM 打分 | 1 次（约 1~3s） | 小 | P1 |
| L3 | 查询改写默认单查询 + 结果缓存 | 1 次（约 1~3s） | 小 | P1 |
| L4 | 记忆压缩改为后台任务 | 偶发 1 次 | 极小 | P0 |
| L5 | 画像更新加节流 | 降低平均成本 | 小 | P1 |
| L6 | 模型分档：旁路环节换小模型 | 每往返降 30%~60% | 小 | P1 |
| L7 | 流式输出（SSE） | 不减少总耗时，**大幅降低感知延迟** | 中 | P2 |
| L8 | 输出长度按意图分档 | 直接缩短主生成耗时 | 小 | P2 |
| L9 | RAG 与意图识别并行、两次记忆写入合并 | 小幅 | 小 | P2 |

##### 3.2 逐项改造方案

**（1）L1 意图识别裁剪**

现状（`core/intent_recognizer.py:186-200`）为三路投票，但 LLM 路**无条件发起**：

```python
llm_task = asyncio.create_task(self._llm_recognize(message, history))
emb_task = asyncio.create_task(self._embedding_recognize(message)) if self._embedding_enabled else None
pat      = self._pattern_recognize(message)
```

目标改为"规则/向量先判，只有低置信度才调 LLM"（示意代码）：

```python
pat = self._pattern_recognize(message)
emb = await self._embedding_recognize(message) if self._embedding_enabled else {"confidence": 0.0}
if pat["confidence"] >= 0.80 or emb["confidence"] >= 0.75:
    llm = {"intent": None, "confidence": 0.0, "reasoning": "规则/向量直接判定"}
else:
    llm = await self._llm_recognize(message, history)   # 仅仲裁时调用
```

> tip：新增开关 `INTENT_LLM_MODE`（`off` / `auto` / `always`），默认 `auto`，出问题可一键回退到 `always` 保持旧行为。

**（2）L2 结果重排**

现状问题：`_rerank` 的触发条件是 `len(items) > top_k`（`mcp/tool_manager.py:363`），而召回宽度是 `recall_k = max(top_k, 5)`（`:329`），当 `top_k=3` 时**必然触发**，等于每次请求都多一次 LLM 调用。

改法（任选其一，建议同时做）：

- 引入 `RERANK_MIN_CANDIDATES`（默认 8）：候选不足 8 条时直接用向量距离排序；
- 提供 `RERANK_MODE=off/auto`，`off` 时只用向量分数。

**（3）L3 查询改写**

现状：`rewrite_query(query, n=3)`（`mcp/tool_manager.py:282`、调用处 `:325`）每次请求一次 LLM。

改法：默认 `n=1`（即不改写），仅当首轮召回结果 < 2 条时才触发改写；同时按 query 指纹做结果缓存（可复用现有 `_cache` 机制）。

**（4）L4 记忆压缩改后台**

```python
# 现状（阻塞响应）
if await self._redis.llen(key) >= self.COMPRESS_AT:
    await self._compress(user_id, conv_id)

# 目标（不阻塞响应）
if await self._redis.llen(key) >= self.COMPRESS_AT:
    asyncio.create_task(self._compress(user_id, conv_id))
```

> tip：副作用是摘要延迟生效（下一轮才可见），可接受；需保证并发压缩有锁，避免同一会话重复压缩。

**（5）L5 画像更新节流**

现状：`api/main.py:309` 每轮都触发（内部一次 `max_tokens=512` 的 LLM 调用，见 `memory/conversation_memory.py:180`）。

改法：满足任一条件才更新——每 N 轮（建议 5）或检测到消息中新增实体；也可改为"会话结束/超时"时统一更新一次。新增 `PROFILE_UPDATE_EVERY` 配置。

**（6）L6 模型分档**

新增 `SMALL_MODEL` 配置（默认沿用 `ANTHROPIC_MODEL`），以下 5 处改用小模型：

| 用途 | 位置 |
| --- | --- |
| 意图识别 | `core/intent_recognizer.py:272` |
| 查询改写 | `mcp/tool_manager.py:299` |
| 结果重排 | `mcp/tool_manager.py:378` |
| 记忆压缩摘要 | `memory/conversation_memory.py:260` |
| 用户画像提炼 | `memory/conversation_memory.py:180` |

主回答生成（`agents/agent_orchestrator.py:179`）保持使用大模型。

> 待确认：DeepSeek 侧可用的"小模型"具体型号与价格，需按实际账号可用模型清单确认。

**（7）L7 流式输出**

（1）后端新增流式端点 `POST /chat/stream`，使用 `client.messages.stream(...)` + `StreamingResponse(media_type="text/event-stream")`。

（2）事件约定建议：

```
event: meta     data: {"conv_id":"...","intent":"billing","agent_type":"billing"}
event: delta    data: {"text":"..."}
event: done     data: {"latency_ms":1234,"knowledge_used":true}
```

（3）前端配合：`EchoMindFrontend/src/App.vue` 增加流式渲染分支，保留原非流式调用作为降级（`STREAM_ENABLED` 开关）。

**（8）L8 输出长度按意图分档**

（1）主生成 `max_tokens=1024`（`agents/agent_orchestrator.py:181`）改为按意图分档，例如寒暄 200 / 技术 600 / 账单 800。

（2）在各 `SKILL.md` 的"回复格式要求"中追加字数约束（如"回答控制在 300 字以内，分点陈述"），从提示词侧压缩输出长度。

**（9）L9 并行与合并**

（1）把 RAG 构建（`api/main.py:282`）与意图识别（`:281`）改为并发执行；注意 RAG 依赖意图做"是否检索"判断，可先以规则判断发起，意图结果到达后再决定是否采用。

（2）两次 `add_message`（`:305-306`）合并为一次批量写入或后台任务。

##### 3.3 收益预估

| 阶段 | 组合 | 预计 LLM 往返 | 预计 P50 |
| --- | --- | --- | --- |
| 现状 | — | 4~5 次 | 8589.9 ms |
| 阶段一 | L1+L2+L3+L4+L5+L6 | **2 次** | 约 2800~3500 ms |
| 阶段二 | 阶段一 + L8 + L9 | 2 次 | 约 2000~2800 ms |
| 阶段三 | 阶段二 + L7（流式） | 2 次 | 总耗时同前，**首字 ≤1s** |

> tip：以上为基于实测分项的估算，需在灰度环境用 §2.2 的方法实测校正。

#### 四、方案二：记忆模块重构

##### 4.1 目标架构与职责划分

| 存储 | 内容 | 表示形式 | 生命周期 | 用途 |
| --- | --- | --- | --- | --- |
| Redis `wm:{user}:{conv}` | 最近对话**原文** | 消息列表 | 24h（每条消息续期） | 当前会话的精确连续性 |
| Redis `summary:{user}:{conv}` | 当前会话摘要（**有长度上限**） | 文本 | 24h（与 `wm` 同步续期） | 当前会话的话题连贯性 |
| Chroma `episodic` | 情景记忆：**摘要作向量 + 原文作载荷** | `documents`=摘要，`metadatas.full_text`=原文 | 永久 + 时间衰减 | 跨会话语义召回 |
| Chroma `user_profile` | 用户画像 | JSON 字符串 | 永久（按需刷新） | 跨会话个性化 |
| Chroma `knowledge_base` | 知识库 | 分块文本 | 永久 | RAG |

核心原则：**短期层存"事实与原文"，长期层存"抽象与索引"；两份副本的职责必须不同，而不是同一份文本存两遍。**

##### 4.2 会话边界（解决 P3）

（1）四种触发方式，建议全部实现，按优先级落地：

| 方式 | 触发条件 | 实现位置 | 说明 |
| --- | --- | --- | --- |
| 手动新建 | 用户点击"新会话" | 前端 | 最小改动，先做 |
| 空闲超时 | 距上条消息 > `SESSION_IDLE_MINUTES`（默认 30） | 前端（记 `lastMessageAt`） | 覆盖"过一会儿再来" |
| 结束语检测 | 命中"谢谢/解决了/没问题/好的"等 | 后端（零额外 LLM 调用，可复用已算出的意图） | 语义最准 |
| 话题漂移 | 新消息向量与会话内最近 N 条相似度低于阈值 | 后端（复用现成 embedding） | 最智能，最后做 |

（2）前端最小实现（`EchoMindFrontend/src/App.vue`）：

```javascript
function newSession() {
  settings.conversationId = ''
  messages.value = []
  lastMessageAt = 0
  persist()
}

// 发送前检查空闲超时
const IDLE_MS = 30 * 60 * 1000
if (lastMessageAt && Date.now() - lastMessageAt > IDLE_MS) {
  settings.conversationId = ''   // 触发后端生成新 conv_id
}
```

（3）后端结束语检测建议返回给前端一个 `session_closed: true` 标记，由前端在下次发送前重置 `conversationId`，避免后端单方面切换导致前端状态不一致。

##### 4.3 检索阈值（解决 P4）

（1）现状：`memory/conversation_memory.py:311-318` 只读 `documents`，丢弃 `distances`，因此无论相关与否都返回 5 条。

（2）实测锚点（2026-10-04，集合 `knowledge_base`，6 条数据）：

```text
query: "退款怎么处理"
documents: ['订单查询指南。用户可以通过订单号查询订单状态...', '账户安全说明。建议用户定期修改密码...']
distances: [1.2472, 1.2479]
```

两条结果均与"退款"无关，却照常返回；且两条距离差仅 0.0007，说明模型无法区分。**当前集合为 L2 距离（`get_or_create_collection` 未指定 `hnsw:space`，使用 Chroma 默认 l2），数值越小越相似。**

（3）改造（示意代码）：

```python
EPISODIC_MAX_DISTANCE = 1.1      # L2 距离上限，需按灰度数据校准

docs  = (results.get("documents") or [[]])[0]
dists = (results.get("distances") or [[]])[0]

kept = [d for d, dist in zip(docs, dists)
        if dist is None or dist <= self.EPISODIC_MAX_DISTANCE]
```

（4）灰度策略（必须）：先上线 `EPISODIC_LOG_ONLY=true`，只打印每条距离与保留结果、不做拦截，观察 1~2 天后再启用拦截。

> tip：`[会话摘要]`、`[最近对话]`、`[用户画像]` 三段是当前会话的确定性内容，**不应**套用相似度阈值；阈值只用于 `[相关历史]`。

##### 4.4 摘要与原文分离（解决 P5、P8）

（1）定案方案：**摘要留在 `documents`（向量来源），原文放 `metadatas.full_text`（返回内容）**。理由是向量由 `documents` 编码生成，谁进 `documents` 谁就决定检索质量；而 metadata 不参与语义匹配，只作载荷。

（2）写入改造：

```python
await asyncio.to_thread(
    self._episodic.add,
    ids=[doc_id],
    documents=[summary],                 # 向量来自摘要 → 语义表征干净、不截断
    metadatas=[{
        "user_id": user_id,
        "conv_id": conv_id,
        "ts": datetime.now().isoformat(),
        "full_text": text,               # 原文完整保留（去掉原 [:500] 截断）
    }],
)
```

（3）读取改造：

```python
docs  = (results.get("documents") or [[]])[0]
metas = (results.get("metadatas") or [[]])[0]
return [(m or {}).get("full_text") or d for d, m in zip(docs, metas)]
```

（4）选型说明（评审要点）：

| 方案 | `documents` | 向量来源 | 原文位置 | 结论 |
| --- | --- | --- | --- | --- |
| 甲（推荐） | 摘要 | 自动来自摘要 | `metadatas.full_text` | 改动小、无踩坑风险 |
| 乙 | 原文 | 显式传 `embeddings=[ef(摘要)]` | `documents` | 语义更规范，但写入与查询两侧都要改，且**忘传 `embeddings` 会静默劣化** |

（5）补充硬约束（已实测）：默认 embedding 模型为 `ONNXMiniLM_L6_V2`，`tokenizer` 的 `model_max_length = 512`，且为英文词表（中文 token 效率低）。原文若进 `documents`，超长部分会被截断，检索只能看到开头片段——这是选择方案甲的技术依据。

##### 4.5 摘要生命周期治理（解决 P6、P7）

（1）**TTL 统一**：现状摘要仅在压缩时 `setex`（`memory/conversation_memory.py:272`），工作记忆则每条消息续期（`:154`）→ 慢节奏长会话中摘要会先过期，导致中段记忆静默丢失。改法：在 `add_message` 中同时续期 `summary` key，或让摘要 TTL ≥ 工作记忆 TTL。

（2）**长度上限**：

```python
SUMMARY_MAX_CHARS = 1200
new_summary = f"{old_summary}\n{summary}".strip()
if len(new_summary) > SUMMARY_MAX_CHARS:
    new_summary = new_summary[-SUMMARY_MAX_CHARS:]   # 保留最近内容
```

（3）**方向性改造（可选，中长期）**：由"单条累积摘要"改为"话题级多条摘要"（每次压缩产生带话题标签的独立摘要，按相关性注入），从根上解决多话题混合污染。

（4）**摘要失败降级**：现状摘要生成失败时写入固定文案 `对话包含 N 条消息（摘要生成失败）`（`:266-267`），该文案会被当作检索材料写入 Chroma，向量无信息量。改法：失败时不写摘要向量（跳过本次情景记忆写入，或降级用原文建向量）。

##### 4.6 长期层衰减与用户可控（中长期）

（1）**时间衰减**：`metadatas.ts` 已存在，可用于召回排序加权（越久权重越低），避免陈旧一次性事实长期占据上下文。

（2）**删除能力（合规刚需）**：新增接口便于用户查看与删除自己的记忆：

```text
GET    /memory/{user_id}/{conv_id}      # 查看摘要与最近对话
DELETE /memory/{user_id}                # 清空该用户的情景记忆与画像
```

> 待确认：是否需要在删除时同步清理 Chroma 中 `episodic`、`user_profile` 以及 Redis 中的 `wm`、`summary`（建议全部清理，并记录审计日志）。

#### 五、实施计划、验证与风险

##### 5.1 分阶段计划

| 阶段 | 内容 | 涉及文件 | 验收 | 回滚 |
| --- | --- | --- | --- | --- |
| **P0（当天，止血）** | L4 压缩转后台；原文去截断 + 读取 `full_text`；阈值先"只记日志" | `memory/conversation_memory.py` | 压缩不再阻塞；日志出现距离分布 | 配置开关关闭 |
| **P1（1~2 天）** | L1 意图裁剪、L2 重排降级、L3 改写降级、L5 画像节流、L6 模型分档 | `core/intent_recognizer.py`、`mcp/tool_manager.py`、`api/main.py` | `agent_avg_ms` ≤3000 | `INTENT_LLM_MODE=always`、`RERANK_MODE=auto` |
| **P2（1~2 天）** | 会话边界：前端"新会话"按钮 + 空闲超时；后端结束语检测 | `EchoMindFrontend/src/App.vue`、`api/main.py` | 串味回归用例通过 | 前端隐藏按钮 |
| **P3（2~3 天）** | L7 流式输出 + L8 输出长度分档 + L9 并行化 | `api/main.py`、`agents/agent_orchestrator.py`、`skills/*/SKILL.md`、前端 | 首字 ≤1s | `STREAM_ENABLED=false` |
| **P4（后续）** | 话题漂移检测；摘要话题化；时间衰减；记忆查看/删除接口 | `memory/`、`api/main.py` | 单独验收 | 按接口粒度回退 |

##### 5.2 数据结构与配置项变更

（1）Redis Key 约定（保持不变，补充续期语义）：

| Key | 类型 | TTL | 变更 |
| --- | --- | --- | --- |
| `wm:{user_id}:{conv_id}` | list | 86400s，每条消息续期 | 无 |
| `summary:{user_id}:{conv_id}` | string | 86400s，**改为每条消息同步续期** | 有 |

（2）Chroma `episodic` 文档结构：

| 字段 | 内容 | 变更 |
| --- | --- | --- |
| `documents` | 摘要 | 不变（向量来源） |
| `metadatas.user_id` | 用户标识 | 不变 |
| `metadatas.conv_id` | 会话标识 | 不变 |
| `metadatas.ts` | 写入时间 | 不变（可用于衰减） |
| `metadatas.full_text` | **完整原文** | **去掉 500 字截断，并在检索时读取** |

（3）新增环境变量（`EchoMind/.env`）：

| 变量 | 建议默认 | 说明 |
| --- | --- | --- |
| `SMALL_MODEL` | 待确认 | 旁路环节使用的小模型 |
| `INTENT_LLM_MODE` | `auto` | `off`/`auto`/`always` |
| `RERANK_MODE` | `auto` | `off`/`auto` |
| `RERANK_MIN_CANDIDATES` | `8` | 候选少于此值不重排 |
| `REWRITE_MIN_RESULTS` | `2` | 召回少于该值才改写查询 |
| `PROFILE_UPDATE_EVERY` | `5` | 画像更新间隔轮数 |
| `EPISODIC_MAX_DISTANCE` | `1.1` | 情景记忆 L2 距离上限 |
| `EPISODIC_LOG_ONLY` | `true` | 灰度期只记日志不拦截 |
| `SUMMARY_MAX_CHARS` | `1200` | 会话摘要长度上限 |
| `SESSION_IDLE_MINUTES` | `30` | 空闲切会话阈值 |
| `STREAM_ENABLED` | `false` | 流式输出开关 |

##### 5.3 接口变更

（1）`POST /chat` 响应新增可观测字段（向后兼容，均为可选）：

```json
{
  "conv_id": "...",
  "session_closed": false,
  "history_kept": 2,
  "history_dropped_by_threshold": 3,
  "llm_calls": 2,
  "used_summary": true
}
```

（2）新增 `POST /chat/stream`（SSE）、`GET /memory/{user_id}/{conv_id}`、`DELETE /memory/{user_id}`。

##### 5.4 关键代码位置索引

| 关注点 | 位置 |
| --- | --- |
| 主流程编排 | `EchoMind/api/main.py:258-328` |
| LLM 调用点（6 处） | `core/intent_recognizer.py:272`、`mcp/tool_manager.py:299`、`:378`、`agents/agent_orchestrator.py:179`、`memory/conversation_memory.py:180`、`:260` |
| 记忆常量 | `memory/conversation_memory.py:83-85` |
| 记忆读取 | `memory/conversation_memory.py:210-237` |
| 压缩与双写 | `memory/conversation_memory.py:241-285` |
| 情景记忆检索 | `memory/conversation_memory.py:304-321` |
| 情景记忆写入 | `memory/conversation_memory.py:323-341` |
| 上下文拼装 | `memory/conversation_memory.py:60-73` |
| 技能注入 | `agents/agent_orchestrator.py:187-194`、`core/skill_loader.py:122-160` |
| 技能截断 | `core/skill_loader.py:142` |
| 监控阈值 | `monitor/performance_monitor.py:117-118` |
| 前端会话 ID | `EchoMindFrontend/src/App.vue:42`、`:220-221` |

##### 5.5 风险与回滚

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 阈值误杀相关历史 | 回答质量下降 | 先 `EPISODIC_LOG_ONLY=true` 灰度 1~2 天，按距离分布定值 |
| 小模型降低意图准确率 | 路由错误 | `/eval/run` 回归；准确率下降 >3% 即回退 `SMALL_MODEL` |
| 意图裁剪漏判 | 误路由 | 默认 `auto`，保留 `always` 一键回退 |
| 压缩转后台导致并发重复压缩 | 摘要重复/错乱 | 每会话加锁（Redis 分布式锁或进程内锁） |
| 流式改造影响前端渲染 | 页面报错 | 保留非流式端点；`STREAM_ENABLED` 开关 |
| 原文进 metadata 体积增大 | 返回包变大 | 单条字符上限（建议 800~1200 字）+ 条数上限 3 条 |
| 改动面较大 | 回归成本 | 全部改动走环境变量开关，默认保持原行为 |

统一回滚方式：

```bash
cd EchoMind
# 关闭所有新特性开关，恢复旧行为
# 编辑 .env 后重启应用容器
docker compose up -d echomind
```

##### 5.6 待确认项

（1）DeepSeek 账号可用的"小模型"型号与价格（影响 L6 收益）。

（2）`EPISODIC_MAX_DISTANCE` 的最终取值（依赖灰度距离分布，实测锚点：无关结果约 1.24~1.25）。

（3）话题切换的交互形态：自动开新会话，还是提示用户确认。

（4）记忆删除接口是否需要覆盖 Redis 与 Chroma 全量数据，以及是否保留审计日志。

（5）是否将 `[用户画像]` 纳入"可衰减"范围（画像属于长期抽象，通常不建议衰减，需产品确认）。
