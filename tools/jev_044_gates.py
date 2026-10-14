"""Offline before/after gates. All scratch and logs stay in this worktree."""
from pathlib import Path
import json
import os
import subprocess

root = Path(__file__).resolve().parents[1]
assert root.name == "wt_jev_041_20261014"
scratch = root / "tmp" / "044"
before = scratch / "before"
before.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, TEMP="F:/temp", TMP="F:/temp", PYTHONUTF8="1", NO_COLOR="1")
paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "38b2b03"], cwd=root, text=True).splitlines()
for name in paths:
    if name.startswith(("src/", "hooks/", "types/")) or name in {"package.json", "vitest.config.ts", "tsconfig.json", "tsconfig.hooks.json"}:
        target = before / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(subprocess.check_output(["git", "show", "38b2b03:" + name], cwd=root))
target = before / "tests" / "ratio-only-regressions.test.ts"
target.parent.mkdir(exist_ok=True)
target.write_bytes((root / "tests" / target.name).read_bytes())
vitest = root / "node_modules" / "vitest" / "vitest.mjs"
tsc = root / "node_modules" / "typescript" / "bin" / "tsc"
commands = [
    ("before", before, ["node", str(vitest), "run", "tests/ratio-only-regressions.test.ts", "--reporter=json"], 1),
    ("after", root, ["node", str(vitest), "run", "--reporter=json"], 0),
    ("typecheck", root, ["node", str(tsc), "--noEmit"], 0),
    ("hooks-typecheck", root, ["node", str(tsc), "-p", "tsconfig.hooks.json"], 0),
    ("build", root, ["node", str(tsc)], 0),
]
receipt = {}
for label, cwd, command, expected in commands:
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, timeout=60)
    (scratch / (label + ".out")).write_bytes(result.stdout)
    (scratch / (label + ".err")).write_bytes(result.stderr)
    receipt[label] = {"exit_code": result.returncode, "expected": expected}
    if label in {"before", "after"}:
        data = json.loads(result.stdout)
        receipt[label].update({k: data[k] for k in ["numTotalTests", "numPassedTests", "numFailedTests"]})
        if label == "before":
            assertions = [a for suite in data["testResults"] for a in suite["assertionResults"]]
            assert assertions and all(a["status"] == "failed" for a in assertions), "Every new gate must fail on 38b2b03"
    print(label, receipt[label], flush=True)
    assert result.returncode == expected, label
(scratch / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8", newline="\n")
