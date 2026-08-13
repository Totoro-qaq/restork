import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check_spacing_grid.py"


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
        with tempfile.NamedTemporaryFile("w", suffix=".css", delete=False) as handle:
            handle.write(".off-grid-probe { padding: 9px; }\n")
            probe = Path(handle.name)
        try:
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), str(probe)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("9px", completed.stderr)
        finally:
            probe.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
