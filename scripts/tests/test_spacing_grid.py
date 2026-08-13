import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check_spacing_grid.py"
SPEC = importlib.util.spec_from_file_location("check_spacing_grid", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CHECK_SPACING_GRID = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK_SPACING_GRID)


class SpacingGridTests(unittest.TestCase):
    def test_repository_stylesheet_is_on_the_grid(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_rejects_off_grid_padding(self) -> None:
        issues = CHECK_SPACING_GRID.spacing_issues(
            ".off-grid-probe { padding: 9px; }\n",
            "fixture.css",
        )
        self.assertEqual(len(issues), 1)
        self.assertIn("9px", issues[0])

    def test_rejects_arbitrary_path_arguments(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "outside.css"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("does not accept file paths", completed.stderr)


if __name__ == "__main__":
    unittest.main()
