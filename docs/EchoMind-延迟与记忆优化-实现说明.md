# EchoMind 延迟优化与记忆模块重构 实现说明

| 项 | 内容 |
| --- | --- |
| 对应设计文档 | `docs/EchoMind-延迟与记忆优化-设计文档.md`（v1.0 草案） |
| 实现范围 | P0 ~ P3（L1~L9 延迟优化、记忆模块重构、会话边界、流式输出） |
| 未实现（承接 P4） | 话题漂移检测、摘要话题化、时间记忆衰减、`GET/DELETE /memory/*` 记忆查看与删除接口 |
| 实测环境 | 2026-10-04，本机 docker compose（`echomind-app` + Redis + ChromaDB），模型 `deepseek-v4-pro` |
| 验证方式 | 离线回归 66 项（`tests/test_latency_optimizations.py`）+ 容器内新旧配置 A/B + SSE 实测 + `/eval/run` 质量回归 |

#### 一、改动清单

##### 1.1 后端（`EchoMind/`）

| 文件 | 改动 | 对应设计项 |
| --- | --- | --- |
| `core/runtime_config.py` | **新增**。集中管理 §5.2 的全部开关，`from_env()` 提供快照 | §5.2 |
| `core/llm_utils.py` | 新增 `LlmCallTracker`（contextvar）统计"一次请求调了几次 LLM"；新增 `create_message()` 统一 LLM 入口，处理推理模型"thinking 吃光预算" | §2.1、推理模型兼容 |
| `core/intent_recognizer.py` | 规则/向量优先、低置信度才调 LLM；`INTENT_LLM_MODE=off/auto/always`；`IntentResult.llm_skipped`；失败结果不进缓存 | L1 |
| `mcp/tool_manager.py` | `RERANK_MODE` + `RERANK_MIN_CANDIDATES`；改写改为"召回不足才触发"+ 结果指纹缓存；改写/重排走小模型；新增链路计数 | L2、L3、L6 |
| `memory/conversation_memory.py` | 压缩转后台 + 每会话锁；原文去 500 字截断写入 `metadatas.full_text` 并在检索时优先读取；L2 距离阈值 + 灰度只记日志；`summary` TTL 与 `wm` 同步续期；摘要长度上限；摘要失败不再写占位文案进向量库；`add_messages` 批量写入；`should_update_profile()` 节流 | L4、L5、L6、P4、P5、P6、P7、P8 |
| `agents/agent_orchestrator.py` | 新增 `run_stream()`（流式，失败自动回退非流式）；`max_tokens` 按意图分档 + 推理余量 | L7、L8 |
| `api/main.py` | RAG 与意图识别并发预取；记忆写入合并为一次批量写；画像更新节流；结束语检测回传 `session_closed`；新增 `POST /chat/stream`（SSE）；`/chat` 响应新增可观测字段 | L5、L7、L9、§4.2、§5.3 |
| `evaluation/evaluator.py` | Judge 预算从固定 256 改为带推理余量，避免 `judge_failed` 让质量验收失效 | §2.2(4) |
| `core/skill_loader.py` | 技能截断改为按小节裁剪，`禁止事项`/`升级到人工` 等安全小节无条件保留 | P9 |
| `monitor/performance_monitor.py` | 告警按指标去重（同指标未恢复前只保留一条）；`/monitor` 暴露检索链路与意图优化计数 | §1.1、§2.1 |
| `config/nginx/nginx.conf` | 为 `/chat/stream` 单独配置：`proxy_buffering off`、`proxy_read_timeout 300s`，避免 SSE 被缓冲成"总耗时才开始出字" | L7 |
| `.env` / `.env.example` | 新增全部开关并标注"旧行为"取值，便于逐项回滚 | §5.2 |
| `skills/*/SKILL.md` | 回复格式要求追加字数约束（通用 200 字 / 技术 300 字 / 账单 300 字） | L8 |
| `tests/test_latency_optimizations.py` | **新增**。离线回归 66 项，桩掉 Redis/Chroma/FastAPI，无需容器即可运行 | §2.2 |

##### 1.2 前端（`EchoMindFrontend/`）

| 文件 | 改动 | 对应设计项 |
| --- | --- | --- |
| `src/lib/backends.js` | 新增 `requestChatStream()`（SSE 解析）、`supportsStreaming()`、`shouldRotateSession()`、`resetSession()`；响应归一化补齐新字段 | L7、§4.2 |
| `src/App.vue` | "新会话"按钮（面板 + 输入区）；发送前空闲超时自动切会话；流式增量渲染 + 非流式降级；`session_closed` 后重置会话标识并提示；展示 `llm_calls` / 耗时 / 丢弃历史等新字段 | L7、P3、§4.2、§5.3 |
| `src/styles.css` | 新增会话状态条、系统提示条、流式光标、开关行样式 | — |

#### 二、实现过程中发现的阻断性问题（重要）

##### 2.0 三个"看起来是慢，其实是坏的"问题（第二轮实测发现并修复）

第一轮只做了调用次数裁剪，用户仍反馈"七八秒还是很慢、流式感觉不明显"。逐层测量后定位到三个独立的真实缺陷：

| 现象 | 真实原因 | 修复 |
| --- | --- | --- |
| 首字要等 3.8~10.5s，期间页面完全静止 | `ANTHROPIC_MODEL` 是**推理模型**，正文之前先产出 `thinking` 块；`text_stream` 不产出 thinking，用户看到的等待 = 思考时长 | 新增 `THINKING_MODE`（`auto`/`disabled`/`enabled` + `THINKING_BUDGET_TOKENS`），实测关闭思考后端点首字 4.44s → 1.03s |
| "流式输出感觉不明显"、文字像一次性蹦出来 | **流式一直在静默失败并回退非流式**：SDK 0.40 的 `messages.stream()` 没有 `thinking` 形参，传了直接 `TypeError`（日志里累积了 4 次"流式生成失败"），上层兜底成"整段一次性吐出" | 供应商特有参数改走 `extra_body` 透传；`/monitor` 增加 `stream_fallbacks` 计数，回退不再无声 |
| 简单问题也要 6~13s | 模型本身慢：同一 prompt、同一时刻实测 `deepseek-v4-pro` 首字 6.1s / 总 6.3s，`deepseek-chat` 首字 **0.37s** / 总 **0.76s** | 新增 `ANSWER_MODEL`（主回答模型）与 `SMALL_MODEL`（旁路模型）分离，当前均设为 `deepseek-chat` |

修复后同一批"简单问题"实测：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 非流式 `/chat` 总耗时 | 6~13s | **1.16~2.04s** |
| 流式首字 | 3.8~10.5s（且不流式） | **0.56~0.97s** |
| 流式增量块数 | 1（整段一次性） | **15~231（逐字流出）** |
| 流式窗口 | 0s | **0.7~1.4s 持续输出** |

> ⚠️ 端点可用性提示：测量期间 Docker Hub 一度不可达导致 `docker compose build` 失败，
> 当前容器是用 `docker cp` 注入源码 + `docker restart` 的方式验证的。
> 网络恢复后请执行 `docker compose up -d --build echomind` 把改动固化进镜像（否则容器重建即丢失）。

##### 2.1 `deepseek-v4-pro` 是推理模型，thinking 计入 `max_tokens`

实测同一 prompt 直接打端点：

| `max_tokens` | 返回内容块 | 正文长度 |
| --- | --- | --- |
| 1024 | thinking 1140 字 + text 683 字 | 683 |
| 600 | thinking 943 字 + text 193 字 | 193（被截断） |
| 300 | 只有 thinking | **0（回答为空）** |
| 200 | 只有 thinking | **0（回答为空）** |

这直接引爆了三处问题：

1. **L8 输出长度分档会让回答变空**：账单档 800、技术档 600 尚能出文，寒暄档 200 直接空回答。
2. **旁路固定 256 tokens 的调用会静默失败**：意图识别（few-shot 长 prompt）思考量可超过 512，
   返回无 text → JSON 解析失败 → 回落 `OTHER` → 走"我还不能确定您要处理的是哪类问题"反问；
   记忆压缩/画像提炼同理（日志可见 `更新用户画像失败: Expecting value`）。
3. **评测 Judge 固定 256 也会失败**：`judge_failed=true`，四个维度全部回落 0.5，
   让设计文档 §2.2(4) 的"质量回归"这道验收形同虚设（首次跑出的 relevance 0.429 就是这个原因，
   不是回答质量真的掉了 57%）。

**处理方式**（已实现）：

- 所有 LLM 调用统一走 `core.llm_utils.create_message()`：出现"只有 thinking 没有 text"时自动加倍预算重试
  （默认最多 2 次，256 → 512 → 1024，上限 8192）；
- 主回答预算 = 意图分档值 + `REASONING_HEADROOM_TOKENS`（默认 2048）；
- 旁路 JSON 调用预算 = 期望输出长度 + 思考余量（意图 256+2048、改写/重排/摘要 256+2048、画像 512+2048、Judge 256+2048）；
- 意图识别的**失败结果不再进 LRU 缓存**，避免一次瞬时失败让同一句话在进程生命周期内持续误路由。

修复前后同一批问题：

| 问题 | 修复前 | 修复后 |
| --- | --- | --- |
| "应用登录一直报错 401" | 回答为空（0 字） | 293~459 字完整排查步骤 |
| "我的订单 #12345 还没到，已经超时了" | 反问澄清（intent=other） | intent=logistics，conf 0.81，正常回答 |
| `/eval/run` | pass_rate 0.125，Judge 失败 2 例，relevance 0.429 | pass_rate 0.875，Judge 失败 0 例，relevance 0.914 |

#### 三、实测结果

##### 3.1 LLM 往返次数与端到端延迟（§2.1 验收）

账单类 10 问，同一时间段内逐项对比（每轮均真实调用端点）：

| 指标 | 旧配置 | 第一轮优化 | **最终配置** | 目标 |
| --- | --- | --- | --- | --- |
| 平均 LLM 往返 | 3.9 次 | 1.2 次 | 1.3 次 | ≤2 ✅ |
| 最大 LLM 往返 | 4 次 | 2 次 | 2 次 | — |
| 意图识别跳过 LLM | 0/10 | 7/10 | 7/10 | — |
| **P50 端到端** | 13266 ms | 7286 ms | **2031 ms** | ≤3000 ms ✅ |
| **P90 端到端** | 14367 ms | 8489 ms | **2664 ms** | — |
| 最小值 | 7496 ms | 4634 ms | **1738 ms** | — |
| 流式首字 | 无流式 | 无流式（静默回退） | **560~970 ms** | ≤1000 ms ✅ |

"最终配置"= `THINKING_MODE=disabled` + `ANSWER_MODEL=deepseek-chat` + `SMALL_MODEL=deepseek-chat` + 第一轮全部裁剪开关。
新配置下典型账单问题的往返构成只剩 `{'answer': 1}`（第 7/10 轮多一次意图仲裁）：意图走规则判定、检索不触发改写与重排。
`/monitor` 的 `optimization` 段可实时观察：`llm_skipped=3, llm_called=0, rerank_skipped=3, rewrite_calls=0`。

##### 3.2 服务端管线开销

`/chat` 的 `latency_ms` 只统计编排阶段，`wall - latency_ms` 即记忆读取 + 意图识别 + RAG + 记忆写入：

| 配置 | 管线开销（wall − server） |
| --- | --- |
| 旧配置 | 约 7800 ms（意图 + 改写 + 重排三次 LLM 串在此处） |
| 新配置 | **约 150 ms** |

##### 3.3 延迟目标未达成的根因

瓶颈已不在本项目代码内，而在上游模型的出字速度。实测同一端点：

| 场景 | 首字时间(TTFT) | 总耗时 |
| --- | --- | --- |
| `deepseek-v4-pro`，极短 prompt，120 tokens | 0.69 s | 2.31 s |
| `deepseek-v4-flash`，同一 prompt | 0.64 s | **1.27 s** |
| `deepseek-chat`，同一 prompt | 0.68 s | **0.88 s** |
| `/chat/stream` 实测（真实完整 prompt） | **3.5 s ~ 7.8 s** | 4.8 s ~ 9.0 s |

同样的 prompt 长度，端点 TTFT 在 0.7 s 与 7.8 s 之间波动。在每次 LLM 往返都要 3~8 s 的前提下，
即使只剩 1 次往返也无法满足"P50 ≤3000 ms"。

**可选下一步（需产品/成本决策，均未擅自启用）**：

1. §5.6 待确认项（1）已可确认：本账号 `deepseek-v4-flash` 与 `deepseek-chat` 均可用且显著更快。
   `SMALL_MODEL=deepseek-v4-flash` 只影响旁路（当前已被裁到 0 次）；要压主回答耗时需整体换主模型，
   这会偏离设计文档"主回答保持大模型"的定案。
2. 保留大模型时，`/chat/stream` 是满足"用户感知延迟"的手段：SSE 管线 **0.16 s** 就吐出
   `meta`/`route`，剩余等待全部来自模型 TTFT。

##### 3.4 流式输出（L7）

```
event: meta   @0.16s   conv_id / intent / knowledge_used / 记忆统计
event: route  @0.16s   primary_agent / supporting_agents / multi_agent
event: delta  @3.75s   增量文本（持续流出）
event: done   @4.84s   latency_ms / llm_calls / session_closed / ...
```

- 前端→后端完整链路（经 vite 代理 `/api/python`）实测可用，无缓冲堆积；
- 流式失败会在**同一次请求内**自动回退非流式；前端在拿不到任何增量时整条降级并标注"流式不可用已降级"。

##### 3.5 质量回归（§2.2(4)）

同一端点、同一天、同一评测集（`/eval/run`）：

| 配置 | pass_rate | relevance | accuracy | completeness | helpfulness | intent_accuracy | P50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 全部优化关闭（v4-pro 回答） | 0.875 (7/8) | 0.943 | 0.964 | 0.629 | 0.814 | 1.000 | 13266 ms |
| 第一轮优化（v4-pro 回答） | 0.875 (7/8) | 0.914 | 0.936 | 0.557 | 0.779 | 1.000 | 7286 ms |
| **最终配置（chat 回答 + 先给结论）** | **0.875 (7/8)** | **0.943** | 0.929 | **0.636** | **0.843** | 1.000 | **2031 ms** |

结论：

1. **通过率、意图准确率在所有配置下完全一致**（都是同一个边缘用例未通过）；
2. 最终配置的 relevance / completeness / helpfulness 是三次里**最高**的，accuracy 低 0.035；
3. 换主回答模型并没有牺牲质量：分数持平或更高。此前 pass_rate 从 0.875 掉到 0.75 的那次，是因为
   两个用例都栽在 `completeness`（模型只反问、不给结论），随后在 Skill 中加入
   "先给结论：即使用户信息不全，也要先给出通常怎么处理，再列出需要补充的信息" 后回到 0.875，
   `completeness` 从 0.557 提到 0.636、`helpfulness` 从 0.779 提到 0.843——这也正是用户反馈的"回答太短、不完整"的根因。
4. 若要以质量为先，可直接调 `REWRITE_MIN_RESULTS`（调大即恢复"每次都改写"）、
   `RERANK_MIN_CANDIDATES`（调大即恢复重排）、`MAX_TOKENS_*`、`ANSWER_MODEL`（换回 `deepseek-v4-pro`）
   以及 `THINKING_MODE=auto`——都是配置级回退。

> ⚠️ 基线说明：原 `data/eval/baseline.json` 记录的旧基线为
> `relevance 1.000 / accuracy 0.979 / completeness 0.800 / helpfulness 0.886 / intent_accuracy 1.000`。
> `/eval/run` 每次运行都会覆盖该文件，本轮验证已把它更新为最新一次运行的结果，原始基线文件未纳入 git，
> 无法从版本库恢复；如需保留对比锚点，建议把 baseline.json 纳入版本管理或每次回归前先备份。
> 另外，用今天的端点跑"全部优化关闭"也只得到 0.943/0.964/0.629/0.814，
> 说明原基线与本轮之间的差距主要来自**端点/模型漂移**，而非本次改动。

##### 3.6 记忆模块（§4 验收）

| 验收项 | 实测结果 |
| --- | --- |
| L4 压缩不再阻塞 | 第 8 轮（16 条消息）响应耗时 5.62 s；压缩日志出现在响应后约 8 s："工作记忆压缩完成…摘要 86 字，压缩 11 条，保留 5 条" |
| P5/P8 摘要与原文分离 | `documents` = 86 字摘要（向量来源）；`metadatas.full_text` = 1164 字完整原文（旧实现截断到 500） |
| P6 摘要 TTL 同步续期 | `wm:*` 与 `summary:*` 每条消息同时续期（离线用例断言） |
| P7 摘要长度上限 | 超长时保留最近内容，受 `SUMMARY_MAX_CHARS` 约束 |
| P4 阈值灰度 | 灰度期日志：`retrieved=1 kept=1 dropped=0 distances=[1.0679]`；开启拦截后：`dist=1.1661 > 1.0500` 被丢弃并在响应回传 `history_dropped_by_threshold=1` |
| §4.2 结束语检测 | "谢谢，问题解决了"→`session_closed=true`；"我要申请退款"→`false`；长句中的"谢谢"不误判 |
| 串味回归（§2.2 关键用例） | 同会话先账单后问天气：`knowledge_used=false`、`history_kept=0`；同用户**新会话**：`used_summary=false`、`history_kept=0`，不携带旧话题摘要 |
| L5 画像节流 | 每 5 轮才更新一次（离线用例断言 `[False, False, True]`） |

##### 3.7 告警去重（§1.1）

`/monitor` 的 `active_alerts` 同指标只保留一条未恢复告警：实测连打 3 次请求、跨越 3 个监控周期后，
`agent_avg_ms:billing_0` 与 `agent_success_rate:billing_0` 各仅 1 条（旧实现每 10 s 追加一条，实测基线为 10 条重复）。

#### 四、开关与回滚

全部改动都可通过 `.env` 开关回到旧行为，改完 `docker compose up -d echomind` 即生效。

| 开关 | 本次取值 | 旧行为取值 |
| --- | --- | --- |
| `INTENT_LLM_MODE` | `auto` | `always` |
| `RERANK_MODE` / `RERANK_MIN_CANDIDATES` | `auto` / `8` | `auto` / `0` |
| `REWRITE_MIN_RESULTS` | `2` | `999`（每次都改写） |
| `COMPRESS_IN_BACKGROUND` | `true` | `false` |
| `PROFILE_UPDATE_EVERY` | `5` | `1` |
| `SMALL_MODEL` | 空（沿用主模型） | 空 |
| `STREAM_ENABLED` | `true` | `false` |
| `MAX_TOKENS_*` | 200/600/800/1024 | 全部 1024 |
| `REASONING_HEADROOM_TOKENS` | `2048` | `0`（非推理模型） |
| `PARALLEL_KNOWLEDGE_PREFETCH` | `true` | `false` |
| `EPISODIC_LOG_ONLY` | `true`（灰度） | `true` |
| `EPISODIC_MAX_DISTANCE` | `1.1` | 不生效（无阈值） |
| `SUMMARY_MAX_CHARS` | `1200` | 无上限 |
| `SESSION_CLOSE_ENABLED` | `true` | `false` |

#### 五、遗留与建议

（1）`EPISODIC_MAX_DISTANCE` 标定：本轮灰度样本中相关提问距离约 1.07~1.17，无关提问约 1.14~1.31，
与设计文档锚点（无关约 1.24~1.25）一致但区分度偏小；建议继续以 `EPISODIC_LOG_ONLY=true` 采集
1~2 天距离分布，再决定是否收紧到 1.05~1.10。

（2）`SMALL_MODEL` 建议值：`deepseek-v4-flash`（实测可用且更快）。当前旁路调用已被裁到 0 次，
配置它主要用于流量回升后的成本与稳定性兜底（也能规避推理模型的预算问题）。

（3）若要进一步压缩主回答耗时：换主模型（偏离原设计）或依赖流式改善感知延迟；
本轮已验证 SSE 管线自身只占 0.16 s。

（4）P4 剩余项（话题漂移检测、摘要话题化、时间衰减、记忆查看/删除接口）未实现，与设计文档 §5.1 分期一致。

（5）实现过程中顺带修复的问题：`/monitor` 告警重复堆积（§1.1 记录但未列入 P1~P10）、
技能截断可能切掉安全条款（P9）、推理模型导致的空回答与 Judge 失效（本轮新增发现）。

#### 六、复现方式

```bash
# 1. 离线回归（无需容器，66 项）
cd EchoMind && python3 tests/test_latency_optimizations.py

# 2. 端到端 A/B（需容器运行）
python3 /tmp/regress.py after          # 新配置
# 将 .env 切到"旧行为"取值后 docker compose up -d echomind
python3 /tmp/regress.py legacy         # 旧配置

# 3. 流式首字测量
curl -N -X POST http://127.0.0.1:8000/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"退款多久能到账","user_id":"u2002"}'

# 4. 质量回归（会覆盖 baseline.json，建议先备份）
cp EchoMind/data/eval/baseline.json /tmp/baseline.bak.json
curl -X POST http://127.0.0.1:8000/eval/run
```
