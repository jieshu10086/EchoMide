#!/usr/bin/env python3
"""
EchoMind 记忆数据备份 / 清理工具（在 echomind-app 容器内运行）。

覆盖三类数据：
  1. 会话历史 —— Redis List  wm:{user_id}:{conv_id}
  2. 会话摘要 —— Redis String summary:{user_id}:{conv_id}
  3. 用户画像 —— ChromaDB collection `user_profile`
     以及长期会话历史 ChromaDB collection `episodic`

另外清理 profile_tick:{user_id}:{conv_id}（画像更新节流计数器，派生元数据，
不清会残留"已更新 N 轮"的计数状态）。

不动 knowledge_base（知识库）与任何业务数据。

用法（容器内）：
    python memory_admin.py backup [输出目录]
    python memory_admin.py clear
    python memory_admin.py report
"""
from __future__ import annotations

import json
import os
import sys
import time

import chromadb
import redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://:echomind123@redis:6379/0")
CHROMA_HOST = os.environ.get("CHROMA_HOST", "chromadb")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))

REDIS_PATTERNS = ["wm:*", "summary:*", "profile_tick:*"]
CHROMA_COLLECTIONS = ["episodic", "user_profile"]
PROTECTED_COLLECTIONS = ["knowledge_base"]


def redis_client() -> redis.Redis:
    return redis.from_url(REDIS_URL, decode_responses=True)


def chroma_client() -> chromadb.ClientAPI:
    return chromadb.HttpClient(
        host=CHROMA_HOST,
        port=CHROMA_PORT,
        settings=chromadb.Settings(anonymized_telemetry=False),
    )


def scan_keys(r: redis.Redis) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for pattern in REDIS_PATTERNS:
        found[pattern] = sorted(r.scan_iter(match=pattern, count=500))
    return found


def read_key(r: redis.Redis, key: str) -> dict:
    kind = r.type(key)
    ttl = r.ttl(key)
    if kind == "list":
        raw = r.lrange(key, 0, -1)
        value = [json.loads(item) for item in raw]
    elif kind == "string":
        value = r.get(key)
    else:
        value = None
    return {"type": kind, "ttl_seconds": ttl, "value": value}


def do_backup(out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    r = redis_client()
    client = chroma_client()
    meta = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "redis_url_db": REDIS_URL.rsplit("/", 1)[-1]}

    # ── Redis ────────────────────────────────────────────────────────────────
    keys = scan_keys(r)
    redis_dump = {}
    for pattern, matched in keys.items():
        for key in matched:
            redis_dump[key] = read_key(r, key)
    with open(os.path.join(out_dir, "redis_memory.json"), "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "keys": redis_dump}, fh, ensure_ascii=False, indent=2)

    # 可读版：把会话原文按会话拼成纯文本，方便直接查看
    with open(os.path.join(out_dir, "chat_transcript.txt"), "w", encoding="utf-8") as fh:
        for key in keys["wm:*"]:
            fh.write(f"\n{'=' * 70}\n### {key}  (TTL {r.ttl(key)}s)\n{'=' * 70}\n")
            for item in reversed(r.lrange(key, 0, -1)):
                msg = json.loads(item)
                fh.write(f"[{msg.get('ts', '?')}] {msg.get('role', '?')}: {msg.get('content', '')}\n\n")
        for key in keys["summary:*"]:
            fh.write(f"\n{'=' * 70}\n### {key}\n{'=' * 70}\n{r.get(key)}\n")

    # ── ChromaDB ─────────────────────────────────────────────────────────────
    chroma_dump = {}
    for name in CHROMA_COLLECTIONS:
        col = client.get_collection(name)
        data = col.get(include=["documents", "metadatas"])
        chroma_dump[name] = {
            "count": col.count(),
            "ids": data.get("ids", []),
            "documents": data.get("documents", []),
            "metadatas": data.get("metadatas", []),
        }
    with open(os.path.join(out_dir, "chroma_memory.json"), "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "collections": chroma_dump}, fh, ensure_ascii=False, indent=2)

    with open(os.path.join(out_dir, "MANIFEST.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "meta": meta,
                "redis_key_counts": {p: len(k) for p, k in keys.items()},
                "chroma_counts": {n: v["count"] for n, v in chroma_dump.items()},
                "protected_collections": PROTECTED_COLLECTIONS,
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )

    print(f"[backup] 输出目录: {out_dir}")
    for pattern, matched in keys.items():
        print(f"[backup] Redis {pattern}: {len(matched)} 个 key")
    for name, payload in chroma_dump.items():
        print(f"[backup] Chroma {name}: {payload['count']} 条")
    return 0


def do_clear() -> int:
    r = redis_client()
    client = chroma_client()
    keys = scan_keys(r)

    # Redis：按 pattern 汇总去重后删除
    to_delete = sorted({k for matched in keys.values() for k in matched})
    deleted = r.delete(*to_delete) if to_delete else 0
    print(f"[clear] Redis 删除 {deleted} 个 key（命中 {len(to_delete)} 个）")

    # ChromaDB：逐条删除文档，保留 collection 本身及其 embedding 配置
    for name in CHROMA_COLLECTIONS:
        col = client.get_collection(name)
        before = col.count()
        ids = col.get(include=[]).get("ids", [])
        if ids:
            col.delete(ids=ids)
        print(f"[clear] Chroma {name}: {before} 条 -> {col.count()} 条")

    for name in PROTECTED_COLLECTIONS:
        try:
            col = client.get_collection(name)
            print(f"[keep ] Chroma {name}: {col.count()} 条（未改动）")
        except Exception as ex:
            print(f"[keep ] Chroma {name}: 读取失败 {ex}")
    return 0


def do_report() -> int:
    r = redis_client()
    client = chroma_client()
    keys = scan_keys(r)
    total_msgs = 0
    for key in keys["wm:*"]:
        total_msgs += r.llen(key)
    print(f"Redis wm:*           {len(keys['wm:*'])} 个会话 / {total_msgs} 条消息")
    print(f"Redis summary:*      {len(keys['summary:*'])} 个摘要")
    print(f"Redis profile_tick:* {len(keys['profile_tick:*'])} 个节流计数")
    for name in CHROMA_COLLECTIONS + PROTECTED_COLLECTIONS:
        try:
            print(f"Chroma {name:<15} {client.get_collection(name).count()} 条")
        except Exception as ex:
            print(f"Chroma {name:<15} 读取失败 {ex}")
    print(f"Redis DBSIZE         {r.dbsize()}")
    return 0


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else "report"
    if action == "backup":
        default = f"/tmp/echomind-memory-backup-{time.strftime('%Y%m%d-%H%M%S')}"
        return do_backup(sys.argv[2] if len(sys.argv) > 2 else default)
    if action == "clear":
        return do_clear()
    if action == "report":
        return do_report()
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
