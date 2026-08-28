#!/usr/bin/env python3
"""Build the deterministic VDD source manifest and distributable archive."""
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import os
import secrets
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_NAME = "MANIFEST.sha256"
ARCHIVE_NAME = "vdd-0.4.0.zip"
ARCHIVE_PREFIX = "vdd"
FIXED_ARCHIVE_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
DERIVED_FILES = {MANIFEST_NAME, ARCHIVE_NAME}
TRANSIENT_COMPONENTS = {"__pycache__"}
TRANSIENT_FILES = {".DS_Store"}


@dataclass(frozen=True)
class SourceSnapshot:
    relative: str
    content: bytes
    mode: int
    identity: tuple[int, int, int, int, int, int]


@dataclass
class OutputTarget:
    path: Path
    parent_fd: int
    parent_identity: tuple[int, int, int]

    @property
    def name(self) -> str:
        return self.path.name


def _is_packaged_source(path: Path, root: Path) -> bool:
    relative = path.relative_to(root)
    if any("\n" in part or "\r" in part for part in relative.parts):
        raise ValueError(f"package source path contains a newline: {relative!s}")
    if any("\\" in part for part in relative.parts):
        raise ValueError(f"package source path contains a ZIP-unsafe backslash: {relative!s}")
    if relative.as_posix() in DERIVED_FILES or path.name in TRANSIENT_FILES:
        return False
    if TRANSIENT_COMPONENTS.intersection(relative.parts) or path.name.endswith(".pyc"):
        return False
    status = path.lstat()
    if stat.S_ISDIR(status.st_mode):
        return False
    if stat.S_ISLNK(status.st_mode):
        raise ValueError(f"package source must not be a symlink: {relative}")
    if not stat.S_ISREG(status.st_mode):
        raise ValueError(f"package source must be a regular file: {relative}")
    if stat.S_IMODE(status.st_mode) & ~0o777:
        raise ValueError(f"package source has unsupported mode bits: {relative}")
    return True


def source_entries(root: Path) -> list[str]:
    root = root.resolve()
    entries = [
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if _is_packaged_source(path, root)
    ]
    return sorted(entries)


def _stable_identity(status: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        status.st_dev, status.st_ino, status.st_mode, status.st_size,
        status.st_mtime_ns, status.st_ctime_ns,
    )


def _open_source_beneath(root_fd: int, relative: str) -> int:
    parts = Path(relative).parts
    directory_fd = os.dup(root_fd)
    try:
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        for part in parts[:-1]:
            next_fd = os.open(part, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        return os.open(parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=directory_fd)
    except OSError as exc:
        if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise ValueError(f"package source path must not contain symlinks: {relative}") from exc
        raise
    finally:
        os.close(directory_fd)


def _read_stable_source(root_fd: int, relative: str) -> SourceSnapshot:
    descriptor = _open_source_beneath(root_fd, relative)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"package source must be a regular file: {relative}")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            content = source.read()
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if _stable_identity(before) != _stable_identity(after):
        raise RuntimeError(f"package source changed while being read: {relative}")
    return SourceSnapshot(relative, content, stat.S_IMODE(before.st_mode), _stable_identity(after))


def snapshot_sources(root: Path, entries: list[str] | None = None) -> tuple[SourceSnapshot, ...]:
    root = root.resolve()
    entries = source_entries(root) if entries is None else entries
    root_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        return tuple(_read_stable_source(root_fd, relative) for relative in entries)
    finally:
        os.close(root_fd)


def verify_source_snapshot(root: Path, sources: tuple[SourceSnapshot, ...]) -> None:
    root_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        for source in sources:
            descriptor = _open_source_beneath(root_fd, source.relative)
            try:
                current = os.fstat(descriptor)
            finally:
                os.close(descriptor)
            if _stable_identity(current) != source.identity:
                raise RuntimeError(f"package source changed while taking snapshot: {source.relative}")
    finally:
        os.close(root_fd)


def render_manifest(sources: tuple[SourceSnapshot, ...]) -> bytes:
    lines = [f"{hashlib.sha256(source.content).hexdigest()}  {source.relative}" for source in sources]
    return ("\n".join(lines) + "\n").encode("utf-8")


def _archive_info(relative: str, mode: int) -> ZipInfo:
    info = ZipInfo(f"{ARCHIVE_PREFIX}/{relative}", FIXED_ARCHIVE_TIMESTAMP)
    info.create_system = 3
    info.compress_type = ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | mode) << 16
    return info


def write_archive(path: Path, manifest: bytes, sources: tuple[SourceSnapshot, ...]) -> None:
    with ZipFile(path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr(_archive_info(MANIFEST_NAME, 0o644), manifest)
        for source in sources:
            archive.writestr(_archive_info(source.relative, source.mode), source.content,
                             compress_type=ZIP_DEFLATED, compresslevel=9)


def _absolute_lexical(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _reject_symlink_path(path: Path) -> None:
    cursor = path
    while True:
        try:
            status = cursor.lstat()
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISLNK(status.st_mode):
                raise ValueError(f"package output path must not contain symlinks: {path}")
        if cursor == cursor.parent:
            break
        cursor = cursor.parent


def _validate_outputs(root: Path, manifest_path: Path, archive_path: Path, entries: list[str]) -> None:
    if manifest_path == archive_path:
        raise ValueError("manifest and archive output paths must be distinct")
    source_paths = {_absolute_lexical(root / relative) for relative in entries}
    canonical_outputs = {root / MANIFEST_NAME, root / ARCHIVE_NAME}
    for output_path in (manifest_path, archive_path):
        _reject_symlink_path(output_path)
        if output_path in source_paths:
            raise ValueError(f"output path overlaps package source: {output_path}")
        if output_path.is_relative_to(root) and output_path not in canonical_outputs:
            raise ValueError(f"custom output must be outside package root: {output_path}")
        if not output_path.parent.is_dir():
            raise ValueError(f"package output parent must be an existing directory: {output_path.parent}")


def _directory_identity(status: os.stat_result) -> tuple[int, int, int]:
    return status.st_dev, status.st_ino, stat.S_IFMT(status.st_mode)


def _open_directory_nofollow(path: Path) -> int:
    if not path.is_absolute():
        raise ValueError(f"directory path must be absolute: {path}")
    descriptor = os.open(path.anchor, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _open_output_target(path: Path) -> OutputTarget:
    try:
        parent_fd = _open_directory_nofollow(path.parent)
    except OSError as exc:
        if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise ValueError(f"package output path must not contain symlinks: {path}") from exc
        raise
    return OutputTarget(path, parent_fd, _directory_identity(os.fstat(parent_fd)))


def _read_output(target: OutputTarget) -> tuple[bytes, int] | None:
    try:
        descriptor = os.open(target.name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=target.parent_fd)
    except FileNotFoundError:
        return None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ValueError(f"package output must not be a symlink: {target.path}") from exc
        raise
    try:
        status = os.fstat(descriptor)
        if not stat.S_ISREG(status.st_mode):
            raise ValueError(f"package output must be a regular file: {target.path}")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            return handle.read(), stat.S_IMODE(status.st_mode)
    finally:
        os.close(descriptor)


def _stage_bytes(target: OutputTarget, content: bytes, mode: int) -> str:
    while True:
        name = f".{target.name}.{secrets.token_hex(8)}"
        try:
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode, dir_fd=target.parent_fd)
            break
        except FileExistsError:
            continue
    try:
        os.fchmod(descriptor, mode)
        handle = os.fdopen(descriptor, "wb")
        descriptor = -1
        with handle:
            handle.write(content)
        return name
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        os.unlink(name, dir_fd=target.parent_fd)
        raise


def _verify_output_parent(target: OutputTarget) -> None:
    try:
        current = target.path.parent.stat()
    except FileNotFoundError as exc:
        raise RuntimeError(f"package output parent changed during publication: {target.path.parent}") from exc
    if _directory_identity(current) != target.parent_identity:
        raise RuntimeError(f"package output parent changed during publication: {target.path.parent}")


def _publish_pair(
    manifest: bytes,
    manifest_path: Path,
    archive_bytes: bytes,
    archive_path: Path,
    *,
    validate_before_publish: Callable[[], None] | None = None,
) -> None:
    targets: list[OutputTarget] = []
    try:
        targets.append(_open_output_target(manifest_path))
        targets.append(_open_output_target(archive_path))
    except BaseException:
        for target in targets:
            os.close(target.parent_fd)
        raise
    contents = (manifest, archive_bytes)
    previous: list[tuple[bytes, int] | None] = []
    staged: list[str] = []
    backups: list[str | None] = []
    preserved_backup_indices: set[int] = set()
    locked_fds: list[int] = []
    try:
        parent_locks = {
            target.parent_identity: target.parent_fd
            for target in targets
        }
        for _, parent_fd in sorted(parent_locks.items()):
            fcntl.flock(parent_fd, fcntl.LOCK_EX)
            locked_fds.append(parent_fd)
        if validate_before_publish is not None:
            validate_before_publish()
        for target, content in zip(targets, contents, strict=True):
            old = _read_output(target)
            previous.append(old)
            staged.append(_stage_bytes(target, content, 0o644))
            backups.append(None if old is None else _stage_bytes(target, old[0], old[1]))
        for target in targets:
            _verify_output_parent(target)
        published: list[int] = []
        try:
            for index, target in enumerate(targets):
                os.replace(staged[index], target.name, src_dir_fd=target.parent_fd, dst_dir_fd=target.parent_fd)
                published.append(index)
            for target in targets:
                _verify_output_parent(target)
        except BaseException as publish_error:
            rollback_errors: list[str] = []
            for index in reversed(published):
                target = targets[index]
                backup = backups[index]
                try:
                    if backup is None:
                        os.unlink(target.name, dir_fd=target.parent_fd)
                    else:
                        os.replace(
                            backup,
                            target.name,
                            src_dir_fd=target.parent_fd,
                            dst_dir_fd=target.parent_fd,
                        )
                except BaseException as rollback_error:
                    if backup is not None:
                        preserved_backup_indices.add(index)
                    backup_path = target.path.parent / backup if backup is not None else None
                    rollback_errors.append(
                        f"could not restore {target.path}: {rollback_error}"
                        + (f"; previous artifact preserved at {backup_path}" if backup_path else "")
                    )
            for message in rollback_errors:
                publish_error.add_note(message)
            raise
    finally:
        active_error = sys.exception()
        cleanup_errors: list[BaseException] = []
        for index, target in enumerate(targets):
            for name in (
                staged[index] if index < len(staged) else None,
                backups[index]
                if index < len(backups) and index not in preserved_backup_indices
                else None,
            ):
                if name is not None:
                    try:
                        os.unlink(name, dir_fd=target.parent_fd)
                    except FileNotFoundError:
                        pass
                    except BaseException as cleanup_error:
                        cleanup_errors.append(cleanup_error)
        for parent_fd in reversed(locked_fds):
            try:
                fcntl.flock(parent_fd, fcntl.LOCK_UN)
            except BaseException as cleanup_error:
                cleanup_errors.append(cleanup_error)
        for target in targets:
            try:
                os.close(target.parent_fd)
            except BaseException as cleanup_error:
                cleanup_errors.append(cleanup_error)
        if cleanup_errors:
            if active_error is not None:
                for cleanup_error in cleanup_errors:
                    active_error.add_note(f"package publication cleanup failed: {cleanup_error}")
            else:
                primary_cleanup_error = cleanup_errors[0]
                for cleanup_error in cleanup_errors[1:]:
                    primary_cleanup_error.add_note(f"additional cleanup failure: {cleanup_error}")
                raise primary_cleanup_error


def _verify_root_generation(root: Path, expected: tuple[int, int, int]) -> None:
    try:
        current = root.stat()
    except FileNotFoundError as exc:
        raise RuntimeError(f"package source root changed during generation: {root}") from exc
    if _directory_identity(current) != expected:
        raise RuntimeError(f"package source root changed during generation: {root}")


def build_package(root: Path = ROOT, *, manifest_path: Path | None = None,
                  archive_path: Path | None = None) -> tuple[Path, Path]:
    root = root.resolve()
    root_generation = _directory_identity(root.stat())
    manifest_path = _absolute_lexical(root / MANIFEST_NAME if manifest_path is None else manifest_path)
    archive_path = _absolute_lexical(root / ARCHIVE_NAME if archive_path is None else archive_path)
    entries = source_entries(root)
    _verify_root_generation(root, root_generation)
    _validate_outputs(root, manifest_path, archive_path, entries)
    sources = snapshot_sources(root, entries)
    _verify_root_generation(root, root_generation)
    if source_entries(root) != entries:
        raise RuntimeError("package source inventory changed while taking snapshot")
    _verify_root_generation(root, root_generation)
    verify_source_snapshot(root, sources)
    _verify_root_generation(root, root_generation)
    manifest = render_manifest(sources)
    with tempfile.TemporaryDirectory(prefix=".vdd-package-") as temporary:
        staged_archive = Path(temporary) / ARCHIVE_NAME
        write_archive(staged_archive, manifest, sources)
        archive_bytes = staged_archive.read_bytes()
    _verify_root_generation(root, root_generation)

    def validate_snapshot_before_publish() -> None:
        _verify_root_generation(root, root_generation)
        if source_entries(root) != entries:
            raise RuntimeError("package source inventory changed before publication")
        verify_source_snapshot(root, sources)
        _verify_root_generation(root, root_generation)

    _publish_pair(
        manifest,
        manifest_path,
        archive_bytes,
        archive_path,
        validate_before_publish=validate_snapshot_before_publish,
    )
    return manifest_path, archive_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    manifest, archive = build_package(args.root, manifest_path=args.manifest, archive_path=args.archive)
    print(f"Wrote {manifest}")
    print(f"Wrote {archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
