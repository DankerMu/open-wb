"""The approval-envelope schema resolver.

The resolver is ambient by design — Missions is being restructured, so its location is an
input. That makes each of these behaviours load-bearing rather than incidental: a wrong-
generation schema must be refused rather than silently used, the env override must not be a
way around that refusal, and the search must stay inside the repository.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import build_missions_v4_pack as producer  # noqa: E402

# The resolver these tests pin cannot be committed until Missions' in-flight rename lands, and
# committing tests ahead of it made a clean checkout red for anyone cloning. Skip rather than
# fail when the producer predates it: a missing feature is not a broken build.
#
# Keyed on the entry point alone. An earlier version required five internal names, so renaming
# any one of them would have silently disabled all of these — including the wrong-generation
# refusal this file calls load-bearing — and it still omitted PackRequestError, which three
# tests use. Delete this guard when the resolver lands.
RESOLVER_PRESENT = hasattr(producer, "missions_approval_envelope_schema")


def write_schema(directory: Path, name: str, pinned: str | None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    document: dict = {"type": "object"}
    if pinned is not None:
        document["properties"] = {"schemaVersion": {"const": pinned}}
    path = directory / name
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


@unittest.skipUnless(
    RESOLVER_PRESENT, "producer predates the envelope-schema resolver this pins"
)
class EnvelopeSchemaResolverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous = os.environ.pop(producer.MISSIONS_ENVELOPE_SCHEMA_ENV, None)
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()
        if self.previous is not None:
            os.environ[producer.MISSIONS_ENVELOPE_SCHEMA_ENV] = self.previous
        else:
            os.environ.pop(producer.MISSIONS_ENVELOPE_SCHEMA_ENV, None)

    def test_override_accepts_a_schema_pinning_the_emitted_version(self) -> None:
        path = write_schema(self.root, "envelope.json", producer.APPROVAL_ENVELOPE_SCHEMA_VERSION)
        os.environ[producer.MISSIONS_ENVELOPE_SCHEMA_ENV] = str(path)
        self.assertEqual(path, producer.missions_approval_envelope_schema())

    def test_override_refuses_a_schema_pinning_another_generation(self) -> None:
        # The escape hatch is for location, not for contract: an override that pins a different
        # version must fail loudly rather than pair a new envelope with an old schema.
        path = write_schema(self.root, "envelope.json", "missions.v4.approval.v1")
        os.environ[producer.MISSIONS_ENVELOPE_SCHEMA_ENV] = str(path)
        with self.assertRaises(producer.PackRequestError) as caught:
            producer.missions_approval_envelope_schema()
        self.assertIn("missions.v4.approval.v1", str(caught.exception))
        self.assertIn(producer.APPROVAL_ENVELOPE_SCHEMA_VERSION, str(caught.exception))

    def test_override_refuses_a_missing_file(self) -> None:
        os.environ[producer.MISSIONS_ENVELOPE_SCHEMA_ENV] = str(self.root / "absent.json")
        with self.assertRaises(producer.PackRequestError) as caught:
            producer.missions_approval_envelope_schema()
        self.assertIn("not a file", str(caught.exception))

    def test_pinned_version_reads_the_const_and_tolerates_junk(self) -> None:
        pinned = write_schema(self.root, "pinned.json", "missions.approval.v1")
        self.assertEqual("missions.approval.v1", producer.schema_pinned_version(pinned))

        unpinned = write_schema(self.root, "unpinned.json", None)
        self.assertIsNone(producer.schema_pinned_version(unpinned))

        malformed = self.root / "malformed.json"
        malformed.write_text("{not json", encoding="utf-8")
        self.assertIsNone(producer.schema_pinned_version(malformed))

    def test_discovery_finds_a_schema_pinning_the_emitted_version(self) -> None:
        # The discovery loop — candidate roots, glob, version match — is the production path,
        # and every other test here goes through the override instead. Deleting the version
        # gate inside that loop used to leave the whole suite green.
        root = self.root / "skills" / "missions"
        write_schema(root / "schemas", "approval-envelope.schema.json",
                     producer.APPROVAL_ENVELOPE_SCHEMA_VERSION)
        with self.candidate_roots([root]):
            self.assertEqual(
                root / "schemas" / "approval-envelope.schema.json",
                producer.missions_approval_envelope_schema(),
            )

    def test_discovery_refuses_a_candidate_pinning_another_generation(self) -> None:
        root = self.root / "skills" / "missions"
        write_schema(root / "schemas", "approval-envelope.v4.schema.json",
                     "missions.v4.approval.v1")
        with self.candidate_roots([root]):
            with self.assertRaises(producer.PackRequestError) as caught:
                producer.missions_approval_envelope_schema()
        message = str(caught.exception)
        self.assertIn("missions.v4.approval.v1", message)
        self.assertIn(producer.APPROVAL_ENVELOPE_SCHEMA_VERSION, message)

    def test_discovery_prefers_the_matching_generation_over_a_mismatched_one(self) -> None:
        root = self.root / "skills" / "missions"
        write_schema(root / "schemas", "approval-envelope.aaa.schema.json",
                     "missions.v4.approval.v1")
        write_schema(root / "schemas", "approval-envelope.schema.json",
                     producer.APPROVAL_ENVELOPE_SCHEMA_VERSION)
        with self.candidate_roots([root]):
            # Sorted order puts the mismatched file first; the contract, not the name, decides.
            self.assertEqual(
                root / "schemas" / "approval-envelope.schema.json",
                producer.missions_approval_envelope_schema(),
            )

    @contextlib.contextmanager
    def candidate_roots(self, roots: list[Path]):
        original = producer.missions_root_candidates
        producer.missions_root_candidates = lambda: iter(roots)
        try:
            yield
        finally:
            producer.missions_root_candidates = original

    def test_candidate_roots_stay_inside_the_repository(self) -> None:
        repository_root = producer.ROOT.parents[1]
        candidates = list(producer.missions_root_candidates())
        self.assertTrue(candidates)
        for candidate in candidates:
            self.assertTrue(
                repository_root == candidate.parent or repository_root in candidate.parents,
                f"{candidate} escapes {repository_root}",
            )
        # Unrelated scaffolding named `missions` inside another skill must not be a candidate.
        # An earlier recursive glob matched `skills/<other-skill>/.agents/missions`, so the
        # property to hold is that the only candidate under the skills directory is a sibling
        # of this skill, never something nested deeper.
        skills_root = producer.ROOT.parent
        nested = [
            path
            for path in candidates
            if skills_root in path.parents and path.parent != skills_root
        ]
        self.assertFalse(nested, f"candidate search reached nested scaffolding: {nested}")


if __name__ == "__main__":
    unittest.main()
