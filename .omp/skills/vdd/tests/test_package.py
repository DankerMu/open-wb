from __future__ import annotations

import hashlib
import os
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
import package_vdd


MANIFEST = ROOT / "MANIFEST.sha256"
ARCHIVE = ROOT / "vdd-0.4.0.zip"
DERIVED_FILES = {"MANIFEST.sha256", "vdd-0.4.0.zip"}
TRANSIENT_COMPONENTS = {"__pycache__"}
TRANSIENT_FILES = {".DS_Store"}


def manifest_entries(raw: str | None = None) -> dict[str, str]:
    raw = MANIFEST.read_text(encoding="utf-8") if raw is None else raw
    entries: dict[str, str] = {}
    for raw_line in raw.splitlines():
        digest, separator, relative = raw_line.partition("  ")
        if (
            not separator
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
            or not relative
        ):
            raise AssertionError(f"invalid manifest entry: {raw_line!r}")
        path = Path(relative)
        if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
            raise AssertionError(f"unsafe manifest path: {relative!r}")
        if relative in entries:
            raise AssertionError(f"duplicate manifest path: {relative}")
        entries[relative] = digest
    if list(entries) != sorted(entries):
        raise AssertionError("manifest paths are not sorted")
    return entries


def package_source_entries() -> set[str]:
    entries: set[str] = set()
    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT).as_posix()
        if relative in DERIVED_FILES or path.name in TRANSIENT_FILES:
            continue
        if TRANSIENT_COMPONENTS.intersection(path.relative_to(ROOT).parts) or path.name.endswith(
            ".pyc"
        ):
            continue
        status = path.lstat()
        if stat.S_ISDIR(status.st_mode):
            continue
        if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode):
            raise AssertionError(f"package source is not a regular file: {relative}")
        entries.add(relative)
    return entries


class PackageIntegrityTests(unittest.TestCase):
    def test_manifest_is_closed_inventory_of_package_sources(self):
        self.assertEqual(package_source_entries(), set(manifest_entries()))

    def test_manifest_parser_rejects_duplicate_paths(self):
        duplicate = "\n".join(
            [
                f"{'0' * 64}  SKILL.md",
                f"{'1' * 64}  SKILL.md",
            ]
        )
        with self.assertRaisesRegex(AssertionError, "duplicate manifest path"):
            manifest_entries(duplicate)

    def test_manifest_hashes_match_packaged_source_files(self):
        for relative, expected_digest in manifest_entries().items():
            with self.subTest(relative=relative):
                path = ROOT / relative
                source_mode = stat.S_IMODE(path.lstat().st_mode)
                self.assertEqual(0, source_mode & ~0o777)
                actual_digest = hashlib.sha256(path.read_bytes()).hexdigest()
                self.assertEqual(expected_digest, actual_digest)

    def test_archive_exactly_matches_manifest(self):
        entries = manifest_entries()
        expected_names = ["vdd/MANIFEST.sha256"]
        expected_names.extend(f"vdd/{relative}" for relative in entries)
        with ZipFile(ARCHIVE) as archive:
            self.assertEqual(expected_names, archive.namelist())
            self.assertEqual(b"", archive.comment)
            self.assertEqual(MANIFEST.read_bytes(), archive.read("vdd/MANIFEST.sha256"))
            manifest_info = archive.getinfo("vdd/MANIFEST.sha256")
            self.assertEqual(3, manifest_info.create_system)
            self.assertEqual((1980, 1, 1, 0, 0, 0), manifest_info.date_time)
            self.assertEqual(b"", manifest_info.extra)
            self.assertEqual(ZIP_DEFLATED, manifest_info.compress_type)
            self.assertEqual(0, manifest_info.flag_bits)
            self.assertEqual(stat.S_IFREG | 0o644, manifest_info.external_attr >> 16)
            for relative, expected_digest in entries.items():
                with self.subTest(relative=relative):
                    info = archive.getinfo(f"vdd/{relative}")
                    actual_digest = hashlib.sha256(archive.read(info)).hexdigest()
                    self.assertEqual(expected_digest, actual_digest)
                    source_mode = stat.S_IMODE((ROOT / relative).lstat().st_mode)
                    self.assertEqual(3, info.create_system)
                    self.assertEqual((1980, 1, 1, 0, 0, 0), info.date_time)
                    self.assertEqual(b"", info.extra)
                    self.assertEqual(ZIP_DEFLATED, info.compress_type)
                    self.assertEqual(0, info.flag_bits)
                    self.assertEqual(
                        stat.S_IFREG | source_mode,
                        info.external_attr >> 16,
                    )
        self.assertFalse(
            any("__pycache__" in name or name.endswith(".pyc") for name in expected_names)
        )

    def test_canonical_generator_reproduces_committed_manifest_and_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            generated_manifest = temporary_root / "MANIFEST.sha256"
            generated_archive = temporary_root / "vdd-0.4.0.zip"
            package_vdd.build_package(
                ROOT,
                manifest_path=generated_manifest,
                archive_path=generated_archive,
            )
            self.assertEqual(MANIFEST.read_bytes(), generated_manifest.read_bytes())
            self.assertEqual(ARCHIVE.read_bytes(), generated_archive.read_bytes())

    def test_generator_rejects_overlapping_or_source_output_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            source = package_root / "source.txt"
            source.write_text("source", encoding="utf-8")
            outside = temporary_root / "outside"
            outside.mkdir()

            with self.assertRaisesRegex(ValueError, "output paths must be distinct"):
                package_vdd.build_package(
                    package_root,
                    manifest_path=outside / "same",
                    archive_path=outside / "same",
                )
            with self.assertRaisesRegex(ValueError, "output path overlaps package source"):
                package_vdd.build_package(
                    package_root,
                    manifest_path=source,
                    archive_path=outside / "archive.zip",
                )
            with self.assertRaisesRegex(ValueError, "custom output must be outside package root"):
                package_vdd.build_package(
                    package_root,
                    manifest_path=package_root / "custom.manifest",
                    archive_path=outside / "archive.zip",
                )
            self.assertEqual("source", source.read_text(encoding="utf-8"))

    def test_generator_rejects_symlinked_source_ancestor_swapped_after_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            source_dir = package_root / "source"
            source_dir.mkdir(parents=True)
            (source_dir / "data.txt").write_bytes(b"inside")
            outside = temporary_root / "outside"
            outside.mkdir()
            (outside / "data.txt").write_bytes(b"outside")
            output = temporary_root / "output"
            output.mkdir()
            real_snapshot = package_vdd.snapshot_sources

            def swap_then_snapshot(root, entries=None):
                source_dir.rename(package_root / "original")
                source_dir.symlink_to(outside, target_is_directory=True)
                return real_snapshot(root, entries)

            with mock.patch.object(package_vdd, "snapshot_sources", side_effect=swap_then_snapshot):
                with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
                    package_vdd.build_package(
                        package_root,
                        manifest_path=output / "manifest",
                        archive_path=output / "archive",
                    )
            self.assertEqual([], list(output.iterdir()))

    def test_generator_rejects_output_parent_swap_before_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            (package_root / "source.txt").write_bytes(b"source")
            output = temporary_root / "output"
            output.mkdir()
            redirected = temporary_root / "redirected"
            redirected.mkdir()
            real_publish = package_vdd._publish_pair

            def swap_then_publish(manifest, manifest_path, archive_bytes, archive_path, **kwargs):
                output.rename(temporary_root / "original-output")
                output.symlink_to(redirected, target_is_directory=True)
                return real_publish(
                    manifest,
                    manifest_path,
                    archive_bytes,
                    archive_path,
                    **kwargs,
                )

            with mock.patch.object(package_vdd, "_publish_pair", side_effect=swap_then_publish):
                with self.assertRaises((OSError, ValueError, RuntimeError)):
                    package_vdd.build_package(
                        package_root,
                        manifest_path=output / "manifest",
                        archive_path=output / "archive",
                    )
            self.assertEqual([], list(redirected.iterdir()))

    def test_generator_closes_first_output_parent_when_second_open_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            valid = temporary_root / "valid"
            valid.mkdir()
            redirected = temporary_root / "redirected"
            redirected.mkdir()
            invalid = temporary_root / "invalid"
            invalid.symlink_to(redirected, target_is_directory=True)
            before = len(os.listdir("/dev/fd"))

            for _ in range(20):
                with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
                    package_vdd._publish_pair(
                        b"manifest",
                        valid / "manifest",
                        b"archive",
                        invalid / "archive",
                    )

            self.assertEqual(before, len(os.listdir("/dev/fd")))

    def test_generator_rejects_output_symlinks_without_overwriting_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            (package_root / "source.txt").write_bytes(b"source")
            target = temporary_root / "target"
            target.write_bytes(b"protected")
            (package_root / "MANIFEST.sha256").symlink_to(target)

            with self.assertRaisesRegex(ValueError, "must not contain symlinks"):
                package_vdd.build_package(package_root)
            self.assertEqual(b"protected", target.read_bytes())

    def test_generator_rejects_source_names_that_break_manifest_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            (package_root / "unsafe\nname.txt").write_text("source", encoding="utf-8")
            output_root = temporary_root / "output"
            output_root.mkdir()

            with self.assertRaisesRegex(ValueError, "newline"):
                package_vdd.build_package(
                    package_root,
                    manifest_path=output_root / "MANIFEST.sha256",
                    archive_path=output_root / "archive.zip",
                )
            self.assertEqual([], list(output_root.iterdir()))

    def test_generator_rejects_backslash_names_unsafe_for_zip_extractors(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            (package_root / "..\\payload").write_bytes(b"source")
            output_root = temporary_root / "output"
            output_root.mkdir()

            with self.assertRaisesRegex(ValueError, "ZIP-unsafe backslash"):
                package_vdd.build_package(
                    package_root,
                    manifest_path=output_root / "MANIFEST.sha256",
                    archive_path=output_root / "archive.zip",
                )
            self.assertEqual([], list(output_root.iterdir()))

    def test_generator_rejects_stale_snapshot_after_waiting_for_publication_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            source = package_root / "source.txt"
            source.write_bytes(b"version one")
            output = temporary_root / "output"
            output.mkdir()
            manifest = output / "manifest"
            archive = output / "archive"
            first_waiting = threading.Event()
            allow_first_to_lock = threading.Event()
            real_publish = package_vdd._publish_pair
            errors: list[BaseException] = []

            def delay_first_publish(*args, **kwargs):
                if threading.current_thread().name == "first":
                    first_waiting.set()
                    self.assertTrue(allow_first_to_lock.wait(2))
                return real_publish(*args, **kwargs)

            def build():
                try:
                    package_vdd.build_package(
                        package_root,
                        manifest_path=manifest,
                        archive_path=archive,
                    )
                except BaseException as exc:
                    errors.append(exc)

            with mock.patch.object(package_vdd, "_publish_pair", side_effect=delay_first_publish):
                first = threading.Thread(name="first", target=build)
                first.start()
                self.assertTrue(first_waiting.wait(2))
                source.write_bytes(b"version two")
                second = threading.Thread(name="second", target=build)
                second.start()
                second.join(2)
                allow_first_to_lock.set()
                first.join(2)

            self.assertEqual(1, len(errors))
            self.assertRegex(str(errors[0]), "source changed")
            with ZipFile(archive) as generated:
                self.assertEqual(b"version two", generated.read("vdd/source.txt"))

    def test_generator_serializes_concurrent_publication_of_one_output_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            output = temporary_root / "output"
            output.mkdir()
            manifest = output / "manifest"
            archive = output / "archive"
            first_replaced = threading.Event()
            allow_first_to_finish = threading.Event()
            real_replace = package_vdd.os.replace
            errors: list[BaseException] = []

            def pause_first_publisher(source, destination, **kwargs):
                result = real_replace(source, destination, **kwargs)
                if threading.current_thread().name == "first" and destination == manifest.name:
                    first_replaced.set()
                    self.assertTrue(allow_first_to_finish.wait(2))
                return result

            def publish(tag: str):
                try:
                    package_vdd._publish_pair(
                        f"manifest-{tag}".encode(),
                        manifest,
                        f"archive-{tag}".encode(),
                        archive,
                    )
                except BaseException as exc:
                    errors.append(exc)

            with mock.patch.object(package_vdd.os, "replace", side_effect=pause_first_publisher):
                first = threading.Thread(name="first", target=publish, args=("A",))
                second = threading.Thread(name="second", target=publish, args=("B",))
                first.start()
                self.assertTrue(first_replaced.wait(2))
                second.start()
                time.sleep(0.05)
                allow_first_to_finish.set()
                first.join(2)
                second.join(2)

            self.assertEqual([], errors)
            self.assertEqual(manifest.read_bytes()[-1:], archive.read_bytes()[-1:])

    def test_generator_restores_previous_pair_when_second_publish_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            (package_root / "source.txt").write_text("new source", encoding="utf-8")
            manifest = (package_root / "MANIFEST.sha256").resolve()
            archive = (package_root / "vdd-0.4.0.zip").resolve()
            manifest.write_bytes(b"old manifest")
            archive.write_bytes(b"old archive")
            real_replace = package_vdd.os.replace
            publish_count = 0

            def fail_second_publish(source, destination, **kwargs):
                nonlocal publish_count
                if destination in {manifest.name, archive.name}:
                    publish_count += 1
                    if publish_count == 2:
                        raise OSError("injected second publish failure")
                return real_replace(source, destination, **kwargs)

            with mock.patch.object(package_vdd.os, "replace", side_effect=fail_second_publish):
                with self.assertRaisesRegex(OSError, "injected second publish failure"):
                    package_vdd.build_package(package_root)

            self.assertEqual(b"old manifest", manifest.read_bytes())
            self.assertEqual(b"old archive", archive.read_bytes())
            self.assertEqual(
                {"source.txt", "MANIFEST.sha256", "vdd-0.4.0.zip"},
                {path.name for path in package_root.iterdir()},
            )

    def test_generator_preserves_backup_when_rollback_replacement_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            manifest = temporary_root / "manifest"
            archive = temporary_root / "archive"
            manifest.write_bytes(b"old manifest")
            archive.write_bytes(b"old archive")
            real_replace = package_vdd.os.replace
            publish_count = 0

            def fail_publish_and_restore(source, destination, **kwargs):
                nonlocal publish_count
                if destination in {manifest.name, archive.name}:
                    publish_count += 1
                    if publish_count == 2:
                        raise OSError("publish failed")
                    if publish_count == 3:
                        raise OSError("restore failed")
                return real_replace(source, destination, **kwargs)

            with mock.patch.object(package_vdd.os, "replace", side_effect=fail_publish_and_restore):
                with self.assertRaisesRegex(OSError, "publish failed") as raised:
                    package_vdd._publish_pair(b"new manifest", manifest, b"new archive", archive)

            self.assertTrue(any("restore failed" in note for note in raised.exception.__notes__))
            self.assertTrue(any("preserved at" in note for note in raised.exception.__notes__))
            backups = list(temporary_root.glob(".manifest.*"))
            self.assertEqual(1, len(backups))
            self.assertEqual(b"old manifest", backups[0].read_bytes())

    def test_stage_bytes_closes_descriptor_when_fchmod_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            target = package_vdd._open_output_target(temporary_root / "manifest")
            before = len(os.listdir("/dev/fd"))
            try:
                with mock.patch.object(
                    package_vdd.os,
                    "fchmod",
                    side_effect=OSError("injected chmod failure"),
                ):
                    with self.assertRaisesRegex(OSError, "injected chmod failure"):
                        package_vdd._stage_bytes(target, b"content", 0o644)
                self.assertEqual(before, len(os.listdir("/dev/fd")))
                self.assertEqual([], list(temporary_root.iterdir()))
            finally:
                os.close(target.parent_fd)

    def test_generator_cleanup_failure_does_not_mask_publish_error_or_leak_fds(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            manifest = temporary_root / "manifest"
            archive = temporary_root / "archive"
            manifest.write_bytes(b"old manifest")
            archive.write_bytes(b"old archive")
            before = len(os.listdir("/dev/fd"))
            real_replace = package_vdd.os.replace
            real_unlink = package_vdd.os.unlink
            publish_count = 0
            cleanup_failed = False

            def fail_second_publish(source, destination, **kwargs):
                nonlocal publish_count
                if destination in {manifest.name, archive.name}:
                    publish_count += 1
                    if publish_count == 2:
                        raise OSError("publish failed")
                return real_replace(source, destination, **kwargs)

            def fail_one_cleanup(path, **kwargs):
                nonlocal cleanup_failed
                if not cleanup_failed and str(path).startswith(".archive."):
                    cleanup_failed = True
                    raise OSError("cleanup failed")
                return real_unlink(path, **kwargs)

            with mock.patch.object(package_vdd.os, "replace", side_effect=fail_second_publish), mock.patch.object(
                package_vdd.os,
                "unlink",
                side_effect=fail_one_cleanup,
            ):
                with self.assertRaisesRegex(OSError, "publish failed") as raised:
                    package_vdd._publish_pair(b"new manifest", manifest, b"new archive", archive)

            self.assertTrue(any("cleanup failed" in note for note in raised.exception.__notes__))
            self.assertEqual(before, len(os.listdir("/dev/fd")))

    def test_generator_rollback_restores_original_mode_under_restrictive_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            manifest = temporary_root / "manifest"
            archive = temporary_root / "archive"
            manifest.write_bytes(b"old manifest")
            archive.write_bytes(b"old archive")
            os.chmod(manifest, 0o644)
            os.chmod(archive, 0o644)
            real_replace = package_vdd.os.replace
            publish_count = 0

            def fail_second_publish(source, destination, **kwargs):
                nonlocal publish_count
                if destination in {manifest.name, archive.name}:
                    publish_count += 1
                    if publish_count == 2:
                        raise OSError("injected failure")
                return real_replace(source, destination, **kwargs)

            previous_umask = os.umask(0o077)
            try:
                with mock.patch.object(package_vdd.os, "replace", side_effect=fail_second_publish):
                    with self.assertRaisesRegex(OSError, "injected failure"):
                        package_vdd._publish_pair(b"new manifest", manifest, b"new archive", archive)
            finally:
                os.umask(previous_umask)

            self.assertEqual(0o644, stat.S_IMODE(manifest.stat().st_mode))
            self.assertEqual(0o644, stat.S_IMODE(archive.stat().st_mode))

    def test_generator_rejects_source_root_replacement_after_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            (package_root / "source.txt").write_bytes(b"original")
            replacement = temporary_root / "replacement"
            replacement.mkdir()
            (replacement / "source.txt").write_bytes(b"replacement")
            output = temporary_root / "output"
            output.mkdir()
            real_snapshot = package_vdd.snapshot_sources

            def swap_root_before_snapshot(root, entries=None):
                package_root.rename(temporary_root / "original-package")
                replacement.rename(package_root)
                return real_snapshot(root, entries)

            with mock.patch.object(package_vdd, "snapshot_sources", side_effect=swap_root_before_snapshot):
                with self.assertRaisesRegex(RuntimeError, "source root changed"):
                    package_vdd.build_package(
                        package_root,
                        manifest_path=output / "manifest",
                        archive_path=output / "archive",
                    )
            self.assertEqual([], list(output.iterdir()))

    def test_generator_supports_external_outputs_for_read_only_source_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            source_parent = temporary_root / "source-parent"
            package_root = source_parent / "package"
            package_root.mkdir(parents=True)
            (package_root / "source.txt").write_bytes(b"source")
            output = temporary_root / "output"
            output.mkdir()
            os.chmod(source_parent, 0o555)
            try:
                with mock.patch.object(
                    package_vdd.tempfile,
                    "TemporaryDirectory",
                    wraps=tempfile.TemporaryDirectory,
                ) as temporary_directory:
                    package_vdd.build_package(
                        package_root,
                        manifest_path=output / "manifest",
                        archive_path=output / "archive",
                    )
                self.assertIsNone(temporary_directory.call_args.kwargs.get("dir"))
            finally:
                os.chmod(source_parent, 0o755)
            self.assertTrue((output / "manifest").is_file())
            self.assertTrue((output / "archive").is_file())

    def test_generator_rejects_earlier_source_changed_during_later_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            first = package_root / "a.txt"
            first.write_bytes(b"first")
            (package_root / "z.txt").write_bytes(b"last")
            output = temporary_root / "output"
            output.mkdir()
            real_snapshot = package_vdd.snapshot_sources

            def mutate_after_snapshot(root, entries=None):
                sources = real_snapshot(root, entries)
                first.write_bytes(b"changed")
                return sources

            with mock.patch.object(package_vdd, "snapshot_sources", side_effect=mutate_after_snapshot):
                with self.assertRaisesRegex(RuntimeError, "source changed"):
                    package_vdd.build_package(
                        package_root,
                        manifest_path=output / "manifest",
                        archive_path=output / "archive",
                    )
            self.assertEqual([], list(output.iterdir()))

    def test_generator_rejects_inventory_growth_during_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            (package_root / "source.txt").write_bytes(b"source")
            output_root = temporary_root / "output"
            output_root.mkdir()
            real_snapshot = package_vdd.snapshot_sources

            def add_source_after_snapshot(root, entries=None):
                sources = real_snapshot(root, entries)
                (package_root / "late.txt").write_bytes(b"late")
                return sources

            with mock.patch.object(
                package_vdd,
                "snapshot_sources",
                side_effect=add_source_after_snapshot,
            ):
                with self.assertRaisesRegex(RuntimeError, "inventory changed"):
                    package_vdd.build_package(
                        package_root,
                        manifest_path=output_root / "MANIFEST.sha256",
                        archive_path=output_root / "archive.zip",
                    )
            self.assertEqual([], list(output_root.iterdir()))

    def test_generator_uses_one_source_snapshot_for_both_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary_root = Path(tmp).resolve()
            package_root = temporary_root / "package"
            package_root.mkdir()
            source = package_root / "source.txt"
            source.write_bytes(b"first version")
            output_root = temporary_root / "output"
            output_root.mkdir()
            manifest = output_root / "MANIFEST.sha256"
            archive = output_root / "archive.zip"
            package_vdd.build_package(
                package_root,
                manifest_path=manifest,
                archive_path=archive,
            )

            expected_digest = hashlib.sha256(b"first version").hexdigest()
            self.assertEqual(
                f"{expected_digest}  source.txt\n".encode(),
                manifest.read_bytes(),
            )
            with ZipFile(archive) as generated:
                self.assertEqual(b"first version", generated.read("vdd/source.txt"))
                self.assertEqual(manifest.read_bytes(), generated.read("vdd/MANIFEST.sha256"))


if __name__ == "__main__":
    unittest.main()
