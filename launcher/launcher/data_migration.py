"""
数据迁移（旧版本安装目录 → 当前安装目录）的纯逻辑，不依赖 Qt，便于单独验证。

2026-11-20（规划 N8）重写的原因——原实现（settings_page.MigrateWorker）：
  · 不检查旧版本 / 新版本的服务是否还在运行，WAL 模式下逐个复制 agent.db、-wal、-shm，
    运行中的库会被复制成不一致的快照；
  · 直接覆盖目标、没有备份也没有回滚，中途失败就留下新旧混合的数据；
  · 目标里多出来的旧 -wal（先启动过一次新版本）会和旧 agent.db 拼在一起。

现在的做法：
  1. 迁移前确认两个目录都没有本项目的 node / python 进程在跑，否则拒绝；
  2. 先把数据完整复制进同级的临时目录（data.migrating-*），旧目录与目标目录全程不动；
  3. SQLite 用 backup API 生成一致的单文件快照（源库三件套先拷到临时目录再读，源文件不被打开）；
  4. 目标里有、源里没有的普通文件（不含库文件）照旧保留，源里有的以源为准——与原来的合并口径一致；
  5. 快照通过 PRAGMA integrity_check 后才切换：目标原 data 改名为 data.pre-migrate-*（不删），
     临时目录改名为 data；任何一步失败都回到迁移前的状态。
  6. .env 同样先备份为 .env.pre-migrate-* 再覆盖。
  向量索引照旧不迁移（可重建的派生数据）。
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable

from .service_config import belongs_to_project

DATA_REL = os.path.join("agent-core", "data")
ENV_REL = os.path.join("agent-core", ".env")
# 图片压缩 cursor 只对原安装有效；迁移后复制它会让新版本误以为旧 PNG 已处理完。
EXCLUDE_DATA_FILES = {"image-compressor-state.json"}
# 位于 data 根目录、需要做一致快照的 SQLite 库；其 -wal / -shm / -journal 不单独复制
SQLITE_DATABASES = ("agent.db",)
SQLITE_SIDECARS = ("-wal", "-shm", "-journal")
SERVICE_PROCESS_NAMES = {"node.exe", "node", "python.exe", "pythonw.exe", "python"}


class MigrationError(Exception):
    """迁移被拒绝或失败；消息可以直接展示给用户。"""


@dataclass
class MigrationResult:
    copied_files: int = 0
    kept_target_files: int = 0
    skipped_links: int = 0
    databases: dict = field(default_factory=dict)   # 库名 → integrity_check 结果
    env_copied: bool = False
    data_backup: str | None = None
    env_backup: str | None = None


def _is_link(path: str) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)   # Python 3.12+
    if is_junction and is_junction(path):
        return True
    try:
        # 3.12 以下：Windows 目录联接是 reparse point，lstat 能看到
        return bool(getattr(os.lstat(path), "st_file_attributes", 0) & 0x400)
    except OSError:
        return False


def _is_sqlite_file(name: str) -> bool:
    return any(name == db or name.startswith(db + "-") for db in SQLITE_DATABASES)


def running_service_processes(roots: Iterable[str]) -> list[tuple[int, str, str]]:
    """返回工作目录位于任一 root 内的 node / python 进程：[(pid, name, root)]。不含启动器自己。"""
    try:
        import psutil
    except ImportError as exc:   # 正式包一定带 psutil；没有就宁可拒绝
        raise MigrationError("无法检查服务是否在运行（缺少 psutil），已取消迁移。") from exc
    roots = [r for r in roots if r and os.path.isdir(r)]
    me = psutil.Process(os.getpid())
    own = {me.pid, *(p.pid for p in me.parents())}
    found = []
    for proc in psutil.process_iter(["pid", "name"]):
        try:
            if proc.pid in own or (proc.info.get("name") or "").lower() not in SERVICE_PROCESS_NAMES:
                continue
            for root in roots:
                if belongs_to_project(proc, root):
                    found.append((proc.pid, proc.info["name"], root))
                    break
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return found


def _walk_files(base: str, result: MigrationResult) -> list[str]:
    """base 下的普通文件相对路径；目录联接 / 符号链接一律跳过（既不复制也不进入）。"""
    files = []
    for root, dirs, names in os.walk(base, followlinks=False):
        kept = []
        for d in dirs:
            if _is_link(os.path.join(root, d)):
                result.skipped_links += 1
            else:
                kept.append(d)
        dirs[:] = kept
        for name in names:
            full = os.path.join(root, name)
            if _is_link(full):
                result.skipped_links += 1
                continue
            files.append(os.path.relpath(full, base))
    return files


def snapshot_sqlite(source_db: str, dest_db: str) -> str:
    """生成 source_db 的一致快照到 dest_db，返回 integrity_check 结果。源文件只被复制、不被打开。"""
    with tempfile.TemporaryDirectory(prefix="linshe-migrate-db-") as staging:
        staged = os.path.join(staging, os.path.basename(source_db))
        shutil.copy2(source_db, staged)
        for suffix in SQLITE_SIDECARS:
            if os.path.isfile(source_db + suffix):
                shutil.copy2(source_db + suffix, staged + suffix)
        src = sqlite3.connect(staged)
        try:
            dst = sqlite3.connect(dest_db)
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
    check = sqlite3.connect(dest_db)
    try:
        return str(check.execute("PRAGMA integrity_check").fetchone()[0])
    finally:
        check.close()


def migrate_install(
    source_root: str,
    target_root: str,
    *,
    on_progress: Callable[[int, int], None] | None = None,
    on_item: Callable[[str], None] | None = None,
    check_processes: Callable[[list[str]], list] = running_service_processes,
) -> MigrationResult:
    source_root = os.path.abspath(source_root)
    target_root = os.path.abspath(target_root)
    if os.path.normcase(source_root) == os.path.normcase(target_root):
        raise MigrationError("源目录和目标目录相同，无需迁移。")
    src_data = os.path.join(source_root, DATA_REL)
    src_env = os.path.join(source_root, ENV_REL)
    if not os.path.isdir(src_data) and not os.path.isfile(src_env):
        raise MigrationError("所选目录里没有可迁移的数据（agent-core/data 或 agent-core/.env）。")

    running = check_processes([source_root, target_root])
    if running:
        detail = "；".join(f"{name}（PID {pid}，{root}）" for pid, name, root in running[:6])
        raise MigrationError(f"检测到仍在运行的服务：{detail}。请先在两个版本的启动器里停止服务（或关闭启动器）后再迁移。")

    result = MigrationResult()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    tgt_parent = os.path.join(target_root, "agent-core")
    tgt_data = os.path.join(target_root, DATA_REL)
    tgt_env = os.path.join(target_root, ENV_REL)
    staging = os.path.join(tgt_parent, f"data.migrating-{stamp}")
    os.makedirs(tgt_parent, exist_ok=True)

    try:
        os.makedirs(staging)
        # 1. 源数据 → 临时目录（库文件单独做快照）
        source_files = []
        if os.path.isdir(src_data):
            source_files = [f for f in _walk_files(src_data, result)
                            if os.path.basename(f) not in EXCLUDE_DATA_FILES and not _is_sqlite_file(f)]
        databases = [db for db in SQLITE_DATABASES if os.path.isfile(os.path.join(src_data, db))]
        target_only = []
        if os.path.isdir(tgt_data):
            source_set = {os.path.normcase(f) for f in source_files}
            target_only = [f for f in _walk_files(tgt_data, result)
                           if not _is_sqlite_file(f) and os.path.normcase(f) not in source_set]
        total = len(source_files) + len(databases) + len(target_only) + (1 if os.path.isfile(src_env) else 0)
        done = 0

        def step():
            nonlocal done
            done += 1
            if on_progress:
                on_progress(done, max(total, 1))

        if on_item:
            on_item(DATA_REL.replace(os.sep, "/"))
        for rel in source_files:
            dst = os.path.join(staging, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(src_data, rel), dst)
            result.copied_files += 1
            step()
        for db in databases:
            if on_item:
                on_item(f"{DATA_REL.replace(os.sep, '/')}/{db}（一致快照）")
            verdict = snapshot_sqlite(os.path.join(src_data, db), os.path.join(staging, db))
            result.databases[db] = verdict
            if verdict.lower() != "ok":
                raise MigrationError(f"{db} 快照完整性检查未通过：{verdict}。原数据未改动。")
            step()
        # 2. 目标独有的普通文件保留（与原来的合并口径一致；库文件除外）
        for rel in target_only:
            dst = os.path.join(staging, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(tgt_data, rel), dst)
            result.kept_target_files += 1
            step()
        # .env 也先放到同级临时文件，切换时用原子替换
        env_staging = None
        if os.path.isfile(src_env):
            if on_item:
                on_item(ENV_REL.replace(os.sep, "/"))
            env_staging = tgt_env + f".migrating-{stamp}"
            shutil.copy2(src_env, env_staging)
            step()
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        if os.path.isfile(tgt_env + f".migrating-{stamp}"):
            os.remove(tgt_env + f".migrating-{stamp}")
        raise

    # 3. 切换：目标原 data 改名备份（不删），临时目录就位；.env 备份后原子替换。任一步失败都复原
    backup = None
    swapped = False
    try:
        if os.path.exists(tgt_data):
            backup = os.path.join(tgt_parent, f"data.pre-migrate-{stamp}")
            os.rename(tgt_data, backup)
            result.data_backup = backup
        os.rename(staging, tgt_data)
        swapped = True
        if env_staging:
            if os.path.isfile(tgt_env):
                result.env_backup = tgt_env + f".pre-migrate-{stamp}"
                shutil.copy2(tgt_env, result.env_backup)
            os.replace(env_staging, tgt_env)
            result.env_copied = True
    except Exception as exc:
        if swapped and os.path.exists(tgt_data):
            os.rename(tgt_data, staging)
        if backup and not os.path.exists(tgt_data) and os.path.exists(backup):
            os.rename(backup, tgt_data)
            result.data_backup = None
        shutil.rmtree(staging, ignore_errors=True)
        if env_staging and os.path.isfile(env_staging):
            os.remove(env_staging)
        if result.env_backup and os.path.isfile(result.env_backup) and not result.env_copied:
            os.remove(result.env_backup)   # 原 .env 没被替换，这份备份多余
            result.env_backup = None
        raise MigrationError(f"切换数据失败（{exc}），已恢复迁移前的状态。") from exc
    return result
