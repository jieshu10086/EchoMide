# EchoMind 智能客服系统 —— 作品说明

> 技术栈：Python ｜ FastAPI + Anthropic SDK + Redis + ChromaDB + Vue 3

---

## 1. 项目背景

### 1.1 项目定位

**EchoMind 是一个面向企业客服场景的多 Agent 编排运行时（Multi-Agent Orchestration Runtime）。**

它不是"用户问一句、机器人答一句"的单轮问答 Demo，而是把企业运营请求拆成一条**可治理、可观测、可评测、可迭代**的工程链路：

```
EchoMind = 细粒度意图识别 + 按意图触发的 RAG + 三级记忆
         + 结构化多 Agent 主辅路由 + 动态 Skills 注入
         + MCP 工具可靠性治理 + Monitor 在线降权闭环
         + LLM-as-Judge 端到端评测
```

### 1.2 为什么做这个项目

**企业客服的真实瓶颈不在"回答"，而在"链路"。** 企业日常运营会持续收到跨部门、跨系统、跨规则的问题，涉及客户成功、技术支持、财务运营、运营管理四类角色。传统人工分流链路是：

```
用户问题 → 一线人员判断 → 查知识库 → 问技术/财务 → 手工回复 → 人工复盘
```

这条链路的问题是：分流慢、上下文在部门流转中丢失、复合问题只处理一部分、知识更新后口径不统一、缺少统一评测机制、管理者无法量化效果。

**"智能客服"这个词被用滥了，真正缺的是 Agent Runtime。** 大量所谓"智能客服"本质是一个 prompt 加一段知识库拼接，在真实业务里会立刻暴露问题：不知道问题属于哪个领域、多轮对话失忆、复合问题只答一半、规则改了要重新发版、出问题无法定位也无法回归验证。EchoMind 的重点因此是**把运营请求抽象成有状态、有路由、有观测、有评测的运行时链路**，而不是"让一个模型聊天"。

### 1.3 项目组成

| 项目 | 目录 | 技术形态 | 端口 |
|------|------|----------|------|
| Python 后端 | `EchoMind/` | FastAPI + Anthropic SDK + ChromaDB + Redis | 8000 |
| 统一前端 | `EchoMindFrontend/` | Vue 3 + Vite + Nginx | 5173（开发）/ 5174（Docker） |

```
EchoMind/
├── api/main.py                    # FastAPI 入口：/chat /search /knowledge /monitor /eval /skills
├── core/intent_recognizer.py      # 三路融合意图识别（19 类意图）
├── core/skill_loader.py           # Skills 扫描、解析与热加载
├── agents/agent_orchestrator.py   # 多 Agent 路由与并行编排
├── memory/conversation_memory.py  # Redis + ChromaDB 三级记忆
├── mcp/tool_manager.py            # 工具调用、查询改写、重排、熔断、缓存、降级
├── mcp/knowledge_base.py          # ChromaDB RAG 知识库
├── monitor/performance_monitor.py # 在线监控与路由降权反馈
├── evaluation/evaluator.py        # 端到端评测（LLM-as-Judge + 回归检测）
├── skills/*/SKILL.md              # 可热加载的业务规则
└── docker-compose.yml / Dockerfile / requirements.txt / .env
```

---

## 2. 主要架构

### 2.1 总体架构

```
① 调用方    终端用户 / Web 前端（EchoMind Console）/ CLI（--cli）/ Swagger UI（/docs）
                              │
② 接入层    Nginx  →  静态资源托管 / 反向代理 / 请求体限制（10M）
                              │
③ 应用层    FastAPI :8000（api/main.py 为唯一状态编排入口）
              ├ 编排层  AgentOrchestrator（三层路由 + 并行协作 + 升级判定）
              │         IntentRecognizer（三路融合投票）
              ├ 能力层  SkillManager（Skills 热加载与匹配注入）
              │         MCPToolManager（改写·召回·重排·熔断·缓存·降级）
              │         KnowledgeBase（ChromaDB RAG 检索）
              ├ 记忆层  MemoryManager（工作记忆 + 情景记忆 + 用户画像）
              └ 观测层  PerformanceMonitor（10s 采集 + Z-score + 降权反馈）
                        EndToEndEvaluator（LLM-as-Judge + 回归检测）
                              │
④ 状态存储  Redis（工作记忆 + 摘要，TTL 86400s）
            ChromaDB（knowledge_base / episodic / user_profile）
            文件系统（skills/**/SKILL.md、data/eval/baseline.json）
                              │
⑤ 外部依赖  大模型 API（Anthropic 协议，可指向 DeepSeek 等兼容端点）
            Prometheus / 告警 Webhook
```

**四条架构要点：**

1. 请求统一从 Nginx 进入，Nginx 只做负载、限流与代理，不感知业务状态。
2. `api/main.py` 是唯一状态编排入口：**先读记忆 → 再识别意图 → 再决定是否 RAG → 最后调 Orchestrator**。
3. 状态分三处落地：Redis（短期、带 TTL）、ChromaDB（长期、持久化）、文件系统（Skills 与评测基线）。
4. 监控是**闭环而非单向观测**：`Monitor → 计算 monitor_penalty → Orchestrator 路由权重`。

### 2.2 `/chat` 主链路五阶段

```
阶段一 · 读三级记忆
  LRANGE wm:{user}:{conv}            （读取上限 20 条）
  episodic.query(n_results=5)        （语义检索历史摘要）
  user_profile.get(limit=1)          （取最新画像）
  GET summary:{user}:{conv}          （会话压缩摘要）
  → MemoryContext(summary, history, profile, recent)

阶段二 · 三路融合意图识别（LLM 与向量两路并行，不串行等待）
  LLM 语义识别  权重 0.70   ← Few-shot + 最近 3 轮上下文
  向量相似度    权重 0.20   ← 模板向量匹配（无 Embedding 服务时降级本地 hash 向量）
  关键词模式    权重 0.10   ← 同步执行，零网络延迟兜底
  → 加权投票；置信度 < 0.5 降级 OTHER；泛意图可被具体意图覆盖

阶段三 · 按意图门控的 RAG
  若意图 ∈ {问候, 反馈, 转人工, 未知} → 跳过检索（knowledge_used=false）
  否则 search_with_rewrite(knowledge_search, message, top_k=3)
       LLM 改写为 3 个不同角度子查询
       → asyncio.gather 并行召回（n_results = max(top_k, 5)）
       → 按内容哈希合并去重 → LLM 重排打分 → 返回 Top-K

阶段四 · 路由与执行
  若 OTHER 且置信度 < 0.5 且文本长度 > 2 → 先澄清反问
  _domain_scores 计算 general / technical / billing 得分
  → 排序取主 Agent；辅助 Agent 门槛：score ≥ 0.45 且 ≥ 主分 × 0.55
  → 复合问题 run_parallel 并行派发；_best_agent 选 routing_score 最高实例
  → 失败自动降级 GeneralAgent；命中升级条件置 escalated

阶段五 · 写状态
  LPUSH wm + EXPIRE 86400
  LLEN ≥ 15 触发压缩：旧消息 → LLM 2-3 句摘要 → SETEX summary
        → episodic.add（含 full_text 前 500 字）→ 回填最近 5 条
  asyncio.create_task(update_profile)    ← 异步，不阻塞响应
```

### 2.3 状态存储与部署

| 存储 | Key / Collection | 内容 | 生命周期 |
|------|------------------|------|----------|
| Redis List | `wm:{user_id}:{conv_id}` | 当前会话最近消息（上限 20） | TTL 86400s，写入刷新 |
| Redis String | `summary:{user_id}:{conv_id}` | 压缩后的会话摘要（累加） | TTL 86400s |
| ChromaDB | `episodic` | 历史对话摘要 + metadata | 持久化，语义检索 Top-5 |
| ChromaDB | `user_profile` | 偏好与关键实体（JSON） | 持久化，每轮异步覆盖 |
| ChromaDB | `knowledge_base` | 企业知识文档片段 | 持久化 |
| 文件 | `skills/**/SKILL.md` | 业务规则 | 启动加载，可热更新 |
| 文件 | `data/eval/baseline.json` | 评测基线 | 每次评测覆盖写入 |

**部署：** `docker compose up -d --build` 启动 5 个服务——`echomind-app`(8000)、`echomind-nginx`(80)、`echomind-redis`(6379)、`echomind-chromadb`(8001)、`echomind-prometheus`(9090)，同一 bridge 网络。启动顺序为 Redis/ChromaDB 健康 → 应用 lifespan 初始化（Skills → Orchestrator → Memory → ToolManager 与 KnowledgeBase → Monitor → Evaluator）→ `/health` 通过 → Nginx 启动。

镜像采用四阶段多阶段构建，并在构建期**预下载 ChromaDB 内置 ONNX embedding 模型（约 79MB）**，避免运行时下载超时；生产镜像以非 root 用户（uid 1000）运行。

---

## 3. 单个模块的处理逻辑

### 3.1 意图识别（`core/intent_recognizer.py`）

**三路融合策略**，LLM 与向量两路并行发起、不串行等待，关键词路同步执行：

| 策略 | 权重 | 处理方式 |
|------|------|----------|
| LLM 语义理解 | 0.70 | Few-shot（每类意图取 1 条示例）+ 最近 3 轮上下文，返回意图/置信度/一句话理由 |
| 向量相似度 | 0.20 | 模板向量匹配，纯 Python 余弦相似度，模板向量懒加载并缓存 |
| 关键词模式 | 0.10 | 细分模式（9 类）优先，未命中再走宽泛模式（8 类），零网络延迟 |

**识别范围：** 19 类细粒度意图（`order_status`、`logistics`、`refund`、`invoice`、`payment_issue`、`account_security`、`technical_login`、`technical_crash`、`human_handoff` 等），并归一化为 5 个意图组（query / billing / account / technical / escalation），兼顾业务精度与路由稳定。

**几个关键处理：**

- **加权投票**：按 `权重 × 各路置信度` 累加到对应意图，取最高分；低于阈值 0.5 时降级为 `OTHER`。
- **具体意图覆盖**：当胜出的是宽泛意图、而关键词路命中了具体意图、且关键词置信度 ≥ 0.5、融合分 < 0.8 时，**改用更具体的意图**——这让系统在 LLM 判断偏粗时仍落到正确业务分支。
- **降级链**：LLM 调用失败时，依次使用向量路 → 关键词路 → 返回 `OTHER`，不中断链路。
- **实体抽取**：用正则一次性抽取订单号、日期、金额、错误码，避免每次额外调用 LLM；这些实体后续参与路由加分。
- **紧急度判定**：按关键词命中"紧急/立刻"→CRITICAL、"今天/马上/尽快"→HIGH，转人工与投诉意图分别映射 HIGH/MEDIUM。
- **LRU 缓存**：以「清洗后的消息 + 最近 3 轮历史」为 key 缓存结果，上限 1000 条，超限清理 500 条。
- **编码清洗**：内部统一做 `_clean_text`，剔除 Unicode 代理字符，避免 prompt 编码崩溃。
- **在线学习**：`learn(message, correct_intent)` 将纠正样本追加到模板库并清除该意图的向量缓存。

### 3.2 多 Agent 编排（`agents/agent_orchestrator.py`）

**三层路由决策：**

```
第 1 层 · 意图路由（映射表）
  technical / technical_login / technical_crash → TechnicalAgent
  billing / refund / invoice / payment_issue
      / account / account_security              → BillingAgent
  escalation / human_handoff                    → ESCALATION（升级通道）
  其余                                           → GeneralAgent（默认）

第 2 层 · 领域打分（真正决定主辅 Agent）
  意图加分：general +0.55 ｜ technical +0.75 ｜ billing +0.75
  关键词加分：technical / billing 每命中 +0.18（封顶 0.45）
              general 每命中 +0.12（封顶 0.35）
  实体加分：error_code → technical +0.2
            amount     → billing   +0.15
            order_id   → general   +0.1
  ★ 辅助 Agent 门槛：score ≥ 0.45 且 ≥ 主分 × 0.55

第 3 层 · 性能路由（同类型多实例时）
  routing_score = (success_rate × 0.7 + latency_score × 0.3) × (1 − monitor_penalty)
  其中 latency_score = 1 / (1 + avg_ms / 1000)
  _best_agent() 取 routing_score 最大者   ← monitor_penalty ∈ [0, 0.9]，由 Monitor 回写
```

**几个关键处理：**

- **复合问题并行协作**：`_domain_scores` 排序后，除主 Agent 外凡满足门槛的领域都作为辅助 Agent，通过 `asyncio.gather` **并行派发**；结果按"主处理 / 辅助处理"标注后合并返回。例如"登录报错 401，而且这个月还重复扣款了"会得到 `primary=technical`、`supporting=[billing]`。
- **低置信度澄清**：`intent=other`、融合置信度 < 0.5、文本长度 > 2 时，**先向用户反问澄清**而不是强行路由，避免误派。
- **降级路由**：专属 Agent 执行失败时自动改用 GeneralAgent；目标类型无可用实例时直接使用 GeneralAgent。
- **升级判定**（满足任一即 `escalated = true`）：Agent 回复命中升级关键词（转人工/人工客服/escalate/specialist/无法处理）、紧急度为 CRITICAL、意图为 escalation 或 human_handoff。
- **可解释输出**：返回 `routing_reason`（含各领域得分明细）与 `routing_confidence`，便于调试与评测。

> 当前 `ESCALATION` 类型**无专属 Agent 实例**，路由到该类型后由 `GeneralAgent` 回复；因此其语义是"标记升级并置 `escalated = true`"，工单创建与坐席接续属预留扩展点。

### 3.3 三级记忆（`memory/conversation_memory.py`）

模拟人类记忆机制，分三层存储：

| 层级 | 存储 | 内容 | 作用 |
|------|------|------|------|
| 工作记忆 | Redis List | 当前会话最近消息（读取上限 20） | 毫秒级读写，保持对话连贯 |
| 会话摘要 | Redis String | 压缩后的摘要（逐次累加） | 直接拼入 prompt |
| 情景记忆 | ChromaDB `episodic` | 历史对话摘要 + metadata | 跨会话语义检索 Top-5 |
| 用户画像 | ChromaDB `user_profile` | 偏好与关键实体（JSON） | 长期个性化 |

**几个关键处理：**

- **上下文融合**：`get_context()` 按「摘要 → 相关历史（限 3 条）→ 用户画像 → 最近对话」的顺序拼成 prompt 文本。
- **自动压缩**：工作记忆 `LLEN ≥ 15` 时触发——旧消息交 LLM 生成 2-3 句摘要，`SETEX` 写入摘要键（与旧摘要累加），旧文本存入 `episodic`（metadata 保留 `full_text` 前 500 字），工作记忆只保留**最近 5 条**。摘要生成失败时写入占位文案，不中断主链路。
- **画像异步提炼**：每轮 `/chat` 后用 `asyncio.create_task` 异步调用 LLM，从最近 10 条对话提炼 `{"preferences": [...], "entities": {...}}`，先 delete 再 add 覆盖写入，不阻塞响应。
- **ChromaDB 双模兜底**：优先连接独立 ChromaDB 服务，连不上则降级为本地嵌入式 `PersistentClient`。
- **同步客户端异步化**：ChromaDB 客户端是同步实现，所有读写通过 `asyncio.to_thread` 放入线程池，避免阻塞事件循环。
- **编码安全**：`_safe_text` / `_safe_metadata_value` 递归清洗 Redis 与 ChromaDB 的写入内容。

### 3.4 RAG 知识库（`mcp/knowledge_base.py`）

- **collection**：`knowledge_base`，与记忆模块用的 `episodic` / `user_profile` 互不干扰。
- **自动切片**：`_chunk_text` 按句号/换行切分，每片约 500 字，保留语义完整性；片段 ID 由 `md5(title_index_内容前 50 字)` 生成，天然去重。
- **向量化**：调用 `collection.add(documents=...)` 时由 ChromaDB 内置 all-MiniLM-L6-v2 自动生成向量，`query()` 时自动语义匹配，**无需额外 Embedding API**。
- **相似度换算**：ChromaDB 返回距离，统一转换为 `score = round(1.0 - distance, 4)`。
- **首启动灌数据**：collection 为空时自动导入 6 篇默认文档（退款政策、订单查询、账户安全、技术故障排查、会员与积分、配送说明）。
- **作为工具注册**：`search_handler` 作为 `knowledge_search` 工具的真实 handler 接入 MCP 工具框架。

### 3.5 MCP 工具治理（`mcp/tool_manager.py`）

**要解决的两个问题：** 单一查询只能召回某一角度文档（召回不全）；向量相似度高不等于"对用户有用"（召回不好）。

**检索优化链路：**

```
① 查询改写  原始查询 → LLM 扩写为 3 个不同角度子查询 → 原始查询保留并去重
            示例："退款流程" → ["退款流程","如何申请退款","退款需要多少天","退款政策是什么"]
② 并行召回  asyncio.gather 并发执行所有子查询，每个召回 n_results = max(top_k, 5)
③ 合并去重  按 JSON 内容 md5 哈希去重，避免同一片段重复占位
④ LLM 重排  序列化结果交 LLM 按相关性排序，返回索引数组；失败则回退原融合分排序
⑤ 返回 Top-K
```

**单次调用的执行链：** 缓存检查 → 熔断检查 → JSON Schema 参数校验 → 执行（含超时）→ 可选重排 → 写 TTL 缓存（缓存**最终态**，含重排结果）→ 返回 `ToolResult`。

| 治理能力 | 参数 | 处理行为 |
|----------|------|----------|
| 熔断器 | 连续失败 5 次开启，60s 后转 HALF_OPEN | 三态机 CLOSED→OPEN→HALF_OPEN；OPEN 期间直接走降级，不把错误抛给上层 |
| 超时 | `timeout_s = 30.0` | `asyncio.wait_for` 包裹，超时计入失败并触发熔断计数 |
| TTL 缓存 | `cache_ttl = 300s` | 命中直接返回并标记 `cached=true`；容量 5000 条，超限清理最旧 1/4 |
| 参数校验 | 依据工具 JSON Schema | 校验 `required` 字段与 `properties.type`，不合法抛 `ValueError` |
| 降级 | `knowledge_fallback` | 返回"知识库降级结果"占位文档，说明检索未完成并建议转人工 |
| 同步工具兼容 | `inspect.iscoroutinefunction` 判断 | 同步 handler 自动放入线程池执行，不阻塞事件循环 |

### 3.6 在线监控（`monitor/performance_monitor.py`）

**采集无需额外埋点**——直接读取 Orchestrator 与 ToolManager 在处理请求时实时累加的统计：

```
每 10s 执行 _collect()
  ① Z-score 异常检测：滑动窗口 60，数据不足窗口一半时不检测，|z| > 2.5 判为异常
  ② 阈值告警：agent 成功率 < 0.90（ERROR）｜tool 成功率 < 0.95（WARNING）
              agent 平均延迟 > 3000ms（WARNING）｜tool 平均延迟 > 5000ms（ERROR）
  ③ 路由惩罚：success_rate < 0.90 → += min(0.5, (0.90 − sr) × 2)
              avg_ms > 3000       → += min(0.4, (avg_ms − 3000) / 10000)，封顶 0.9
  ④ 生成可操作建议：工具连续失败 ≥ 3 次时给出"检查依赖服务 / 查日志 / 加超时或降级"的具体步骤
        ↓
出口：Prometheus 指标（Gauge/Histogram/Counter）/ Webhook 告警 / /monitor 摘要
        ↓
回流：orchestrator.update_routing_penalties() → monitor_penalty
      → routing_score 下降 → _best_agent() 自动绕开劣化实例
```

**核心设计：监控数据不只是仪表盘，而是路由决策的输入项**——这是"观测即控制"的闭环。`/monitor` 返回最近 10 条告警与按优先级排序的前 5 条建议。

### 3.7 端到端评测（`evaluation/evaluator.py`）

| 维度 | 处理方式 | 输出 |
|------|----------|------|
| 意图识别 | 逐条比对预测与标注，纯 Python 计算指标 | Accuracy、Macro-F1、每类 P/R/F1 |
| 回复质量 | LLM-as-Judge 在真实 Orchestrator 输出上打分 | relevance / accuracy / completeness / helpfulness + overall |
| 端到端对话 | 逐轮调用 Orchestrator，模拟单轮与多轮（含 3 轮用例） | 每轮评分 + metadata（agent_type、intent、judge_failed） |
| 回归检测 | 与 `data/eval/baseline.json` 及历史报告对比 | 退化 > 5% 的指标列表 |
| 优化建议 | 基于规则生成定向建议 | 准确率 < 90%、相关性/完整性/有用性 < 0.75 的对应改进项 |

- **通过线**：意图准确率与四维 `overall` 均以 **0.75** 为及格线。
- **内置用例**：11 条意图用例 + 5 组对话用例。
- **Judge 失败兜底**：LLM Judge 调用异常时返回全 0.5 分并置 `judge_failed=true`，不中断评测。
- **基线自动落盘**：每次评测覆盖写入 baseline，形成可对比的历史序列。

> **边界说明**：LLM Judge 自身存在偏差，建议定期用人工标注校准；分类指标（Accuracy/Precision/Recall/F1）应由评测脚本基于标注集计算，不由 LLM Judge 单独承担。

### 3.8 Skills 动态规则注入（`core/skill_loader.py`）

```
skills/*/SKILL.md（front matter: name/description/keywords/agents/enabled）
  → SkillManager.load() 扫描目录（同时支持 .md / .txt / .json）
  → 解析为统一 Skill 对象，屏蔽文件格式差异
  → 按 agent 类型 + keywords 匹配
  → prompt_for(message, agent_type)   ← 总长受 max_prompt_chars = 5000 限制
  → BaseAgent._build_system_prompt 拼接 system_prompt + [动态 Skills]
  → 随请求发送给 LLM

热加载：POST /skills/reload → SkillManager.reload() → orchestrator.set_skill_manager()
查看：  GET /skills → 已加载列表 + 匹配关键词 + 解析错误
```

**几个关键处理：**

- **匹配规则**：`agents` 为空表示对所有 Agent 生效，否则只匹配指定 Agent；`keywords` 为空表示全局注入，否则需命中关键词。**按 Agent 隔离可避免通用客服话术污染技术支持规则。**
- **长度控制**：单文件超长自动截断到 3200 字，整体注入超限按剩余额度继续截断，防止挤占主对话上下文。
- **容错**：单个文件解析失败只记入 errors 列表，不影响其他 Skill 生效。
- **不引入额外依赖**：front matter 用自写解析器处理，不依赖 PyYAML。
- **内置 3 个 Skill**：通用客服接待规范（`general`）、技术支持处理规范（`technical`）、账单退款处理规范（`billing`）。三者均显式写入**禁止事项**——禁止承诺"马上到账""一定成功"；禁止索要密码、短信验证码、完整银行卡号、身份证照片；禁止在未查询系统时声称"已退款""已开票"。

### 3.9 接口与前端适配

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/health` | 健康检查，返回服务状态与 Agent 统计 |
| POST | `/chat` | 主对话链路 |
| POST | `/search` | 完整检索优化链路演示（`query`、`top_k`） |
| POST | `/knowledge/add` | JSON 批量导入文档 |
| POST | `/knowledge/upload` | 上传 `.txt` / `.md` / `.json`（≤10MB） |
| GET | `/knowledge/stats` | 知识库片段总数 |
| GET | `/skills` | 已加载 Skills 与解析错误 |
| POST | `/skills/reload` | 运行时重载 Skills |
| GET | `/monitor` | 指标、告警、优化建议 |
| GET | `/metrics` | Prometheus 指标 |
| POST | `/eval/run` | 运行端到端评测 |
| GET | `/docs` | Swagger UI |

**`POST /chat` 请求：** `message`（必填）、`user_id`（默认 `anonymous`，用于隔离记忆与画像）、`conv_id`（不传则自动生成 UUID；**同一 `user_id + conv_id` 即同一段多轮对话**）。

**`POST /chat` 响应关键字段：** `response`、`intent`/`intent_group`、`agent_type`/`primary_agent`/`supporting_agents`、`routing_reason`/`routing_confidence`、`escalated`、`latency_ms`、`knowledge_used`、`entities`、`intent_confidence`/`intent_source_scores`。

**前端核心处理：** `src/lib/backends.js` 是后端字段适配层——会话字段在请求侧按后端类型构造，响应侧依次尝试 `conversation_id` → `conversationId` → `conv_id` 回退取值，其余字段统一归一化为内部模型，使业务组件无需感知字段差异；连接配置持久化到 `localStorage`。

---

## 4. 使用说明

### 4.1 环境准备

**依赖：** Docker 与 Docker Compose；**凭据：** Anthropic API Key，或任一兼容 Anthropic 协议的第三方 Key（如 DeepSeek）。

```bash
cd EchoMind
cp .env.example .env
```

```env
ANTHROPIC_API_KEY=your_api_key

# 使用 DeepSeek 兼容端点（可选）
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_MODEL=deepseek-v4-pro

# 存储与能力开关
REDIS_URL=redis://redis:6379/0
REDIS_PASSWORD=echomind123
CHROMA_HOST=chromadb
CHROMA_PORT=8000
CHROMA_PERSIST_DIRECTORY=/app/data/chroma
ECHOMIND_SKILLS_DIR=./skills
ECHOMIND_SKILLS_MAX_PROMPT_CHARS=5000
MONITOR_INTERVAL=10
EVAL_BASELINE_PATH=/app/data/eval/baseline.json
```

### 4.2 启动方式

**方式 A · Docker Compose 全栈部署（推荐）**

```bash
docker compose up -d --build
docker compose logs -f echomind
curl http://localhost:8000/health
open http://localhost:8000/docs        # Swagger UI
```

**方式 B · Docker Run 开发模式**（适合本地改代码后快速重跑）

```bash
docker compose up -d redis chromadb                       # 1 仅启动依赖
docker compose build --no-cache echomind                  # 2 构建镜像
docker run -it --rm --network echomind_echomind-network -p 8000:8000 \
  -e ANTHROPIC_API_KEY="your_key" \
  -e REDIS_URL="redis://:echomind123@redis:6379/0" \
  -e CHROMA_HOST="chromadb" -e CHROMA_PORT="8000" \
  -v "$(pwd):/workspace" -w /workspace echomind           # 3 挂载代码目录启动
```

> 两者区别：Compose 会自动启动并连通全部依赖；Docker Run 需先手动启动依赖并手动指定 `--network`，好处是挂载代码目录后改代码即生效。

**方式 C · CLI 交互模式**

```bash
docker compose run --rm echomind python api/main.py --cli
```

使用固定 `user_id=cli_user` 与自动生成的 `conv_id`，输入 `quit` / `exit` / `退出` 结束。

**方式 D · 前端控制台**

```bash
cd EchoMindFrontend && npm install && npm run dev    # http://localhost:5173
npm run build && docker compose up -d --build        # http://localhost:5174
```

### 4.3 操作流程

```
① 打开 http://localhost:5173（或 5174）
② 左侧栏选择后端 → 页面自动健康检查，状态灯变绿表示可用
③ （可选）确认「用户 ID」与「会话 ID」；会话 ID 留空则由后端生成并自动回填
④ 输入问题点击「发送」；助手回复下方显示标签：意图 · Agent · RAG · 转人工
⑤ 继续提问，保持同一「会话 ID」即为多轮对话
⑥ 用「知识库检索」面板验证 RAG 效果；用「导入知识」补充文档，片段数自动刷新
⑦ 点击顶栏「API 文档」跳转 Swagger UI，可在线调试全部接口
```

**多轮对话**（保持同一 `user_id` + `conv_id`）：

```bash
curl -X POST http://localhost:8000/chat -H "Content-Type: application/json" \
  -d '{"message":"你好，我想退款","user_id":"user_001","conv_id":"session_001"}'
curl -X POST http://localhost:8000/chat -H "Content-Type: application/json" \
  -d '{"message":"订单号是 A123456","user_id":"user_001","conv_id":"session_001"}'
```

**验证复合问题并行协作**（预期 `primary_agent=technical`、`supporting_agents=["billing"]`、回复中出现 `[technical - 主处理]` 与 `[billing - 辅助处理]` 两段）：

```bash
curl -X POST http://localhost:8000/chat -H "Content-Type: application/json" \
  -d '{"message":"登录报错401，而且这个月还重复扣款了","user_id":"user_mix","conv_id":"mix_001"}'
```

### 4.4 知识库与规则运营

```bash
curl http://localhost:8000/knowledge/stats                     # 查看片段数
curl -X POST http://localhost:8000/knowledge/add \             # JSON 批量导入
  -H "Content-Type: application/json" \
  -d '{"documents":[{"title":"退换货政策","content":"购买后 7 天内可申请无理由退货，审核通过后 5-7 个工作日退款。"}]}'
curl -X POST http://localhost:8000/knowledge/upload \          # 文件上传（自动切片）
  -F "file=@data/demo_docs/sample_knowledge.json"
curl -X POST "http://localhost:8000/search?query=退款多久到账&top_k=3"   # 检索验证
```

文件格式：`.txt` / `.md` 整文件作为一篇文档（文件名作标题）；`.json` 必须为数组 `[{"title":"...","content":"..."}]`。长文档自动按约 500 字切片，上限 10MB。

**新增业务规则（无需发版）：**

```
① 新建 skills/refund_policy/SKILL.md
② 编写 front matter + 规则正文
     ---
     name: 退款处理流程
     keywords: 退款,退费,refund
     agents: billing,general
     enabled: true
     ---
     # 退款处理流程
     - 先确认订单号和支付方式。涉及实际退款操作时转人工审核。
③ curl http://localhost:8000/skills                  # 查看加载结果
④ curl -X POST http://localhost:8000/skills/reload   # 热加载生效
⑤ 发送命中关键词的消息验证规则已注入
```

`keywords` 留空表示全局注入；`agents` 留空表示对所有 Agent 生效；`enabled: false` 可临时停用。

### 4.5 交互指南

**提问方式建议：**

| 目的 | 推荐表达 | 系统行为 |
|------|----------|----------|
| 触发特定业务 Agent | 直接说出业务关键词（退款、发票、重复扣款、401、崩溃） | 关键词路命中具体意图，路由更精准 |
| 触发复合问题协作 | 同一句包含两个领域线索 | 产生主辅 Agent 并行处理 |
| 提供结构化实体 | 带上订单号（`#12345`）、金额（`50元`）、错误码（`401`） | 实体抽取成功后为对应领域加分 |
| 表达紧迫程度 | "紧急""马上""尽快" | 紧急度提升，`CRITICAL` 直接走升级路由 |
| 要求转人工 | "转人工""找人工""投诉" | 升级路由，`escalated = true` |
| 避免触发澄清反问 | 提问保持具体（长度 > 2 且语义明确） | 置信度不足时先反问，属正常设计 |

**响应标签解读（`意图 · Agent · RAG · 转人工`）：** 意图用于判断理解是否准确（不准时可补充更明确的表述）；Agent 用于确认路由是否符合预期；RAG 表示本次回复使用了知识库（业务问题若未出现该标签，应检查知识库是否有对应文档）；转人工表示已触发升级需人工跟进。直接调接口时还可读取 `routing_reason`、`intent_source_scores`、`intent_confidence` 做深度排查。

### 4.6 数据查看与排障

**Redis 工作记忆：**

```bash
docker exec -it echomind-redis redis-cli -a echomind123
LRANGE wm:user_001:session_001 0 -1     # 当前会话最近消息
TTL   wm:user_001:session_001           # TTL（默认 86400s）
GET   summary:cli_user:<conv_id>        # 会话压缩摘要
```

**ChromaDB 数据**（进入 `echomind-app` 容器后）：

```python
import chromadb
client = chromadb.HttpClient(host="chromadb", port=8000)
print("heartbeat:", client.heartbeat())
for c in client.list_collections():
    print("-", c.name, "count=", c.count())          # 三个 collection 及数量
```

**常见问题：**

| 现象 | 排查步骤 |
|------|----------|
| `/health` 返回 503 | 查日志 `docker compose logs -f echomind`；确认 `.env` 已配置 `ANTHROPIC_API_KEY`；确认 Redis / ChromaDB 健康；确认容器未反复重启 |
| ChromaDB 连接失败 | `curl http://localhost:8001/api/v1/heartbeat`；进入应用容器用 Python 客户端测 `heartbeat()` |
| Redis 认证失败 | 确认 `.env` 与 `docker-compose.yml` 密码一致；`docker exec -it echomind-redis redis-cli -a echomind123 ping` |
| `/search` 无结果 | 先查 `/knowledge/stats` 确认片段数；为 0 时重新导入演示文档再测试 |
| 用户画像查不到 | 画像为**异步**更新：用固定 `user_id` 多调几次 `/chat`，等待数秒，检查日志是否出现"用户画像已更新" |
| 情景记忆查不到 | 情景记忆**不是每轮都写**，需工作记忆达 15 条触发压缩；连续发 16 条以上再查 |
| 回复总是澄清反问 | 说明意图置信度 < 0.5，属预期行为；补充更具体的业务描述即可 |

### 4.7 一键验证流程

```bash
docker compose up -d --build                                              # 1 启动
curl http://localhost:8000/health                                         # 2 健康检查
curl -X POST http://localhost:8000/chat -H "Content-Type: application/json" \
  -d '{"message":"你好，我想了解退款政策","user_id":"demo_user","conv_id":"demo_conv"}'   # 3 主对话
curl http://localhost:8000/knowledge/stats                                # 4 知识库统计
curl -X POST http://localhost:8000/knowledge/upload \
  -F "file=@data/demo_docs/sample_knowledge.json"                         # 5 导入演示知识库
curl -X POST "http://localhost:8000/search?query=EchoMind如何接入API&top_k=3"  # 6 检索验证
curl -X POST http://localhost:8000/chat -H "Content-Type: application/json" \
  -d '{"message":"登录报错401，而且这个月还重复扣款了","user_id":"m","conv_id":"m"}'   # 7 复合问题
curl http://localhost:8000/monitor                                        # 8 监控摘要
curl http://localhost:8000/skills                                         # 9 Skills 状态
curl -X POST http://localhost:8000/eval/run                               # 10 端到端评测
```

**服务管理：**

```bash
docker compose stop              # 停止
docker compose restart echomind  # 重启应用
docker compose down              # 停止并删除容器（保留数据卷）
docker compose down -v           # 连同数据卷一起删除
```

> 清空向量数据：`docker compose down && docker volume rm echomind_chromadb-data && docker compose up -d --build`。重启后 `KnowledgeBase` 会在 collection 为空时自动重新导入默认文档。
