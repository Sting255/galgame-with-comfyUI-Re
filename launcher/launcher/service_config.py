"""服务地址与进程归属；保持与后端 PORT 配置一致。"""
import os
import re
from pathlib import Path


def _configured_port(project_path, key, default, environ=None):
    env = os.environ if environ is None else environ
    value = env.get(key)
    if value is None:
        path = Path(project_path) / "agent-core" / ".env"
        if path.is_file():
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                match = re.match(rf"^\s*(?:export\s+)?{re.escape(key)}\s*=\s*(.*)$", line)
                if match:
                    raw = match.group(1).strip()
                    if raw.startswith(('"', "'")):
                        closing_quote = raw.find(raw[0], 1)
                        if closing_quote < 0:
                            raise ValueError(f"{key} has an unclosed quote")
                        value = raw[1:closing_quote]
                    else:
                        value = raw.split("#", 1)[0].strip()
    if value is None or value == "":
        return default
    if not re.fullmatch(r"[0-9]+", value.strip()) or not 1 <= int(value) <= 65535:
        raise ValueError(f"{key} must be an integer between 1 and 65535")
    return int(value)


def service_port(project_path, environ=None):
    return _configured_port(project_path, "PORT", 3099, environ)


def vector_service_port(project_path, environ=None, *, default=8765):
    """default=None 可区分未配置，避免覆盖用户既有的远程向量地址。"""
    return _configured_port(project_path, "VECTOR_PORT", default, environ)


def belongs_to_project(proc, project_path):
    root = os.path.normcase(os.path.realpath(project_path))
    try:
        cwd = os.path.normcase(os.path.realpath(proc.cwd()))
        return os.path.commonpath([cwd, root]) == root
    except (OSError, ValueError):
        return False
