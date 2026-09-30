# EchoMind 架构图（Mermaid 版）

本文档用 Mermaid 描述 EchoMind 智能客服系统的架构，**重点体现状态流转与数据流转**。

代码依据：

| 层 | 文件 |
|----|------|
| 入口 / 路由 | `api/main.py` |
| 意图识别 | `core/intent_recognizer.py` |
| 多 Agent 编排 | `agents/agent_orchestrator.py` |
| 三级记忆 | `memory/conversation_memory.py` |
| MCP 工具框架 | `mcp/tool_manager.py` |
| RAG 知识库 | `mcp/knowledge_base.py` |
| Skills 热加载 | `core/skill_loader.py` |
| 监控 | `monitor/performance_monitor.py` |
| 评测 | `evaluation/evaluator.py` |
| 部署 | `docker-compose.yml`、`config/nginx/nginx.conf` |

---

## 1. 总体架构（分层 + 数据流向）

```mermaid
flowchart TB
    subgraph CLIENT["① 调用方"]
        U1["终端用户 / Web 前端"]
        U2["CLI 模式<br/>python api/main.py --cli"]
        U3["Swagger UI<br/>/docs"]
    end

    subgraph EDGE["② 接入层"]
        NG["Nginx :80<br/>least_conn 负载 · 限流 10r/s · gzip"]
    end

    subgraph APP["③ EchoMind 主服务 · FastAPI :8000"]
        API["api/main.py<br/>/chat /search /knowledge/* /monitor /metrics /eval/run /skills"]

        subgraph ORCH["编排层"]
            ORC["AgentOrchestrator<br/>三层路由 + 并行协作 + 升级判定"]
            IR["IntentRecognizer<br/>三路融合投票"]
        end

        subgraph CAP["能力层"]
            SM["SkillManager<br/>Skills 热加载与匹配注入"]
            TM["MCPToolManager<br/>改写 · 召回 · 重排 · 熔断 · 缓存 · 降级"]
            KB["KnowledgeBase<br/>ChromaDB RAG 检索"]
        end

        subgraph MEM["记忆层"]
            MM["MemoryManager<br/>工作记忆 + 情景记忆 + 用户画像"]
        end

        subgraph OBS["观测层"]
            MON["PerformanceMonitor<br/>10s 采集 + Z-score 异常检测"]
            EVAL["EndToEndEvaluator<br/>LLM-as-Judge 评测"]
        end
    end

    subgraph STORE["④ 状态存储"]
        R[("Redis 7<br/>工作记忆 + 会话摘要<br/>TTL 24h")]
        C[("ChromaDB<br/>knowledge_base / episodic / user_profile")]
        F["skills/**/SKILL.md<br/>可热加载业务规则"]
        B["data/eval/baseline.json<br/>评测基线"]
    end

    subgraph EXT["⑤ 外部依赖"]
        LLM["大模型 API<br/>Anthropic 协议 · 兼容 DeepSeek"]
        PROM["Prometheus :9090"]
        HOOK["告警 Webhook"]
    end

    U1 --> NG
    U2 --> API
    U3 --> NG
    NG --> API
    API --> ORC
    API --> IR
    API --> MM
    API --> TM
    API --> MON
    API --> EVAL

    ORC --> IR
    ORC --> SM
    ORC --> MM
    IR --> LLM
    TM --> KB
    KB --> C
    SM -.读取.-> F
    MM --> R
    MM --> C
    ORC --> LLM
    MM --> LLM

    MON -.读取统计.-> ORC
    MON -.读取统计.-> TM
    MON -.路由惩罚回写.-> ORC
    MON --> PROM
    MON -.超阈值.-> HOOK
    PROM -.scrape /metrics.-> API
    EVAL --> ORC
    EVAL --> LLM
    EVAL --> B

    classDef store fill:#e8f4ff,stroke:#2b6cb0,stroke-width:2px
    classDef ext fill:#fff4e6,stroke:#c05621,stroke-width:2px
    classDef entry fill:#f0fff4,stroke:#2f855a,stroke-width:2px
    class R,C,F,B store
    class LLM,PROM,HOOK ext
    class U1,U2,U3,NG,API entry
```

**数据流要点**

1. 请求统一从 Nginx 进入 FastAPI，Nginx 只做负载、限流和代理，不感知业务状态。
2. `api/main.py` 是唯一的状态编排入口：**先读记忆 → 再识别意图 → 再决定是否 RAG → 最后调 Orchestrator**。
3. 状态分三处落地：Redis（短期、带 TTL）、ChromaDB（长期、持久化）、文件系统（Skills 与评测基线）。
4. 监控是**闭环**：`Monitor → 计算 monitor_penalty → Orchestrator 路由权重`，不是单向观测。

---

## 2. `/chat` 主链路时序图（数据流转全路径）

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant API as FastAPI /chat
    participant MM as MemoryManager
    participant R as Redis
    participant C as ChromaDB
    participant IR as IntentRecognizer
    participant TM as MCPToolManager
    participant KB as KnowledgeBase
    participant ORC as AgentOrchestrator
    participant AG as General / Technical / Billing Agent
    participant LLM as 大模型 API

    U->>API: POST /chat 提交 message / user_id / conv_id
    API->>API: conv_id 取 req.conv_id，缺省则 uuid4()

    Note over API,C: 阶段一 · 读三级记忆
    API->>MM: get_context(user_id, conv_id, query)
    MM->>R: LRANGE wm:user:conv
    R-->>MM: 工作记忆最近 N 条
    MM->>C: episodic.query 按 user_id 过滤，n_results 为 5
    C-->>MM: 情景记忆语义相关片段
    MM->>C: user_profile.get 按 user_id 取 1 条
    C-->>MM: 用户画像 JSON
    MM->>R: GET summary:user:conv
    R-->>MM: 会话摘要
    MM-->>API: MemoryContext 含 summary / history / profile / recent

    Note over API,IR: 阶段二 · 三路融合意图识别
    API->>IR: recognize(message, history 取最近 5 条)
    IR->>LLM: LLM 语义识别，权重 0.7
    IR->>IR: Embedding 相似度 0.2 与关键词模式 0.1
    IR->>IR: 加权投票，低于 0.5 降级 OTHER，泛意图可被具体意图覆盖
    IR-->>API: IntentResult 含 intent / urgency / entities / source_scores

    Note over API,KB: 阶段三 · 条件式 RAG
    alt _should_use_knowledge 命中业务问题
        API->>TM: search_with_rewrite 调用 knowledge_search，top_k 为 3
        TM->>LLM: 查询改写生成 3 个不同角度子查询
        par 并行召回
            TM->>KB: call 子查询组 A
        and
            TM->>KB: call 子查询组 B
        end
        KB->>C: knowledge_base.query
        C-->>KB: 候选片段与距离分，相似度等于 1 减 dist
        TM->>TM: 按内容哈希合并去重
        TM->>LLM: LLM rerank 打分并排序
        LLM-->>TM: 相关性索引序列
        TM-->>API: Top-K 知识片段
    else 纯寒暄 / 转人工 / 其他意图
        API->>API: 跳过 RAG，knowledge_used 为 false
    end

    Note over API,ORC: 阶段四 · 路由与执行
    API->>ORC: run 传入 Request 含 context / history / intent / entities / urgency
    ORC->>ORC: OTHER 且置信度低于 0.5 时先向用户澄清
    ORC->>ORC: _domain_scores 按意图 / 关键词 / 实体打分
    ORC->>ORC: 排序取主 Agent，辅助 Agent 需不小于 0.45 且不小于主分乘 0.55
    alt 复合问题
        par 主处理
            ORC->>AG: handle(req)
        and 辅助处理
            ORC->>AG: handle(req)
        end
    else 单领域问题
        ORC->>AG: handle(req)
    end
    AG->>AG: _best_agent 取 routing_score 最高的实例
    AG->>LLM: system_prompt 加动态 Skills 加背景信息加结构化实体加用户问题
    LLM-->>AG: 回复文本
    AG-->>ORC: AgentResponse 含 success / latency_ms / escalate
    ORC->>ORC: 失败则降级 GeneralAgent，命中升级条件则置 escalated
    ORC-->>API: OrchestratorResult 含 routing_reason / routing_confidence

    Note over API,C: 阶段五 · 写状态，含压缩与异步画像
    API->>MM: add_message 写入 USER 与 ASSISTANT
    MM->>R: LPUSH wm:user:conv 并 EXPIRE 86400
    opt LLEN 不小于 15 触发压缩
        MM->>LLM: 旧消息生成 2-3 句摘要
        MM->>R: SETEX summary:user:conv 86400
        MM->>C: episodic.add 写入摘要与 full_text，供跨会话检索
        MM->>R: 工作记忆重置为最近 5 条
    end
    API--)MM: asyncio.create_task 异步执行 update_profile
    MM->>LLM: 从最近 10 条提炼偏好与实体
    MM->>C: user_profile 先 delete 再 add，覆盖为最新画像

    API-->>U: ChatResponse 含 conv_id / response / intent / agent_type /<br/>primary_agent / supporting_agents / routing_reason /<br/>escalated / latency_ms / knowledge_used / entities
```

---

## 3. 三级记忆状态流转（核心状态机）

```mermaid
stateDiagram-v2
    direction LR
    [*] --> S0

    state "会话创建" as S0
    state "工作记忆中" as WM
    state "触发压缩" as CP
    state "摘要已写入" as SUM
    state "情景记忆已落库" as EPI
    state "工作记忆已收缩" as SHRINK
    state "TTL 到期清理" as EXP

    S0 --> WM: conv_id 生成，Redis key 为 wm:user:conv
    WM --> WM: 每轮 LPUSH 一条，EXPIRE 刷新为 86400s
    WM --> CP: LLEN 达到 COMPRESS_AT 即 15
    CP --> SUM: LLM 生成 2-3 句摘要，旧摘要拼接后 SETEX
    SUM --> EPI: ChromaDB episodic.add，metadata 含 user_id 与 conv_id 与 full_text
    EPI --> SHRINK: Redis DEL 后回填最近 5 条
    SHRINK --> WM: 继续对话
    WM --> EXP: 24h 无活动
    EXP --> [*]

    note right of EPI
        user_profile 走独立路径：
        每次 /chat 后异步 LLM 提炼，
        按 user_id 与 conv_id 覆盖写入
    end note
```

**状态存储对照表**

| 记忆层级 | 存储 | 键 / Collection | 生命周期 | 写入时机 |
|----------|------|-----------------|----------|----------|
| 工作记忆 | Redis List | `wm:{user_id}:{conv_id}` | 24h TTL | 每轮对话后 LPUSH |
| 会话摘要 | Redis String | `summary:{user_id}:{conv_id}` | 24h TTL | 消息数 ≥ 15 触发压缩 |
| 情景记忆 | ChromaDB | `episodic` | 持久化 | 压缩时写入摘要 |
| 用户画像 | ChromaDB | `user_profile` | 持久化 | 每轮异步覆盖 |
| RAG 知识库 | ChromaDB | `knowledge_base` | 持久化 | 文档导入 / 首次启动灌默认文档 |

---

## 4. 多 Agent 路由决策流

```mermaid
flowchart TD
    A["Request 进入 AgentOrchestrator.run"] --> B{"req.intent 已识别?"}
    B -- 否 --> B1["调用 IntentRecognizer"]
    B -- 是 --> C
    B1 --> C{"OTHER 且置信度低于 0.5<br/>且文本长度大于 2?"}
    C -- 是 --> C1["返回澄清追问<br/>agent 取 general"]
    C -- 否 --> D{"urgency 等于 CRITICAL?"}
    D -- 是 --> D1["primary 取 escalation<br/>confidence 为 1.0"]
    D -- 否 --> E{"intent 属于<br/>escalation 或 human_handoff?"}
    E -- 是 --> E1["primary 取 escalation<br/>confidence 取 max 后的 0.8"]
    E -- 否 --> F["_domain_scores 领域打分"]

    F --> F1["意图权重<br/>general 加 0.55<br/>technical 加 0.75<br/>billing 加 0.75"]
    F1 --> F2["关键词命中<br/>每命中加 0.18 或 0.12 并封顶"]
    F2 --> F3["实体加成<br/>error_code 使 technical 加 0.2<br/>amount 使 billing 加 0.15<br/>order_id 使 general 加 0.1"]
    F3 --> G["按分数降序排列，过滤无实例的 Agent"]
    G --> H["primary 取最高分"]
    H --> I{"其余 Agent 是否<br/>score 不小于 0.45<br/>且不小于 primary 乘 0.55?"}
    I -- 是 --> I1["纳入 supporting_agents"]
    I -- 否 --> I2["单 Agent 执行"]
    I1 --> J["run_parallel 并行派发"]
    I2 --> K["_execute 主 Agent"]

    K --> K1["_best_agent<br/>取 routing_score 最大者"]
    K1 --> K2["Agent.handle 调用 LLM"]
    K2 --> K3{"success?"}
    K3 -- 否 --> K4["降级 GeneralAgent 重试"]
    K3 -- 是 --> L
    K4 --> L{"升级判定<br/>escalate 关键词 或 CRITICAL 或 转人工意图"}

    D1 --> L
    E1 --> L
    L -- 命中 --> M["escalated 为 true<br/>生产环境创建工单"]
    L -- 未命中 --> N["escalated 为 false"]
    M --> O["返回 OrchestratorResult"]
    N --> O
    O --> P["更新 AgentStats<br/>total 与 success 与 total_ms"]

    classDef dec fill:#fffaf0,stroke:#b7791f,stroke-width:2px
    classDef act fill:#f0fff4,stroke:#2f855a,stroke-width:2px
    class B,C,D,E,I,K3,L dec
    class B1,C1,D1,E1,F,F1,F2,F3,G,H,I1,I2,J,K,K1,K2,K4,M,N,O,P act
```

**routing_score 计算（性能路由的量化依据）**

```mermaid
flowchart LR
    A["success_rate<br/>等于 success 除以 total"] --> C["base 等于 success_rate 乘 0.7<br/>加 latency_score 乘 0.3"]
    B["latency_score<br/>等于 1 除以 1 加 avg_ms 除以 1000"] --> C
    C --> D["routing_score<br/>等于 base 乘 1 减 monitor_penalty"]
    E["Monitor 回写 monitor_penalty<br/>区间 0 到 0.9"] --> D
    D --> F["_best_agent 取最大值"]

    classDef s fill:#e8f4ff,stroke:#2b6cb0,stroke-width:2px
    class A,B,E s
```

---

## 5. MCP 工具调用状态机 + 检索优化链路

### 5.1 熔断器三态机

```mermaid
stateDiagram-v2
    direction LR
    [*] --> CLOSED

    CLOSED --> CLOSED: 调用成功，fail_count 归零
    CLOSED --> OPEN: 连续失败达到 5 次，即 failure_threshold
    OPEN --> OPEN: 未到 recovery_s 的 60s，直接走 fallback
    OPEN --> HALF_OPEN: 超过 60s，放行一次探测
    HALF_OPEN --> CLOSED: 探测成功，恢复流量
    HALF_OPEN --> OPEN: 探测失败，重新打开

    note right of OPEN
        fallback 不抛错给上层：
        knowledge_fallback 返回
        「知识库降级结果」占位文档
    end note
```

### 5.2 单次工具调用执行链

```mermaid
flowchart TD
    A["call(name, params, rerank_top_k)"] --> B{"工具已注册?"}
    B -- 否 --> B1["返回 error：工具不存在"]
    B -- 是 --> C{"cache_ttl 大于 0 且缓存命中?"}
    C -- 是 --> C1["返回缓存结果<br/>cached 为 true"]
    C -- 否 --> D{"breaker.allow() 是否放行?"}
    D -- 否 --> D1["_fallback_result<br/>熔断降级"]
    D -- 是 --> E["_validate_params<br/>按 JSON Schema 校验 required 与 type"]
    E -- 校验失败 --> D1
    E -- 通过 --> F["asyncio.wait_for 执行 handler，超时 30s"]
    F -- 超时 --> G["stats.failed 自增<br/>consecutive_fails 自增<br/>breaker.record_failure"]
    F -- 异常 --> G
    G --> D1
    F -- 成功 --> H["stats.success 自增<br/>latency 累加<br/>breaker.record_success"]
    H --> I{"rerank_top_k 大于 0<br/>且 supports_rerank 为真?"}
    I -- 是 --> I1["LLM rerank 打分重排"]
    I -- 否 --> J
    I1 --> J["写入 TTL 缓存<br/>缓存最终态，含重排结果"]
    J --> K["返回 ToolResult"]
    D1 --> K
    C1 --> K
    B1 --> K

    classDef warn fill:#fff5f5,stroke:#c53030,stroke-width:2px
    class B1,D1,G warn
```

### 5.3 检索优化链路（解决召回不全与召回不好）

```mermaid
flowchart LR
    Q["用户原始查询"] --> RW["① 查询改写<br/>LLM 生成 3 个不同角度子查询<br/>原始查询保留并去重"]
    RW --> P1["② 并行召回<br/>asyncio.gather 并发多个子查询"]
    P1 --> P2["ChromaDB knowledge_base.query<br/>n_results 取 max(top_k, 5)"]
    P2 --> MG["③ 合并去重<br/>按 JSON 内容 md5 去重"]
    MG --> RK["④ LLM rerank<br/>按相关性打分返回索引序"]
    RK --> TK["⑤ 返回 Top-K"]
    RK -. 重排失败 .-> FB["回退按融合分原顺序取 Top-K"]

    classDef hi fill:#faf5ff,stroke:#6b46c1,stroke-width:2px
    class RW,RK hi
```

---

## 6. 监控到路由的反馈闭环（状态回流）

```mermaid
flowchart TB
    subgraph RUNTIME["在线请求路径 · 状态生产者"]
        AG["AgentOrchestrator<br/>AgentStats 含 total / success / total_ms"]
        TM["MCPToolManager<br/>ToolStats 含 total / failed / consecutive_fails"]
    end

    subgraph LOOP["PerformanceMonitor 采集循环，每 10s 一次"]
        COL["_collect()"]
        ANO["AnomalyDetector.record<br/>滑动窗口 60，Z-score 大于 2.5"]
        TH["_check_threshold<br/>成功率与延迟阈值"]
        PEN["_routing_penalty<br/>成功率低于 0.9 时加 差值乘 2 上限 0.5<br/>avg_ms 高于 3000 时加 差值除 10000 上限 0.4<br/>总计封顶 0.9"]
        SUG["_generate_routing_suggestions<br/>可操作优化建议"]
    end

    subgraph OUT["状态出口"]
        PM["Prometheus 指标<br/>Gauge / Histogram / Counter"]
        WH["Webhook 告警 httpx"]
        SUM["/monitor 摘要<br/>agent_stats 与 tool_stats<br/>active_alerts 与 suggestions"]
    end

    subgraph FEEDBACK["状态回流 · 影响下一次路由"]
        UP["orchestrator.update_routing_penalties"]
        ST["agent.stats.monitor_penalty"]
        RS["routing_score 下降"]
        BA["_best_agent 绕开劣化实例"]
    end

    AG --> COL
    TM --> COL
    COL --> ANO
    COL --> TH
    COL --> PEN
    COL --> SUG
    ANO --> SUM
    TH --> PM
    TH --> WH
    TH --> SUM
    SUG --> SUM
    PEN --> UP
    UP --> ST
    ST --> RS
    RS --> BA
    BA -.下一次请求.-> AG

    classDef fb fill:#e6fffa,stroke:#2c7a7b,stroke-width:2px
    class UP,ST,RS,BA fb
```

**阈值表**

| 指标 | 阈值 | 判定 | 严重级 |
|------|------|------|--------|
| `agent_success_rate` | < 0.90 | less_than | ERROR |
| `tool_success_rate` | < 0.95 | less_than | WARNING |
| `agent_avg_ms` | > 3000 | greater_than | WARNING |
| `tool_avg_ms` | > 5000 | greater_than | ERROR |

---

## 7. 评测闭环（质量状态的回写）

```mermaid
flowchart TD
    A["POST /eval/run<br/>默认使用内置用例"] --> B["EndToEndEvaluator.run"]

    B --> C1["① 意图评测 IntentEvaluator"]
    C1 --> C2["逐条调用 IntentRecognizer"]
    C2 --> C3["Accuracy 加每类 P / R / F1 加 Macro-F1"]

    B --> D1["② 对话质量评测"]
    D1 --> D2["逐轮调用 AgentOrchestrator 产出真实回复"]
    D2 --> D3["LLMJudge 四维打分<br/>relevance / accuracy /<br/>completeness / helpfulness"]
    D3 --> D4["overall 取四维均值"]

    C3 --> E["汇总 EvalReport<br/>pass_rate 与 avg_scores"]
    D4 --> E
    E --> F["_detect_regressions<br/>与 baseline 和历史版本对比"]
    F --> G["_recommendations 生成优化建议"]
    G --> H["_save_baseline<br/>写 data/eval/baseline.json"]
    H --> I["返回 pass_rate / regressions /<br/>recommendations / results"]

    classDef store fill:#e8f4ff,stroke:#2b6cb0,stroke-width:2px
    class H store
```

---

## 8. Skills 注入与热加载状态流

```mermaid
flowchart LR
    A["skills 目录下的 SKILL.md<br/>front matter 含 name / keywords / agents"] --> B["SkillManager.load()"]
    B --> C["解析为 Skill 对象<br/>md / json / txt 统一模型"]
    C --> D["按 agent_type 与 keywords 匹配"]
    D --> E["prompt_for(message, agent_type)<br/>总长受 max_prompt_chars 限制"]
    E --> F["BaseAgent._build_system_prompt<br/>system_prompt 拼动态 Skills"]
    F --> G["随请求发给 LLM"]

    H["POST /skills/reload"] --> I["SkillManager.reload()"]
    I --> J["orchestrator.set_skill_manager()"]
    J -.所有 Agent 换用新引用.-> F
    K["GET /skills"] --> L["summary()<br/>count / skills / errors"]

    classDef hot fill:#fffaf0,stroke:#b7791f,stroke-width:2px
    class H,I,J hot
```

| Skill | 目标 Agent | 匹配关键词（节选） |
|-------|-----------|-------------------|
| 通用客服接待规范 | `general` | 你好、咨询、帮助、订单、投诉、转人工 |
| 技术支持处理规范 | `technical` | 报错、崩溃、无法登录、500、401、超时、日志 |
| 账单退款处理规范 | `billing` | 退款、扣款、支付、账单、发票、订阅 |

---

## 9. 部署拓扑（Docker Compose）

```mermaid
flowchart TB
    CLIENT["客户端"] -->|宿主机端口 80| NG

    subgraph NET["echomind-network · bridge 172.28.0.0/16"]
        NG["echomind-nginx<br/>nginx:alpine"]
        APP["echomind-app<br/>FastAPI :8000<br/>healthcheck /health"]
        R["echomind-redis<br/>redis:7-alpine :6379<br/>appendonly 与密码"]
        C["echomind-chromadb<br/>chroma 0.5.23 端口 8000 映射 8001<br/>IS_PERSISTENT"]
        P["echomind-prometheus<br/>:9090"]
    end

    NG -->|upstream least_conn| APP
    APP -->|REDIS_URL| R
    APP -->|CHROMA_HOST 与 CHROMA_PORT| C
    P -->|scrape /metrics 每 10s| APP
    APP -.可选 PROMETHEUS_PORT.-> PR["prometheus_client<br/>start_http_server"]

    subgraph VOL["数据卷"]
        V1["redis-data"]
        V2["chromadb-data"]
        V3["prometheus-data"]
        V4["挂载 ./skills ./data/eval ./data/chroma ./logs"]
    end
    R --- V1
    C --- V2
    P --- V3
    APP --- V4

    classDef vol fill:#f7fafc,stroke:#718096,stroke-dasharray:4 3
    class V1,V2,V3,V4 vol
```

**启动顺序（depends_on 加 healthcheck 驱动）**

```mermaid
flowchart LR
    A["redis healthy<br/>redis-cli ping"] --> C["echomind 启动"]
    B["chromadb healthy<br/>/api/v1/heartbeat"] --> C
    C --> C1["lifespan 初始化顺序<br/>Skills 到 Orchestrator 到 Memory<br/>到 ToolManager 与 KnowledgeBase<br/>到 Monitor 到 Evaluator"]
    C1 --> D["echomind healthy<br/>curl /health"]
    D --> E["nginx 启动"]

    classDef ok fill:#f0fff4,stroke:#2f855a,stroke-width:2px
    class A,B,D ok
```

---

## 10. 接口与状态读写映射表

| 接口 | 方法 | 读取的状态 | 写入的状态 |
|------|------|-----------|-----------|
| `/chat` | POST | Redis 工作记忆 + 摘要、ChromaDB 情景记忆 + 画像、知识库 | Redis 工作记忆 / 摘要、ChromaDB 情景记忆 + 画像、AgentStats |
| `/search` | POST | ChromaDB `knowledge_base`、工具缓存 | 工具缓存、ToolStats |
| `/knowledge/add` | POST | — | ChromaDB `knowledge_base`（500 字切片） |
| `/knowledge/upload` | POST | — | ChromaDB `knowledge_base`（txt / md / json） |
| `/knowledge/stats` | GET | ChromaDB `knowledge_base` | — |
| `/monitor` | GET | AgentStats、ToolStats、告警、建议 | — |
| `/metrics` | GET | Prometheus 注册表 | — |
| `/skills` | GET | SkillManager 内存态 | — |
| `/skills/reload` | POST | `skills/` 目录 | SkillManager 内存态、Orchestrator 引用 |
| `/eval/run` | POST | Orchestrator、IntentRecognizer、baseline | `data/eval/baseline.json` |
| `/health` | GET | Orchestrator 就绪态 + AgentStats | — |

---

## 11. 关键状态常量速查

| 常量 | 值 | 位置 | 作用 |
|------|-----|------|------|
| `WORKING_MAX` | 20 | `MemoryManager` | 工作记忆单次读取上限 |
| `COMPRESS_AT` | 15 | `MemoryManager` | 触发 LLM 压缩的消息数阈值 |
| 压缩保留量 | 最近 5 条 | `_compress` | 压缩后工作记忆长度 |
| Redis TTL | 86400s | `add_message` / `_compress` | 工作记忆与摘要过期时间 |
| `HISTORY_TOP_K` | 5 | `MemoryManager` | 情景记忆检索条数 |
| `confidence_threshold` | 0.5 | `IntentRecognizer` | 低于该值降级为 OTHER |
| 融合权重 | 0.7 / 0.2 / 0.1 | `_vote` | LLM / Embedding / Pattern；无 Embedding 时 0.85 / 0.15 |
| `failure_threshold` | 5 | `CircuitBreaker` | 连续失败开启熔断 |
| `recovery_s` | 60.0 | `CircuitBreaker` | OPEN 转 HALF_OPEN 探测间隔 |
| `cache_ttl` | 300s | `knowledge_search` 注册参数 | 工具结果缓存时长 |
| `timeout_s` | 30.0 | `Tool.timeout_s` | 工具执行超时 |
| 缓存容量 | 5000 条 | `_set_cache` | 超出清掉最旧 1/4 |
| 辅助 Agent 门槛 | ≥ 0.45 且 ≥ 主分 × 0.55 | `_route_decision` | 是否纳入并行协作 |
| 切片大小 | 500 字 | `KnowledgeBase._chunk_text` | 文档导入切片 |
| 采集间隔 | 10s | `MONITOR_INTERVAL` | 监控采样周期 |
| Z-score 灵敏度 | 2.5（窗口 60） | `AnomalyDetector` | 异常判定 |
| 路由惩罚上限 | 0.9 | `_routing_penalty` | monitor_penalty 封顶 |
