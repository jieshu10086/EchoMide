# EchoMind Frontend

独立 Vue 前端项目，用于调试 / 演示 EchoMind Python 版本的对话能力。

项目目录：

```text
./EchoMindFrontend
```

## 功能

- 界面固定连接 Python 版后端，支持 SSE 流式输出：逐字渲染回答，等待首字期间显示阶段文案与计时。
- 流式完全失败时自动降级为非流式 `/chat`，保证用户不会看到空回答。
- 统一适配 `/chat` 与 `/chat/stream` 的响应字段（`conv_id`、`intent`、`primary_agent`、`latency_ms`、`llm_calls`、`escalated` 等），以标签形式挂在每条回答下方。
- 回答按 Markdown 渲染（标题、加粗、列表、引用、表格、代码块），由内置的 `src/lib/markdown.js` 完成，无第三方依赖。
- 会话边界管理：手动「新会话」与空闲超时自动切会话（设计文档 §4.2），切会话不携带旧话题记忆。
- 连接配置（API 地址 / 用户 ID / 会话 ID / 流式开关 / 空闲阈值）收在顶栏「设置」折叠区，不占用对话空间。
- 支持 Docker + Nginx 部署。

> 说明：`src/lib/backends.js` 仍保留 Java 后端的适配层，Vite 也仍配置了 `/api/java` 代理，
> 因此后续若要让界面重新支持 Java 版，只需恢复一个后端切换入口即可。

## 默认后端地址

| 后端 | 默认地址 |
|------|----------|
| Python | `http://localhost:8000` |
| Java | `http://localhost:8080` |

开发模式下，Vite 会代理：

| 前端路径 | 代理到 |
|----------|--------|
| `/api/python` | `http://localhost:8000` |
| `/api/java` | `http://localhost:8080` |

Docker 模式下，Nginx 会通过运行时注入的地址访问后端。默认仍指向宿主机上的 Python / Java 服务。

## 本地运行

安装依赖：

```bash
npm install
```

启动：

```bash
npm run dev
```

访问：

```text
http://localhost:5173
```

如果后端端口不是默认值，可以启动时覆盖：

```bash
VITE_PYTHON_API_URL=http://localhost:8000 \
VITE_JAVA_API_URL=http://localhost:8080 \
npm run dev
```

## Docker 部署

直接构建并启动三服务：

```bash
docker compose up -d --build
```

前提是 `EchoMindFrontend` 的父目录下有这三个目录：

```text
../EchoMind
../EchoMindJava
./
```

访问前端：

```text
http://localhost
```

如果只想暴露前端端口，可改 `FRONTEND_PORT`，默认仍可通过 `80` 统一入口访问。

停止：

```bash
docker compose down
```

## 后端启动参考

Python 版默认：

```text
http://localhost:8000
```

Java 版默认：

```text
http://localhost:8080
```

两个后端不需要同时启动。前端页面里选择当前要调试的后端即可。
