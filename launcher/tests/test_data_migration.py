"""合成安装目录的迁移测试；不导入 Qt，不读取真实玩家数据。"""
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launcher.data_migration import migrate_install, MigrationError, snapshot_sqlite


class DataMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="linshe-migrate-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "旧 安装"
        self.target = self.root / "新 安装"
        for root in (self.source, self.target):
            (root / "agent-core/data/images").mkdir(parents=True)
            with closing(sqlite3.connect(root / "agent-core/data/agent.db")) as db:
                db.execute("CREATE TABLE records (value TEXT)")
                db.execute("INSERT INTO records VALUES (?)", (root.name,))
                db.commit()
            (root / "agent-core/.env").write_text("FIXTURE=" + root.name, encoding="utf8")

    def migrate(self, **kwargs):
        return migrate_install(str(self.source), str(self.target), check_processes=lambda roots: [], **kwargs)

    def value(self, root):
        with closing(sqlite3.connect(root / "agent-core/data/agent.db")) as db:
            return db.execute("SELECT value FROM records").fetchone()[0]

    def test_same_directory_rejected(self):
        with self.assertRaises(MigrationError):
            migrate_install(str(self.source), str(self.source), check_processes=lambda roots: [])

    def test_empty_source_rejected(self):
        with self.assertRaises(MigrationError):
            migrate_install(str(self.root / "absent"), str(self.target), check_processes=lambda roots: [])

    def test_running_service_rejected_before_writes(self):
        with self.assertRaises(MigrationError):
            migrate_install(str(self.source), str(self.target), check_processes=lambda roots: [(123, "node", roots[0])])
        self.assertEqual(self.value(self.target), self.target.name)

    def test_snapshot_assets_env_and_target_backup(self):
        source_db = self.source / "agent-core/data/agent.db"
        before = source_db.read_bytes()
        (self.source / "agent-core/data/images/shared.png").write_bytes(b"source")
        (self.target / "agent-core/data/images/shared.png").write_bytes(b"target")
        (self.target / "agent-core/data/images/target.png").write_bytes(b"keep")
        (self.source / "agent-core/data/image-compressor-state.json").write_text("{}")
        progress = []
        result = self.migrate(on_progress=lambda done, total: progress.append((done, total)))
        self.assertEqual(self.value(self.target), self.source.name)
        self.assertEqual(source_db.read_bytes(), before)
        self.assertEqual(result.databases, {"agent.db": "ok"})
        self.assertEqual((self.target / "agent-core/data/images/shared.png").read_bytes(), b"source")
        self.assertEqual((self.target / "agent-core/data/images/target.png").read_bytes(), b"keep")
        self.assertFalse((self.target / "agent-core/data/image-compressor-state.json").exists())
        self.assertTrue(Path(result.data_backup).is_dir())
        self.assertTrue(Path(result.env_backup).is_file())
        self.assertTrue(result.env_copied)
        self.assertEqual(progress[-1][0], progress[-1][1])

    def test_corrupt_database_does_not_replace_target(self):
        (self.source / "agent-core/data/agent.db").write_bytes(b"not sqlite")
        with self.assertRaises(Exception):
            self.migrate()
        self.assertEqual(self.value(self.target), self.target.name)
        self.assertEqual(list((self.target / "agent-core").glob("data.migrating-*")), [])

    def test_env_replace_failure_rolls_back_database_and_env(self):
        old_env = (self.target / "agent-core/.env").read_bytes()
        with patch("launcher.data_migration.os.replace", side_effect=OSError("fixture failure")):
            with self.assertRaises(MigrationError):
                self.migrate()
        self.assertEqual(self.value(self.target), self.target.name)
        self.assertEqual((self.target / "agent-core/.env").read_bytes(), old_env)
        self.assertEqual(list((self.target / "agent-core").glob("data.migrating-*")), [])

    def test_snapshot_with_wal_reads_committed_data(self):
        source = self.source / "agent-core/data/agent.db"
        with closing(sqlite3.connect(source)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("INSERT INTO records VALUES ('committed')")
            db.commit()
            destination = self.root / "snapshot.db"
            self.assertEqual(snapshot_sqlite(str(source), str(destination)), "ok")
        with closing(sqlite3.connect(destination)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM records").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
