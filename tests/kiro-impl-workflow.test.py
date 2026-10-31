import contextlib
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".fabro/workflows/kiro-impl/workflow.fabro"
GIT_ENV = dict(
    os.environ,
    GIT_AUTHOR_NAME="Test",
    GIT_AUTHOR_EMAIL="test@example.com",
    GIT_COMMITTER_NAME="Test",
    GIT_COMMITTER_EMAIL="test@example.com",
)


def read_script(label):
    text = WORKFLOW.read_text()
    at = text.index('label="%s"' % label)
    start = text.index('script="', at) + len('script="')
    i = start
    raw = []
    while True:
        char = text[i]
        if char == "\\":
            raw.append(text[i : i + 2])
            i += 2
        elif char == '"':
            break
        else:
            raw.append(char)
            i += 1
    return json.loads('"' + "".join(raw) + '"')


def run_stage(label, cwd, **inputs):
    source = read_script(label)
    for name, value in inputs.items():
        source = source.replace("{{ %s }}" % name, json.dumps(value))
    stdout = io.StringIO()
    stderr = io.StringIO()
    previous = os.getcwd()
    os.chdir(cwd)
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compile(source, str(WORKFLOW) + ":" + label, "exec"), {"__name__": "__main__"})
    finally:
        os.chdir(previous)
    return stdout.getvalue(), stderr.getvalue()


def git(cwd, *args):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, env=GIT_ENV)
    if result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


def initialize_origin(root):
    origin = pathlib.Path(root) / "origin.git"
    git(root, "init", "--bare", "--initial-branch=main", str(origin))
    seed = pathlib.Path(root) / "seed"
    git(root, "clone", str(origin), str(seed))
    return origin, seed


def write_tasks(root, prefix="- [ ]"):
    spec = pathlib.Path(root) / ".kiro" / "specs" / "example"
    spec.mkdir(parents=True, exist_ok=True)
    (spec / "tasks.md").write_text(
        "%s 1. First task\n%s 2. Second task\n" % (prefix, prefix)
    )


class KiroImplWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_prepare_rebases_stale_stack_onto_trunk_and_resolves_conflicts(self):
        origin, seed = initialize_origin(self.root)
        (seed / "shared.txt").write_text("base\n")
        write_tasks(seed)
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "initial")
        git(seed, "push", "origin", "main")
        old_main = git(seed, "rev-parse", "main")

        git(seed, "checkout", "-b", "stack/example/1-first")
        (seed / "shared.txt").write_text("stack\n")
        (seed / "stack.txt").write_text("stack only\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "stack task")
        git(seed, "push", "origin", "stack/example/1-first")
        old_stack = git(seed, "rev-parse", "stack/example/1-first")

        git(seed, "checkout", "main")
        (seed / "shared.txt").write_text("main\n")
        (seed / "main.txt").write_text("main only\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "advance main")
        git(seed, "push", "origin", "main")
        new_main = git(seed, "rev-parse", "main")

        work = self.root / "work"
        git(self.root, "clone", "--depth", "1", "file://" + str(origin), str(work))

        stdout, _ = run_stage(
            "Prepare and resume",
            work,
            **{"inputs.spec": "example", "inputs.base": "", "inputs.trunk": ""}
        )

        rebased = git(origin, "rev-parse", "refs/heads/stack/example/1-first")
        self.assertNotEqual(rebased, old_stack)
        self.assertEqual(git(origin, "rev-parse", rebased + "^"), new_main)
        self.assertNotEqual(git(origin, "rev-parse", rebased + "^"), old_main)
        self.assertEqual((work / "shared.txt").read_text(), "stack\n")
        self.assertTrue((work / "main.txt").exists())
        self.assertTrue((work / "stack.txt").exists())

        state = json.loads((work / ".git" / "kiro-impl-state.json").read_text())
        self.assertEqual(state["layers"][0]["sha"], rebased)
        self.assertIn('"has_pending": "true"', stdout)

    def test_prepare_merges_an_unrelated_base_branch(self):
        origin, seed = initialize_origin(self.root)
        (seed / "base.txt").write_text("base\n")
        write_tasks(seed)
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "initial")
        git(seed, "push", "origin", "main")

        git(seed, "checkout", "--orphan", "detached-base")
        git(seed, "rm", "-rf", ".")
        (seed / "orphan.txt").write_text("orphan\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "orphan history")
        git(seed, "push", "origin", "detached-base")

        work = self.root / "work"
        git(self.root, "clone", "--depth", "1", "file://" + str(origin), str(work))

        run_stage(
            "Prepare and resume",
            work,
            **{"inputs.spec": "example", "inputs.base": "detached-base", "inputs.trunk": ""}
        )

        self.assertTrue((work / "orphan.txt").exists())
        self.assertTrue((work / ".kiro/specs/example/tasks.md").exists())
        parents = git(work, "rev-list", "--parents", "-n", "1", "HEAD").split()
        self.assertEqual(len(parents), 3)

    def test_integrate_merges_an_unrelated_child_branch(self):
        origin, seed = initialize_origin(self.root)
        (seed / "base.txt").write_text("base\n")
        write_tasks(seed)
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "initial")
        git(seed, "push", "origin", "main")

        git(seed, "checkout", "--orphan", "fabro/run/child1")
        git(seed, "rm", "-rf", ".")
        write_tasks(seed)
        (seed / ".kiro" / "specs" / "example" / "tasks.md").write_text(
            "- [x] 1. First task\n- [ ] 2. Second task\n"
        )
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "orphan task work")
        git(seed, "push", "origin", "fabro/run/child1")

        work = self.root / "work"
        git(self.root, "clone", str(origin), str(work))
        state = {
            "spec": "example",
            "trunk": "main",
            "layers": [],
            "pending": ["1", "2"],
            "current": {
                "task": "1",
                "text": "First task",
                "layer": 1,
                "branch": "stack/example/1-first",
                "child_run_id": "child1",
            },
        }
        (work / ".git" / "kiro-impl-state.json").write_text(json.dumps(state))

        run_stage("Integrate task branch", work)

        saved = json.loads((work / ".git" / "kiro-impl-state.json").read_text())
        self.assertIsNone(saved["current"])
        self.assertEqual(saved["pending"], ["2"])
        self.assertTrue((work / "base.txt").exists())
        self.assertEqual(
            git(origin, "rev-parse", "refs/heads/stack/example/1-first"),
            saved["layers"][0]["sha"],
        )
        self.assertEqual(
            (work / ".kiro/specs/example/tasks.md").read_text().splitlines()[0],
            "- [x] 1. First task",
        )


if __name__ == "__main__":
    unittest.main()
