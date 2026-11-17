"""#138: cron.py notices when its own container runs an older image.

Pure logic: ImageDriftWatch takes an injected `run` in place of the docker
CLI, so no container or daemon is needed. Needs cron.py's imports (croniter,
yaml, python-telegram-bot); see CLAUDE.md for running these on a bare host.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import cron  # noqa: E402


def fake(own="sha256:OLD000000000aa\tdridock:latest", current="sha256:OLD000000000aa"):
    calls = []

    def run(args):
        calls.append(args)
        if args[0] == "inspect":
            return own
        if args[:2] == ["image", "inspect"]:
            assert args[2] == "dridock:latest", args  # the tag the container was created from
            return current
        return None
    run.calls = calls
    return run


class ImageDriftWatchTest(unittest.TestCase):
    def watch(self, run, name="claude-p-abc_cron"):
        return cron.ImageDriftWatch(name, run=run, interval=600)

    def test_current_image_says_nothing(self):
        w = self.watch(fake())
        with self.assertNoLogs(cron.log, level="INFO"):
            w.check(0)

    def test_drift_warns_once_naming_both_ids_and_the_fix(self):
        run = fake(current="sha256:NEW111111111bb")
        w = self.watch(run)
        with self.assertLogs(cron.log, level="WARNING") as cm:
            w.check(0)
        msg = "\n".join(cm.output)
        self.assertIn("OLD000000000", msg)
        self.assertIn("dridock:latest is now NEW111111111", msg)
        self.assertIn("DRIDOCK_MODE_CRON=1 dridock stop", msg)
        # Same drift on the next check: not repeated.
        with self.assertNoLogs(cron.log, level="INFO"):
            w.check(601)

    def test_tag_moves_again_warns_again(self):
        w = self.watch(fake(current="sha256:NEW111111111bb"))
        with self.assertLogs(cron.log, level="WARNING"):
            w.check(0)
        w._run = fake(current="sha256:NEWER2222222cc")
        with self.assertLogs(cron.log, level="WARNING") as cm:
            w.check(601)
        self.assertIn("NEWER2222222", "\n".join(cm.output))

    def test_checks_only_once_per_interval(self):
        run = fake()
        w = self.watch(run)
        w.check(0)
        w.check(10)
        w.check(599)
        self.assertEqual(len(run.calls), 2)       # one inspect + one image inspect
        w.check(600)
        self.assertEqual(len(run.calls), 4)

    def test_cant_tell_is_said_once_not_taken_as_current(self):
        w = self.watch(lambda args: None)
        with self.assertLogs(cron.log, level="WARNING") as cm:
            w.check(0)
        self.assertIn("can't run", "\n".join(cm.output))
        with self.assertNoLogs(cron.log, level="INFO"):
            w.check(601)

    def test_unset_container_name_is_said(self):
        w = self.watch(fake(), name="")
        with self.assertLogs(cron.log, level="WARNING") as cm:
            w.check(0)
        self.assertIn("DRIDOCK_CONTAINER_NAME is unset", "\n".join(cm.output))

    def test_back_to_current_is_noted(self):
        w = self.watch(fake(current="sha256:NEW111111111bb"))
        with self.assertLogs(cron.log, level="WARNING"):
            w.check(0)
        w._run = fake()
        with self.assertLogs(cron.log, level="INFO") as cm:
            w.check(601)
        self.assertIn("current again", "\n".join(cm.output))


if __name__ == "__main__":
    unittest.main()
