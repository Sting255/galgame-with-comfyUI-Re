"""服务地址与进程归属；保持与后端 PORT 配置一致。"""
import os
import re
from pathlib import Path


def service_port(project_path, environ=None):
    env = os.environ if environ is None else environ
    value = env.get("PORT")
    if value is None:
        path = Path(project_path) / "agent-core" / ".env"
        if path.is_file():
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                match = re.match(r"^\s*(?:export\s+)?PORT\s*=\s*(.*)$", line)
                if match:
                    raw = match.group(1).strip()
                    if raw.startswith(('"', "'")):
                        value = raw[1:raw.find(raw[0], 1)]
                    else:
                        value = raw.split("#", 1)[0].strip()
    if value is None or value == "":
        return 3099
    if not re.fullmatch(r"[0-9]+", value.strip()) or not 1 <= int(value) <= 65535:
        raise ValueError("PORT must be an integer between 1 and 65535")
    return int(value)


def belongs_to_project(proc, project_path):
    root = os.path.normcase(os.path.realpath(project_path))
    try:
        cwd = os.path.normcase(os.path.realpath(proc.cwd()))
        return os.path.commonpath([cwd, root]) == root
    except (OSError, ValueError):
        return False
