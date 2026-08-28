from __future__ import annotations

import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from evals import candidate_executor
from evals import candidate_proxy
from evals import candidate_worker
from evals import run_fixtures


ROOT = Path(__file__).resolve().parents[1]


class ExecutableEvalRunnerTests(unittest.TestCase):
    def test_proxy_reuses_one_trusted_runtime_root_snapshot(self):
        previous = candidate_proxy._RUNTIME_ROOTS_CACHE
        candidate_proxy._RUNTIME_ROOTS_CACHE = None
        try:
            with mock.patch.object(
                candidate_proxy,
                "_runtime_read_roots",
                return_value=[Path(sys.prefix)],
            ) as discover:
                first = candidate_proxy._build_request("probe", (), ())
                second = candidate_proxy._build_request("probe", (), ())
            self.assertEqual(1, discover.call_count)
            self.assertEqual(
                json.loads(first)["runtime_roots"],
                json.loads(second)["runtime_roots"],
            )
        finally:
            candidate_proxy._RUNTIME_ROOTS_CACHE = previous

    def test_candidate_sandbox_provider_uses_trusted_system_search_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate.py"
            candidate.write_text("pass\n", encoding="utf-8")

            def trusted_which(name, *, path=None):
                self.assertEqual(os.defpath, path)
                self.assertEqual("sandbox-exec", name)
                return "/usr/bin/sandbox-exec"

            with mock.patch.object(
                candidate_executor.sys,
                "platform",
                "darwin",
            ), mock.patch.object(
                candidate_executor.shutil,
                "which",
                side_effect=trusted_which,
            ), mock.patch.object(
                candidate_executor,
                "_runtime_read_roots",
                return_value=[],
            ):
                command = candidate_executor._sandbox_command(candidate, [], root)
            self.assertEqual("/usr/bin/sandbox-exec", command[0])

    def test_internal_pipe_descriptors_never_alias_standard_streams(self):
        closed: list[int] = []
        with mock.patch.object(
            candidate_executor.os,
            "pipe",
            return_value=(0, 1),
        ), mock.patch.object(
            candidate_executor.fcntl,
            "fcntl",
            side_effect=[10, 11],
        ), mock.patch.object(
            candidate_executor.os,
            "close",
            side_effect=closed.append,
        ):
            self.assertEqual(
                (10, 11),
                candidate_executor._pipe_cloexec_outside_stdio(),
            )
        self.assertEqual([0, 1], closed)

    def test_lifetime_probe_supports_descriptors_above_select_limit(self):
        reader, writer = os.pipe()
        os.close(writer)
        try:
            with mock.patch.object(
                candidate_executor.select,
                "select",
                side_effect=AssertionError("lifetime probes must not use select()"),
            ):
                self.assertTrue(candidate_executor._lifetime_cancelled((reader,)))
        finally:
            os.close(reader)

    def test_macos_candidate_sandbox_denies_session_detachment_and_signals(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate.py"
            candidate.write_text("pass\n", encoding="utf-8")
            with mock.patch.object(candidate_executor.sys, "platform", "darwin"), mock.patch.object(
                candidate_executor.shutil, "which", return_value="/usr/bin/sandbox-exec"
            ), mock.patch.object(
                candidate_executor,
                "_runtime_read_roots",
                return_value=[],
            ):
                command = candidate_executor._sandbox_command(candidate, [], root)
            profile = command[2]
        self.assertIn("(deny signal)", profile)
        self.assertIn("SYS_setsid", profile)
        self.assertIn("SYS_setpgid", profile)
        self.assertNotIn("(allow process*)", profile)

    def test_macos_candidate_sandbox_does_not_grant_blanket_mach_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate.py"
            candidate.write_text("pass\n", encoding="utf-8")
            writable = root / "output"
            writable.mkdir()
            with mock.patch.object(candidate_executor.sys, "platform", "darwin"), mock.patch.object(
                candidate_executor.shutil, "which", return_value="/usr/bin/sandbox-exec"
            ), mock.patch.object(
                candidate_executor,
                "_runtime_read_roots",
                return_value=[],
            ):
                command = candidate_executor._sandbox_command(candidate, [writable], root)
            self.assertNotIn("(allow mach-lookup)", command[2])

    def test_macos_dependency_discovery_observes_lifetime_eof_before_spawning(self):
        lifetime_reader, lifetime_writer = os.pipe()
        os.close(lifetime_writer)
        try:
            with mock.patch.object(
                candidate_executor.subprocess,
                "Popen",
                side_effect=AssertionError("cancelled discovery must not spawn otool"),
            ):
                with self.assertRaises(candidate_executor._LifetimeCancelled):
                    candidate_executor._macos_dynamic_dependencies(
                        {Path(__file__)},
                        lifetime_fds=(lifetime_reader,),
                    )
        finally:
            os.close(lifetime_reader)

    def test_macos_dependency_discovery_has_a_hard_deadline(self):
        process = mock.Mock()
        process.returncode = None
        with mock.patch.object(
            candidate_executor.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(
            candidate_executor,
            "_collect_bounded_output",
            side_effect=TimeoutError("probe timed out"),
        ), mock.patch.object(
            candidate_executor,
            "terminate_direct_child",
        ) as terminate:
            with self.assertRaisesRegex(RuntimeError, "dependency discovery timed out"):
                candidate_executor._macos_dynamic_dependencies({Path(__file__)})
        terminate.assert_called_once_with(process)

    def test_macos_dependency_batches_share_one_startup_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = set()
            for index in range(65):
                path = Path(tmp) / f"library-{index}.dylib"
                path.write_bytes(b"not-a-library")
                paths.add(path)
            process = mock.Mock()
            process.returncode = 0
            process.poll.return_value = 0
            with mock.patch.object(
                candidate_executor.subprocess,
                "Popen",
                return_value=process,
            ) as popen, mock.patch.object(
                candidate_executor,
                "_collect_bounded_output",
                return_value=(b"", b""),
            ), mock.patch.object(
                candidate_executor.time,
                "monotonic",
                side_effect=[0, 6],
            ):
                with self.assertRaisesRegex(RuntimeError, "dependency discovery timed out"):
                    candidate_executor._macos_dynamic_dependencies(
                        paths,
                        deadline=5,
                    )
            self.assertEqual(1, popen.call_count)

    def test_macos_dependency_probe_recomputes_deadline_after_spawn(self):
        process = mock.Mock()
        process.returncode = 0
        process.poll.return_value = 0
        with mock.patch.object(
            candidate_executor.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(
            candidate_executor,
            "_collect_bounded_output",
            return_value=(b"", b""),
        ) as collect, mock.patch.object(
            candidate_executor.time,
            "monotonic",
            side_effect=[1, 7],
        ):
            candidate_executor._macos_dynamic_dependencies(
                {Path(__file__)},
                deadline=10,
            )
        self.assertEqual(3, collect.call_args.kwargs["timeout"])

    def test_macos_dependency_traversal_checks_deadline_without_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "nested").mkdir()
            with mock.patch.object(
                candidate_executor.time,
                "monotonic",
                side_effect=[0, 0, 6],
            ):
                with self.assertRaisesRegex(RuntimeError, "dependency discovery timed out"):
                    candidate_executor._macos_dynamic_dependencies(
                        {Path(tmp)},
                        deadline=5,
                    )

    def test_macos_dependency_traversal_checks_deadline_inside_one_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            library = root / "library.dylib"
            library.write_bytes(b"not-a-library")
            clock = iter([0, 0, 6])
            with mock.patch.object(
                candidate_executor.time,
                "monotonic",
                side_effect=lambda: next(clock),
            ), mock.patch.object(
                candidate_executor.subprocess,
                "Popen",
                side_effect=AssertionError("expired traversal must not spawn otool"),
            ):
                with self.assertRaisesRegex(RuntimeError, "dependency discovery timed out"):
                    candidate_executor._macos_dynamic_dependencies({root}, deadline=5)

    def test_macos_dependency_batch_keeps_valid_output_on_partial_failure(self):
        process = mock.Mock()
        process.returncode = 1
        process.poll.return_value = 1
        dependency = Path(sys.executable).resolve()
        output = f"\t{dependency} (compatibility version 1.0.0)\n".encode()
        with mock.patch.object(
            candidate_executor.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(
            candidate_executor,
            "_collect_bounded_output",
            side_effect=[(output, b"malformed peer"), (b"", b"")],
        ):
            observed = candidate_executor._macos_dynamic_dependencies({Path(__file__)})
        self.assertIn(dependency, observed)

    def test_lexists_accepts_dangling_symlinks_without_pathlib_extensions(self):
        with tempfile.TemporaryDirectory() as tmp:
            dangling = Path(tmp) / "dangling"
            dangling.symlink_to("missing-target")
            self.assertTrue(run_fixtures._lexists(dangling))

    def test_fixture_timeouts_cover_declared_serial_request_batches(self):
        expected_full_batches = {5: 8, 6: 5, 7: 2, 10: 3}
        for case_id, batches in expected_full_batches.items():
            with self.subTest(case_id=case_id):
                case = run_fixtures.CASES[case_id]
                self.assertEqual(batches, case.request_batches)
                self.assertEqual(
                    run_fixtures.WORKER_TIMEOUT_SECONDS * (batches + 1),
                    run_fixtures._test_timeout_seconds(case.request_batches),
                )

        webhook = run_fixtures.CASES[5]
        expected_mutant_batches = {
            "accept-invalid-signature": 1,
            "accept-stale-timestamp": 1,
            "non-idempotent-retry": 2,
            "broken-concurrent-idempotency": 1,
            "false-persistence-success": 1,
        }
        self.assertEqual(
            expected_mutant_batches,
            {mutant.name: mutant.request_batches for mutant in webhook.mutants},
        )
        self.assertEqual(
            run_fixtures.WORKER_TIMEOUT_SECONDS * 3,
            run_fixtures._test_timeout_seconds(
                next(
                    mutant.request_batches
                    for mutant in webhook.mutants
                    if mutant.name == "non-idempotent-retry"
                )
            ),
        )
        for invalid_batches in (0, -1, True, "1"):
            with self.subTest(invalid_batches=invalid_batches):
                with self.assertRaisesRegex(ValueError, "request batches"):
                    run_fixtures._test_timeout_seconds(invalid_batches)

    def test_output_collection_stops_writing_after_child_pipe_hup(self):
        process = subprocess.Popen(
            [sys.executable, "-c", "pass"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        try:
            started = time.monotonic()
            stdout, stderr = candidate_executor._collect_bounded_output(
                process,
                request_bytes=b"x" * (8 * 1024 * 1024),
                limit=1024,
                timeout=0.5,
            )
            self.assertLess(time.monotonic() - started, 0.25)
            self.assertEqual(b"", stdout)
            self.assertEqual(b"", stderr)
        finally:
            process.wait(timeout=1)

    def test_fixture_timeout_terminates_test_boundary(self):
        class TimedOutProcess:
            pid = 505

            def __init__(self):
                self.timeout: int | None = None

            def communicate(self, *, timeout):
                self.timeout = timeout
                raise run_fixtures.subprocess.TimeoutExpired(["fixture"], timeout)

        test_path = ROOT / "evals" / "files" / "slugify" / "tests" / "test_slugify.py"
        candidate_path = ROOT / "evals" / "files" / "slugify" / "candidate.py"
        process = TimedOutProcess()
        with mock.patch.object(run_fixtures.subprocess, "Popen", return_value=process), mock.patch.object(
            run_fixtures, "_terminate_fixture_group"
        ) as terminate:
            result = run_fixtures._run_test(test_path, candidate_path, None, 5, 5)
        self.assertTrue(result["timed_out"])
        self.assertEqual(run_fixtures.WORKER_TIMEOUT_SECONDS * 6, process.timeout)
        terminate.assert_called_once_with(process)

    def test_fixture_timeout_ignores_reaped_root_to_avoid_pgid_reuse(self):
        class ReapedProcess:
            pid = 505
            returncode = 0

        with mock.patch.object(
            run_fixtures.os,
            "killpg",
            side_effect=AssertionError("reaped fixture root must not signal a process group"),
        ):
            run_fixtures._terminate_fixture_group(ReapedProcess())

    def test_fixture_timeout_preserves_partial_process_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate.py"
            candidate.write_text("pass\n", encoding="utf-8")
            slow_test = root / "slow_test.py"
            slow_test.write_text(
                "import time\n"
                "print('partial-before-timeout', flush=True)\n"
                "time.sleep(60)\n",
                encoding="utf-8",
            )
            with mock.patch.object(
                run_fixtures,
                "_test_timeout_seconds",
                return_value=5,
            ):
                result = run_fixtures._run_test(slow_test, candidate, None, 1, 1)
        self.assertTrue(result["timed_out"])
        self.assertIn("partial-before-timeout", result["output"])

    def test_fixture_timeout_does_not_wait_for_inherited_stdout_eof(self):
        reader, writer = os.pipe()
        stdout = os.fdopen(reader, "r", encoding="utf-8")

        class TimedOutProcess:
            pid = 508
            returncode = None
            stderr = None

            def __init__(self):
                self.stdout = stdout

            def communicate(self, *, timeout):
                raise run_fixtures.subprocess.TimeoutExpired(
                    ["fixture"],
                    timeout,
                    output="partial-before-timeout\n",
                )

        timer = threading.Timer(0.5, os.close, args=(writer,))
        timer.start()
        started = time.monotonic()
        try:
            with mock.patch.object(
                run_fixtures.subprocess,
                "Popen",
                return_value=TimedOutProcess(),
            ), mock.patch.object(
                run_fixtures,
                "_terminate_fixture_group",
            ):
                result = run_fixtures._run_test(
                    ROOT / "evals" / "files" / "slugify" / "tests" / "test_slugify.py",
                    ROOT / "evals" / "files" / "slugify" / "candidate.py",
                    None,
                    5,
                    1,
                )
            elapsed = time.monotonic() - started
        finally:
            timer.join()
            if not stdout.closed:
                stdout.close()
        self.assertLess(elapsed, 0.4)
        self.assertIn("partial-before-timeout", result["output"])

    def test_fixture_timeout_after_root_exit_terminates_stdout_descendant(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate.py"
            candidate.write_text("pass\n", encoding="utf-8")
            child_started = root / "descendant-started"
            root_exited = root / "fixture-root-exited"
            release = root / "release-descendant"
            marker = root / "descendant-survived"
            fixture = root / "fixture.py"
            child = (
                "import os, time\n"
                "from pathlib import Path\n"
                "parent_pid = os.getppid()\n"
                f"Path({str(child_started)!r}).write_text('started')\n"
                "while os.getppid() == parent_pid: time.sleep(0.01)\n"
                f"Path({str(root_exited)!r}).write_text('exited')\n"
                f"while not Path({str(release)!r}).exists(): time.sleep(0.01)\n"
                f"Path({str(marker)!r}).write_text('survived')\n"
            )
            fixture.write_text(
                "import subprocess, sys, time\n"
                "from pathlib import Path\n"
                f"subprocess.Popen([sys.executable, '-c', {child!r}])\n"
                f"while not Path({str(child_started)!r}).exists(): time.sleep(0.01)\n"
                "print('spawned', flush=True)\n"
                "raise SystemExit(0)\n",
                encoding="utf-8",
            )
            with mock.patch.object(
                run_fixtures,
                "_test_timeout_seconds",
                return_value=2,
            ):
                result = run_fixtures._run_test(
                    fixture,
                    candidate,
                    None,
                    1,
                    1,
                )
            self.assertTrue(result["timed_out"])
            observed_root_exit = root_exited.exists()
            release.write_text("release", encoding="utf-8")
            time.sleep(0.5)
            self.assertTrue(observed_root_exit)
            self.assertFalse(marker.exists())

    def test_fixture_process_without_exit_terminates_boundary(self):
        class OpenProcess:
            pid = 506
            returncode = None

            def __init__(self):
                self.stdin = io.StringIO()
                self.stdout = io.StringIO()
                self.stderr = io.StringIO()

            def communicate(self, *, timeout):
                return "test output", None

        test_path = ROOT / "evals" / "files" / "slugify" / "tests" / "test_slugify.py"
        candidate_path = ROOT / "evals" / "files" / "slugify" / "candidate.py"
        process = OpenProcess()
        with mock.patch.object(run_fixtures.subprocess, "Popen", return_value=process), mock.patch.object(
            run_fixtures, "_terminate_fixture_group"
        ) as terminate:
            with self.assertRaisesRegex(RuntimeError, "fixture test process did not exit"):
                run_fixtures._run_test(test_path, candidate_path, None, 5, 1)
        terminate.assert_called_once_with(process)
        self.assertTrue(process.stdin.closed)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)

    def test_fixture_process_error_terminates_boundary(self):
        class FailedProcess:
            pid = 507

            def communicate(self, *, timeout):
                raise RuntimeError("fixture transport interrupted")

        test_path = ROOT / "evals" / "files" / "slugify" / "tests" / "test_slugify.py"
        candidate_path = ROOT / "evals" / "files" / "slugify" / "candidate.py"
        process = FailedProcess()
        with mock.patch.object(run_fixtures.subprocess, "Popen", return_value=process), mock.patch.object(
            run_fixtures, "_terminate_fixture_group"
        ) as terminate:
            with self.assertRaisesRegex(RuntimeError, "fixture transport interrupted"):
                run_fixtures._run_test(test_path, candidate_path, None, 5, 1)
        terminate.assert_called_once_with(process)

    def test_known_bad_starting_candidates_are_semantically_rejected(self):
        for case_id, fixture in [
            (5, "webhook"),
            (6, "slugify"),
            (7, "judge-tampering"),
            (10, "legacy-bug"),
        ]:
            with self.subTest(case_id=case_id), tempfile.TemporaryDirectory() as tmp:
                case = run_fixtures.CASES[case_id]
                source_path = ROOT / "evals" / "files" / fixture / case.candidate_path
                candidate_path = Path(tmp) / case.candidate_path
                candidate_path.write_bytes(source_path.read_bytes())
                result = run_fixtures.run_case(case_id, Path(tmp))
                self.assertEqual("qualified", result["qualification"]["status"])
                self.assertEqual("rejected", result["disposition"])

    def test_candidate_workspace_cannot_overlap_protected_fixture(self):
        workspace = ROOT / "evals" / "files" / "slugify"
        with self.assertRaisesRegex(ValueError, "must be disjoint"):
            run_fixtures.run_case(6, workspace)

    def test_output_symlink_cannot_overwrite_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "candidate.py").write_text(
                "def slugify(title: str) -> str:\n"
                "    return 'x'\n",
                encoding="utf-8",
            )
            target = root / "secret-target.json"
            target.write_text("ORIGINAL\n", encoding="utf-8")
            output_link = root / "result.json"
            output_link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, r"symlink|refuses|unsafe|output"):
                run_fixtures._render({"ok": True}, output_link)
            self.assertEqual("ORIGINAL\n", target.read_text(encoding="utf-8"))
            self.assertTrue(output_link.is_symlink())

    def test_output_rejects_intermediate_ancestor_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(os.path.realpath(tmp))
            outside = root / "outside"
            (outside / "sub").mkdir(parents=True)
            secret = outside / "sub" / "secret.json"
            secret.write_text("ORIGINAL\n", encoding="utf-8")
            link = root / "link"
            link.symlink_to(outside)
            # Immediate parent is a real directory; only an intermediate ancestor is a symlink.
            output = root / "link" / "sub" / "result.json"
            with self.assertRaisesRegex(ValueError, r"symlink|refuses|unsafe|ancestor|output"):
                run_fixtures._render({"ok": True}, output)
            self.assertEqual("ORIGINAL\n", secret.read_text(encoding="utf-8"))
            self.assertFalse((outside / "sub" / "result.json").exists())
            self.assertFalse(output.exists())

    def test_output_rejects_fifo_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(os.path.realpath(tmp))
            fifo = root / "result.json"
            os.mkfifo(fifo)
            # A blocking open of the FIFO would hang the verifier forever.
            with self.assertRaisesRegex(ValueError, r"symlink|refuses|unsafe|output|regular|fifo"):
                run_fixtures._render({"ok": True}, fifo)
            self.assertTrue(stat.S_ISFIFO(fifo.stat().st_mode))


    def test_candidate_cannot_forge_parent_test_completion(self):
        source = """import os

os.write(1, b"OK\\n")
os._exit(0)
"""
        result = self._run_candidate(6, source)
        self.assertEqual("rejected", result["disposition"])
        self.assertFalse(result["candidate"]["run"]["passed"])

    def test_candidate_cannot_write_parent_protocol_fd(self):
        source = """import os


def slugify(title: str) -> str:
    os.write(3, b'{"ok":true,"value":"forged"}')
    os._exit(0)
"""
        result = self._run_candidate(6, source)
        self.assertEqual("rejected", result["disposition"])
        self.assertFalse(result["candidate"]["run"]["passed"])

    def test_candidate_os_sandbox_preserves_protected_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate_dir = root / "candidate"
            candidate_dir.mkdir()
            protected = root / "protected.txt"
            protected.write_text("protected\n", encoding="utf-8")
            candidate = candidate_dir / "candidate.py"
            candidate.write_text(
                "from pathlib import Path\n"
                "def probe():\n"
                f"    Path({str(protected)!r}).write_text('tampered')\n"
                "    return 'forged-green'\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                with self.assertRaisesRegex(RuntimeError, "Operation not permitted"):
                    candidate_proxy._invoke("probe")
            self.assertEqual("protected\n", protected.read_text(encoding="utf-8"))

    def test_webhook_directory_failure_grants_no_writable_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(candidate_proxy, "_invoke", return_value=(503, "persistence_error")) as invoke:
                candidate_proxy.ingest_webhook(b"{}", "signature", 1, 1, tmp)
            self.assertEqual((), invoke.call_args.kwargs["writable_paths"])

    def test_candidate_os_sandbox_denies_host_secret_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate_dir = root / "candidate"
            candidate_dir.mkdir()
            secret = root / "host-secret.txt"
            secret.write_text("sensitive\n", encoding="utf-8")
            candidate = candidate_dir / "candidate.py"
            candidate.write_text(
                "from pathlib import Path\n"
                "def probe(path):\n"
                "    return Path(path).read_text()\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                with self.assertRaisesRegex(RuntimeError, "Operation not permitted|Permission denied"):
                    candidate_proxy._invoke("probe", str(secret))

    def test_candidate_os_sandbox_denies_supervisor_working_directory_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / "candidate.py"
            secret = root / "cwd-secret.txt"
            secret.write_text("sensitive\n", encoding="utf-8")
            candidate.write_text(
                "from pathlib import Path\n"
                "def probe():\n"
                "    return Path.cwd().joinpath('cwd-secret.txt').read_text()\n",
                encoding="utf-8",
            )
            original_cwd = Path.cwd()
            try:
                os.chdir(root)
                with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "Operation not permitted|Permission denied|No such file or directory",
                    ):
                        candidate_proxy._invoke("probe")
            finally:
                os.chdir(original_cwd)

    def test_candidate_os_sandbox_denies_sibling_secret_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "sibling-secret.txt"
            secret.write_text("sensitive\n", encoding="utf-8")
            candidate = root / "candidate.py"
            candidate.write_text(
                "from pathlib import Path\n"
                "def probe(path):\n"
                "    return Path(path).read_text()\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "Operation not permitted|Permission denied",
                ):
                    candidate_proxy._invoke("probe", str(secret))

    def test_candidate_oversized_return_is_rejected_without_host_growth(self):
        from evals import candidate_executor

        limit = candidate_executor.CANDIDATE_OUTPUT_LIMIT_BYTES
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.py"
            candidate.write_text(
                "def probe():\n"
                f"    return 'x' * {limit + 1}\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                with self.assertRaisesRegex(RuntimeError, r"exceeded|bounded|output limit|too large"):
                    candidate_proxy._invoke("probe")

    def test_candidate_oversized_stderr_is_rejected_without_host_growth(self):
        from evals import candidate_executor

        limit = candidate_executor.CANDIDATE_OUTPUT_LIMIT_BYTES
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.py"
            candidate.write_text(
                "import sys\n"
                "def probe():\n"
                f"    sys.stderr.write('e' * {limit + 1})\n"
                "    sys.stderr.flush()\n"
                "    return 'ok'\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                with self.assertRaisesRegex(RuntimeError, r"exceeded|bounded|output limit|too large"):
                    candidate_proxy._invoke("probe")

    def test_outer_timeout_cancels_direct_worker(self):
        class TimedOutProcess:
            pid = 101

            def communicate(self, *, input, timeout):
                raise candidate_proxy.subprocess.TimeoutExpired(["worker"], timeout)

        process = TimedOutProcess()
        with mock.patch.object(
            candidate_proxy.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(candidate_proxy, "cancel_direct_child") as cancel:
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": __file__}):
                with self.assertRaisesRegex(
                    RuntimeError, "candidate worker exceeded supervisor time budget"
                ):
                    candidate_proxy._invoke("probe")
        cancel.assert_called_once_with(process)

    def test_outer_timeout_closes_each_lifetime_descriptor_once(self):
        class TimedOutProcess:
            pid = 104
            returncode = None

            def communicate(self, *, input, timeout):
                raise candidate_proxy.subprocess.TimeoutExpired(["worker"], timeout)

            def wait(self, *, timeout):
                self.returncode = 0
                return 0

        closed: list[int] = []
        with mock.patch.object(
            candidate_proxy.subprocess,
            "Popen",
            return_value=TimedOutProcess(),
        ), mock.patch.object(
            candidate_proxy.os,
            "pipe",
            return_value=(71, 72),
        ), mock.patch.object(
            candidate_proxy.os,
            "close",
            side_effect=closed.append,
        ):
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": __file__}):
                with self.assertRaisesRegex(
                    RuntimeError, "candidate worker exceeded supervisor time budget"
                ):
                    candidate_proxy._invoke("probe")
        self.assertEqual([71, 72], closed)

    def test_proxy_passes_only_its_lifetime_reader_to_worker(self):
        class CompletedProcess:
            pid = 105
            returncode = 0

            def communicate(self, *, input, timeout):
                return b'{"ok":true,"value":"ok"}', b""

        with mock.patch.object(
            candidate_proxy.subprocess,
            "Popen",
            return_value=CompletedProcess(),
        ) as popen, mock.patch.object(
            candidate_proxy.os,
            "pipe",
            return_value=(73, 74),
        ), mock.patch.object(
            candidate_proxy,
            "_close_fd",
        ):
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": __file__}):
                self.assertEqual("ok", candidate_proxy._invoke("probe"))
        self.assertTrue(popen.call_args.kwargs["close_fds"])
        self.assertEqual((73,), popen.call_args.kwargs["pass_fds"])
        self.assertEqual("73", popen.call_args.args[0][-1])

    def test_outer_worker_without_exit_cancels_direct_child(self):
        class OpenProcess:
            pid = 103
            returncode = None

            def communicate(self, *, input, timeout):
                return b'{"ok":true,"value":"ok"}', b""

        process = OpenProcess()
        with mock.patch.object(
            candidate_proxy.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(candidate_proxy, "cancel_direct_child") as cancel:
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": __file__}):
                with self.assertRaisesRegex(RuntimeError, "candidate worker did not exit"):
                    candidate_proxy._invoke("probe")
        cancel.assert_called_once_with(process)

    def test_outer_worker_error_cancels_direct_child(self):
        class FailedProcess:
            pid = 102

            def communicate(self, *, input, timeout):
                raise RuntimeError("worker transport interrupted")

        process = FailedProcess()
        with mock.patch.object(
            candidate_proxy.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(candidate_proxy, "cancel_direct_child") as cancel:
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": __file__}):
                with self.assertRaisesRegex(RuntimeError, "worker transport interrupted"):
                    candidate_proxy._invoke("probe")
        cancel.assert_called_once_with(process)

    def test_worker_timeout_cancels_direct_executor(self):
        class TimedOutProcess:
            pid = 202

            def communicate(self, *, input, timeout):
                raise candidate_worker.subprocess.TimeoutExpired(["executor"], timeout)

        process = TimedOutProcess()
        stdin = io.TextIOWrapper(io.BytesIO(b"{}"), encoding="utf-8", write_through=True)
        stdout = io.StringIO()
        with mock.patch.object(
            candidate_worker.sys,
            "argv",
            ["candidate_worker.py", "candidate.py", "9"],
        ), mock.patch.object(
            candidate_worker.sys,
            "stdin",
            stdin,
        ), mock.patch.object(
            candidate_worker.sys,
            "stdout",
            stdout,
        ), mock.patch.object(
            candidate_worker.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(candidate_worker, "cancel_direct_child") as cancel:
            self.assertEqual(0, candidate_worker.main())
        cancel.assert_called_once_with(process)

    def test_worker_executor_without_exit_cancels_direct_child(self):
        class OpenProcess:
            pid = 204
            returncode = None

            def communicate(self, *, input, timeout):
                return b'{"executor_protocol":"vdd-candidate-return-v1","ok":true,"value":"ok"}', b""

        process = OpenProcess()
        stdin = io.TextIOWrapper(io.BytesIO(b"{}"), encoding="utf-8", write_through=True)
        stdout = io.StringIO()
        with mock.patch.object(
            candidate_worker.sys,
            "argv",
            ["candidate_worker.py", "candidate.py", "9"],
        ), mock.patch.object(
            candidate_worker.sys,
            "stdin",
            stdin,
        ), mock.patch.object(
            candidate_worker.sys,
            "stdout",
            stdout,
        ), mock.patch.object(
            candidate_worker.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(candidate_worker, "cancel_direct_child") as cancel:
            self.assertEqual(0, candidate_worker.main())
        cancel.assert_called_once_with(process)
        self.assertIn("candidate executor did not exit after response", stdout.getvalue())

    def test_worker_executor_error_cancels_direct_child(self):
        class FailedProcess:
            pid = 203

            def communicate(self, *, input, timeout):
                raise RuntimeError("executor transport interrupted")

        process = FailedProcess()
        stdin = io.TextIOWrapper(io.BytesIO(b"{}"), encoding="utf-8", write_through=True)
        stdout = io.StringIO()
        with mock.patch.object(
            candidate_worker.sys,
            "argv",
            ["candidate_worker.py", "candidate.py", "9"],
        ), mock.patch.object(
            candidate_worker.sys,
            "stdin",
            stdin,
        ), mock.patch.object(
            candidate_worker.sys,
            "stdout",
            stdout,
        ), mock.patch.object(
            candidate_worker.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(candidate_worker, "cancel_direct_child") as cancel:
            self.assertEqual(0, candidate_worker.main())
        cancel.assert_called_once_with(process)
        self.assertIn("executor transport interrupted", stdout.getvalue())

    def test_worker_passes_exact_lifetime_readers_to_executor(self):
        class CompletedProcess:
            pid = 205
            returncode = 0

            def communicate(self, *, input, timeout):
                return (
                    b'{"executor_protocol":"vdd-candidate-return-v1",'
                    b'"ok":true,"value":"ok"}',
                    b"",
                )

        stdin = io.TextIOWrapper(io.BytesIO(b"{}"), encoding="utf-8", write_through=True)
        stdout = io.StringIO()
        with mock.patch.object(
            candidate_worker.sys,
            "argv",
            ["candidate_worker.py", "candidate.py", "9"],
        ), mock.patch.object(
            candidate_worker.sys,
            "stdin",
            stdin,
        ), mock.patch.object(
            candidate_worker.sys,
            "stdout",
            stdout,
        ), mock.patch.object(
            candidate_worker.os,
            "pipe",
            return_value=(81, 82),
        ), mock.patch.object(
            candidate_worker.subprocess,
            "Popen",
            return_value=CompletedProcess(),
        ) as popen, mock.patch.object(
            candidate_worker,
            "_close_fd",
        ):
            self.assertEqual(0, candidate_worker.main())
        self.assertTrue(popen.call_args.kwargs["close_fds"])
        self.assertEqual((9, 81), popen.call_args.kwargs["pass_fds"])
        self.assertEqual(["9", "81"], popen.call_args.args[0][-2:])
        self.assertNotIn(82, popen.call_args.kwargs["pass_fds"])

    def test_proxy_lifetime_eof_cancels_real_worker_executor_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate_dir = root / "candidate"
            writable_dir = root / "writable"
            candidate_dir.mkdir()
            writable_dir.mkdir()
            candidate = candidate_dir / "candidate.py"
            started = writable_dir / "started"
            delayed = writable_dir / "delayed"
            candidate.write_text(
                "import time\n"
                "from pathlib import Path\n"
                "def probe(started: str, delayed: str) -> str:\n"
                "    Path(started).write_text('started')\n"
                "    time.sleep(0.25)\n"
                "    Path(delayed).write_text('survived')\n"
                "    return 'late'\n",
                encoding="utf-8",
            )
            caller_source = (
                "from evals import candidate_proxy\n"
                "candidate_proxy._invoke(\n"
                "    'probe',\n"
                f"    {str(started)!r},\n"
                f"    {str(delayed)!r},\n"
                f"    writable_paths=({str(writable_dir)!r},),\n"
                ")\n"
            )
            environment = os.environ.copy()
            environment.update(
                {
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONPATH": str(ROOT),
                    "VDD_CANDIDATE_PATH": str(candidate),
                }
            )
            caller: subprocess.Popen[bytes] | None = None
            try:
                caller = subprocess.Popen(
                    [sys.executable, "-c", caller_source],
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    close_fds=True,
                )
                deadline = time.monotonic() + 15
                while not started.exists() and time.monotonic() < deadline:
                    if caller.poll() is not None:
                        break
                    time.sleep(0.01)
                if not started.exists():
                    if caller.poll() is None:
                        candidate_executor.terminate_direct_child(caller)
                    if caller.returncode is None:
                        detail = "caller remained unreaped after direct-child cleanup"
                    else:
                        self.assertIsNotNone(caller.stderr)
                        detail = caller.stderr.read().decode("utf-8", errors="replace")
                    self.fail(
                        "sandbox candidate never reached its call boundary: "
                        f"caller exit {caller.returncode}: {detail}"
                    )

                candidate_executor.terminate_direct_child(caller)
                time.sleep(1)
                self.assertFalse(delayed.exists(), "cancelled sandbox wrote its delayed marker")
            finally:
                if caller is not None:
                    candidate_executor.terminate_direct_child(caller)
                    for stream in (caller.stdout, caller.stderr):
                        if stream is not None and not stream.closed:
                            stream.close()

    @unittest.skipUnless(sys.platform == "darwin", "covers macOS parent-death containment")
    def test_executor_death_cancels_reexecuted_sandbox_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate_dir = root / "candidate"
            writable_dir = root / "writable"
            candidate_dir.mkdir()
            writable_dir.mkdir()
            candidate = candidate_dir / "candidate.py"
            started = writable_dir / "started"
            delayed = writable_dir / "delayed"
            replacement = (
                "import time\n"
                "from pathlib import Path\n"
                f"Path({str(started)!r}).write_text('started')\n"
                "time.sleep(0.75)\n"
                f"Path({str(delayed)!r}).write_text('survived')\n"
            )
            candidate.write_text(
                "import os, sys\n"
                "def probe():\n"
                f"    os.execv(sys.executable, [sys.executable, '-c', {replacement!r}])\n",
                encoding="utf-8",
            )
            request = candidate_proxy._build_request("probe", (), (str(writable_dir),))
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(Path(candidate_executor.__file__).resolve()),
                    str(candidate),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
                start_new_session=True,
            )
            try:
                assert process.stdin is not None
                process.stdin.write(request)
                process.stdin.close()
                deadline = time.monotonic() + 5
                while not started.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(started.exists(), "reexecuted sandbox child did not start")
                process.kill()
                process.wait(timeout=5)
                time.sleep(1)
                self.assertFalse(delayed.exists())
            finally:
                candidate_executor.terminate_direct_child(process)
                for stream in (process.stdout, process.stderr):
                    if stream is not None and not stream.closed:
                        stream.close()

    @unittest.skipUnless(sys.platform == "darwin", "covers macOS parent-death containment")
    def test_executor_death_cancels_its_live_sandbox_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate_dir = root / "candidate"
            writable_dir = root / "writable"
            candidate_dir.mkdir()
            writable_dir.mkdir()
            candidate = candidate_dir / "candidate.py"
            started = writable_dir / "started"
            delayed = writable_dir / "delayed"
            candidate.write_text(
                "import time\n"
                "from pathlib import Path\n"
                "def probe(started: str, delayed: str) -> str:\n"
                "    Path(started).write_text('started')\n"
                "    time.sleep(0.75)\n"
                "    Path(delayed).write_text('survived')\n"
                "    return 'late'\n",
                encoding="utf-8",
            )
            request = candidate_proxy._build_request(
                "probe",
                (str(started), str(delayed)),
                (str(writable_dir),),
            )
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(Path(candidate_executor.__file__).resolve()),
                    str(candidate),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
                start_new_session=True,
            )
            try:
                assert process.stdin is not None
                process.stdin.write(request)
                process.stdin.close()
                deadline = time.monotonic() + 5
                while not started.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(started.exists(), "sandbox child did not start")
                process.kill()
                process.wait(timeout=5)
                time.sleep(1)
                self.assertFalse(delayed.exists())
            finally:
                candidate_executor.terminate_direct_child(process)
                for stream in (process.stdout, process.stderr):
                    if stream is not None and not stream.closed:
                        stream.close()

    def test_executor_timeout_terminates_owned_sandbox_group(self):
        class BoundaryProcess:
            pid = 303

        with mock.patch.object(
            candidate_executor,
            "_collect_bounded_output",
            side_effect=TimeoutError("sandboxed candidate exceeded time budget"),
        ), mock.patch.object(
            candidate_executor.subprocess,
            "Popen",
            return_value=BoundaryProcess(),
        ), mock.patch.object(candidate_executor, "_sandbox_command", return_value=["sandbox"]), mock.patch.object(
            candidate_executor, "terminate_owned_sandbox"
        ) as terminate:
            with tempfile.TemporaryDirectory() as tmp:
                candidate = Path(tmp) / "candidate.py"
                candidate.write_text("def probe(): return 'ok'\n", encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "exceeded time budget"):
                    candidate_executor._supervise(candidate, b'{"writable_paths": []}')
        terminate.assert_called_once_with(mock.ANY)

    def test_executor_invalid_response_does_not_teardown_reaped_sandbox(self):
        class ReapedProcess:
            pid = 305
            returncode = 0

            def poll(self):
                return 0

            def wait(self, *, timeout):
                return 0

        process = ReapedProcess()
        with mock.patch.object(
            candidate_executor,
            "_collect_bounded_output",
            return_value=(b"not-json", b""),
        ), mock.patch.object(
            candidate_executor.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(candidate_executor, "_sandbox_command", return_value=["sandbox"]), mock.patch.object(
            candidate_executor, "terminate_owned_sandbox"
        ) as terminate:
            with tempfile.TemporaryDirectory() as tmp:
                candidate = Path(tmp) / "candidate.py"
                candidate.write_text("def probe(): return 'ok'\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Expecting value"):
                    candidate_executor._supervise(candidate, b'{"writable_paths": []}')
        terminate.assert_not_called()

    def test_executor_non_exiting_candidate_terminates_owned_sandbox_once(self):
        class BoundaryProcess:
            pid = 304

            def poll(self):
                return None

            def wait(self, *, timeout):
                raise candidate_executor.subprocess.TimeoutExpired(["sandbox"], timeout)

        process = BoundaryProcess()
        with mock.patch.object(
            candidate_executor,
            "_collect_bounded_output",
            return_value=(b'{"ok":true,"value":"ok"}', b""),
        ), mock.patch.object(
            candidate_executor.subprocess,
            "Popen",
            return_value=process,
        ), mock.patch.object(candidate_executor, "_sandbox_command", return_value=["sandbox"]), mock.patch.object(
            candidate_executor, "terminate_owned_sandbox"
        ) as terminate:
            with tempfile.TemporaryDirectory() as tmp:
                candidate = Path(tmp) / "candidate.py"
                candidate.write_text("def probe(): return 'ok'\n", encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "did not exit after closing output"):
                    candidate_executor._supervise(candidate, b'{"writable_paths": []}')
        terminate.assert_called_once_with(process)

    def test_successful_output_collection_does_not_scan_host_processes(self):
        class Pipe:
            def __init__(self, fd: int):
                self._fd = fd
                self.closed = False

            def fileno(self):
                return self._fd

            def close(self):
                self.closed = True

            def write(self, value):
                return len(value)

        class Process:
            pid = 404

            def __init__(self):
                self.stdin = Pipe(10)
                self.stdout = Pipe(11)
                self.stderr = Pipe(12)

            def poll(self):
                return 0

        process = Process()

        def ready(readers, writers, timeout):
            return readers, writers

        with mock.patch.object(candidate_executor.fcntl, "fcntl", return_value=0), mock.patch.object(
            candidate_executor, "_poll_ready", side_effect=ready
        ), mock.patch.object(
            candidate_executor.os, "read", side_effect=[b'{"ok":true}', b"", b""]
        ), mock.patch.object(
            candidate_executor.subprocess,
            "run",
            side_effect=AssertionError("normal completion must not scan host processes"),
        ):
            stdout, stderr = candidate_executor._collect_bounded_output(
                process,
                request_bytes=b"{}",
                limit=1024,
                timeout=1,
            )
        self.assertEqual(b'{"ok":true}', stdout)
        self.assertEqual(b"", stderr)

    def test_direct_cleanup_ignores_reaped_root_to_avoid_pid_reuse(self):
        class ReapedProcess:
            pid = 606
            returncode = 0

        with mock.patch.object(
            candidate_executor.os,
            "killpg",
            side_effect=AssertionError("direct cleanup must not signal a process group"),
        ), mock.patch.object(
            candidate_executor.subprocess,
            "run",
            side_effect=AssertionError("direct cleanup must not scan host processes"),
        ):
            candidate_executor.terminate_direct_child(ReapedProcess())

    def test_direct_cleanup_kills_only_direct_child(self):
        class BoundaryProcess:
            pid = 101
            returncode = None

            def __init__(self):
                self.killed = False
                self.waited = False

            def kill(self):
                self.killed = True

            def wait(self, *, timeout):
                self.waited = True
                return 0

        process = BoundaryProcess()
        with mock.patch.object(
            candidate_executor.os,
            "killpg",
            side_effect=AssertionError("direct cleanup must not signal a process group"),
        ), mock.patch.object(
            candidate_executor.subprocess,
            "run",
            side_effect=AssertionError("direct cleanup must not scan host processes"),
        ):
            candidate_executor.terminate_direct_child(process)
        self.assertTrue(process.killed)
        self.assertTrue(process.waited)

    def test_guardian_does_not_spawn_after_owner_lifetime_ends(self):
        lifetime_reader, lifetime_writer = os.pipe()
        os.close(lifetime_writer)
        try:
            result = candidate_executor._guard_sandbox_child(
                lifetime_reader,
                ["candidate"],
                spawn=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                    AssertionError("candidate must not start after owner death")
                ),
            )
        finally:
            try:
                os.close(lifetime_reader)
            except OSError:
                pass
        self.assertEqual(125, result)

    def test_guardian_starts_lifetime_monitor_before_spawning_candidate(self):
        lifetime_reader, lifetime_writer = os.pipe()
        watcher_reading = threading.Event()
        real_read = candidate_executor.os.read

        class CompletedProcess:
            pid = 102
            returncode = 0

            def poll(self):
                return 0

        def observed_read(fd, size):
            if fd == lifetime_reader:
                watcher_reading.set()
            return real_read(fd, size)

        def spawn(*_args, **_kwargs):
            self.assertTrue(watcher_reading.is_set())
            return CompletedProcess()

        try:
            with mock.patch.object(candidate_executor.os, "read", side_effect=observed_read):
                self.assertEqual(
                    0,
                    candidate_executor._guard_sandbox_child(
                        lifetime_reader,
                        ["candidate"],
                        spawn=spawn,
                    ),
                )
        finally:
            os.close(lifetime_writer)

    def test_guardian_does_not_authorize_gate_when_owner_dies_during_spawn(self):
        lifetime_reader, lifetime_writer = os.pipe()
        gate_authorizations: list[bytes] = []

        class BoundaryProcess:
            pid = 102
            returncode = None

            def poll(self):
                return self.returncode

        def spawn(*_args, **_kwargs):
            os.close(lifetime_writer)
            return BoundaryProcess()

        with mock.patch.object(
            candidate_executor.os,
            "write",
            side_effect=lambda _fd, content: gate_authorizations.append(content),
        ), mock.patch.object(
            candidate_executor,
            "_terminate_guarded_sandbox",
            side_effect=lambda process: setattr(process, "returncode", -9),
        ):
            result = candidate_executor._guard_sandbox_child(
                lifetime_reader,
                ["candidate"],
                spawn=spawn,
            )
        self.assertEqual(125, result)
        self.assertEqual([], gate_authorizations)

    def test_guardian_waits_for_sandbox_termination_before_returning(self):
        lifetime_reader, lifetime_writer = os.pipe()

        class BoundaryProcess:
            pid = 102

            def poll(self):
                return None

        termination_started = threading.Event()
        allow_termination = threading.Event()

        def terminate(_process):
            termination_started.set()
            self.assertTrue(allow_termination.wait(1))

        spawned = threading.Event()

        def spawn(*_args, **_kwargs):
            spawned.set()
            return BoundaryProcess()

        result: list[int] = []
        guardian = threading.Thread(
            target=lambda: result.append(
                candidate_executor._guard_sandbox_child(
                    lifetime_reader,
                    ["candidate"],
                    spawn=spawn,
                )
            )
        )
        with mock.patch.object(
            candidate_executor,
            "_terminate_guarded_sandbox",
            side_effect=terminate,
        ):
            guardian.start()
            self.assertTrue(spawned.wait(1))
            os.close(lifetime_writer)
            self.assertTrue(termination_started.wait(1))
            self.assertTrue(guardian.is_alive())
            allow_termination.set()
            guardian.join(1)
        self.assertFalse(guardian.is_alive())
        self.assertEqual([125], result)

    def test_guardian_cleanup_signals_its_own_process_group(self):
        class BoundaryProcess:
            pid = 102

            def poll(self):
                return None

        killed_groups: list[int] = []
        with mock.patch.object(
            candidate_executor.os,
            "getpgrp",
            return_value=102,
        ), mock.patch.object(
            candidate_executor.os,
            "getpid",
            return_value=102,
        ), mock.patch.object(
            candidate_executor.os,
            "killpg",
            side_effect=lambda pgid, _: killed_groups.append(pgid),
        ):
            candidate_executor._terminate_guarded_sandbox(BoundaryProcess())
        self.assertEqual([102], killed_groups)

    def test_owned_sandbox_cleanup_signals_only_its_live_group(self):
        class BoundaryProcess:
            pid = 101
            returncode = None

            def wait(self, *, timeout):
                return 0

        killed_groups: list[int] = []
        with mock.patch.object(
            candidate_executor.os,
            "killpg",
            side_effect=lambda pgid, _: killed_groups.append(pgid),
        ), mock.patch.object(
            candidate_executor.subprocess,
            "run",
            side_effect=AssertionError("sandbox cleanup must not scan host processes"),
        ):
            candidate_executor.terminate_owned_sandbox(BoundaryProcess())
        self.assertEqual([101], killed_groups)

    def test_candidate_detached_session_child_does_not_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate_dir = root / "candidate"
            writable_dir = root / "writable"
            candidate_dir.mkdir()
            writable_dir.mkdir()
            marker = writable_dir / "delayed-marker"
            null_in = writable_dir / "stdin.empty"
            null_out = writable_dir / "stdout.empty"
            null_err = writable_dir / "stderr.empty"
            null_in.write_bytes(b"")
            null_out.write_bytes(b"")
            null_err.write_bytes(b"")
            candidate = candidate_dir / "candidate.py"
            candidate.write_text(
                "import subprocess\n"
                "import sys\n"
                "from pathlib import Path\n"
                "\n"
                "def probe(marker_path: str, stdin_path: str, stdout_path: str, stderr_path: str) -> str:\n"
                "    # A surviving detached child would publish a delayed observable effect.\n"
                "    with open(stdin_path, 'rb') as stdin_handle, open(stdout_path, 'wb') as stdout_handle, open(\n"
                "        stderr_path, 'wb'\n"
                "    ) as stderr_handle:\n"
                "        subprocess.Popen(\n"
                "            [\n"
                "                sys.executable,\n"
                "                '-c',\n"
                "                (\n"
                "                    'import time\\n'\n"
                "                    'time.sleep(0.25)\\n'\n"
                "                    f'open({marker_path!r}, \"w\").write(\"survived\")\\n'\n"
                "                ),\n"
                "            ],\n"
                "            start_new_session=True,\n"
                "            close_fds=True,\n"
                "            stdin=stdin_handle,\n"
                "            stdout=stdout_handle,\n"
                "            stderr=stderr_handle,\n"
                "        )\n"
                "    return 'ok'\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                try:
                    value = candidate_proxy._invoke(
                        "probe",
                        str(marker),
                        str(null_in),
                        str(null_out),
                        str(null_err),
                        writable_paths=(str(writable_dir),),
                    )
                except RuntimeError as exc:
                    # macOS kernel process-fork denial surfaces as a failed candidate call.
                    self.assertRegex(
                        str(exc),
                        r"Operation not permitted|Permission denied|fork|process|sandbox|failed",
                    )
                else:
                    self.assertEqual("ok", value)
            time.sleep(1)
            self.assertFalse(marker.exists(), "detached sandbox child published its delayed marker")

    def test_candidate_os_sandbox_denies_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.py"
            candidate.write_text(
                "import socket\n"
                "def probe():\n"
                "    connection = socket.socket()\n"
                "    connection.connect(('127.0.0.1', 1))\n"
                "    return 'forged-green'\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "Operation not permitted|Network is unreachable",
                ):
                    candidate_proxy._invoke("probe")

    @unittest.skipUnless(sys.platform == "darwin", "macOS runtime discovery regression")
    def test_parallel_candidate_calls_stay_within_executor_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.py"
            candidate.write_text(
                "import re\n"
                "def slugify(title: str) -> str:\n"
                "    return re.sub(r'[^A-Za-z0-9]+', '-', title).strip('-').lower()\n",
                encoding="utf-8",
            )
            titles = [f"Parallel candidate {index}" for index in range(16)]
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                with ThreadPoolExecutor(max_workers=len(titles)) as pool:
                    results = list(pool.map(candidate_proxy.slugify, titles))
            self.assertEqual(
                [f"parallel-candidate-{index}" for index in range(len(titles))],
                results,
            )

    def test_candidate_os_sandbox_keeps_candidate_source_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.py"
            candidate.write_text(
                "from pathlib import Path\n"
                "def probe():\n"
                "    Path(__file__).write_text('tampered')\n"
                "    return 'forged-green'\n",
                encoding="utf-8",
            )
            original = candidate.read_bytes()
            with mock.patch.dict(os.environ, {"VDD_CANDIDATE_PATH": str(candidate)}):
                with self.assertRaisesRegex(RuntimeError, "Operation not permitted"):
                    candidate_proxy._invoke("probe")
            self.assertEqual(original, candidate.read_bytes())

    def test_candidate_process_does_not_inherit_ambient_secret(self):
        source = """import os
import re


def slugify(title: str) -> str:
    if os.environ.get("VDD_TEST_SECRET"):
        return "secret-leaked"
    return re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()
"""
        with mock.patch.dict(os.environ, {"VDD_TEST_SECRET": "sensitive"}):
            result = self._run_candidate(6, source)
        self.assertEqual("accepted", result["disposition"])

    def test_slugify_candidate_can_reach_qualified_green(self):
        source = """import re


def slugify(title: str) -> str:
    return re.sub(r\"[^A-Za-z0-9]+\", \"-\", title).strip(\"-\").lower()
"""
        result = self._run_candidate(6, source)
        self.assertEqual("accepted", result["disposition"])

    def test_email_candidate_can_reach_qualified_green(self):
        source = """def normalize_email(value: str) -> str:
    local, domain = value.strip().split(\"@\", 1)
    return f\"{local}@{domain.lower()}\"
"""
        result = self._run_candidate(7, source, filename="app.py")
        self.assertEqual("accepted", result["disposition"])

    def test_discount_candidate_can_reach_qualified_green(self):
        source = """def discount(total: int) -> int:
    return total * 90 // 100 if total >= 100 else total
"""
        result = self._run_candidate(10, source)
        self.assertEqual("accepted", result["disposition"])

    def test_webhook_candidate_can_reach_qualified_green(self):
        source = '''from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3

SECRET = b"test-secret"


def ingest_webhook(body: bytes, signature: str, timestamp: int, now: int, db_path: str):
    expected = "sha256=" + hmac.new(
        SECRET, str(timestamp).encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return 401, "invalid_signature"
    if abs(now - timestamp) > 300:
        return 401, "stale"
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 400, "invalid_payload"
    event_id = value.get("id") if isinstance(value, dict) else None
    if not isinstance(event_id, str) or not event_id:
        return 400, "invalid_payload"

    connection = None
    try:
        connection = sqlite3.connect(db_path, timeout=10, isolation_level=None)
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, body BLOB NOT NULL)"
        )
        existing = connection.execute(
            "SELECT 1 FROM events WHERE event_id = ?", (event_id,)
        ).fetchone()
        if existing:
            connection.execute("COMMIT")
            return 200, "duplicate"
        connection.execute(
            "INSERT INTO events(event_id, body) VALUES (?, ?)",
            (event_id, sqlite3.Binary(body)),
        )
        connection.execute("COMMIT")
        return 202, "accepted"
    except sqlite3.Error:
        if connection is not None:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
        return 503, "persistence_error"
    finally:
        if connection is not None:
            connection.close()
'''
        result = self._run_candidate(5, source)
        self.assertEqual("accepted", result["disposition"], result["candidate"]["run"]["output"])

    def _run_candidate(self, case_id: int, source: str, filename: str = "candidate.py") -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / filename).write_text(source, encoding="utf-8")
            return run_fixtures.run_case(case_id, workspace)


if __name__ == "__main__":
    unittest.main()
