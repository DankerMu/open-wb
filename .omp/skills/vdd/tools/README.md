# Reference tools

## `vdd_lint.py`

A zero-dependency semantic linter for the VDD 0.4 JSON Contract and Evidence formats.
Its CLI applies the corresponding Draft 2020-12 JSON Schema before semantic validation.
It checks protocol structure and selected invariants, including:

- canonical Contract revision/content fingerprint binding;
- mode/risk and mode-specific baseline/gate evidence;
- Intent Validation status;
- reciprocal Claim/Defeater/Oracle links;
- fresh versus reused Oracle qualification and risk-relevant discrimination;
- fixture, environment, test-discovery, shard, and skip identity;
- Critical single-host platform binding and external multi-platform attestation digests;
- command result consistency and Claim/Defeater evidence references;
- protected candidate capabilities and independent acceptance;
- residual-risk stage/owner/expiry records;
- merge/release stage compatibility and parent attestation binding.

```bash
python tools/vdd_lint.py contract examples/light-construction/contract.json
python tools/vdd_lint.py evidence examples/light-construction/evidence.json \
  --contract examples/light-construction/contract.json
```

Exit codes: `0` means no lint errors, `1` means the artifact violates the protocol,
and `2` means a file/JSON/CLI error.

## `package_vdd.py`

The package generator derives the closed source inventory, its SHA-256 manifest, and the
`vdd-0.4.0.zip` archive from the same tree. It excludes only manifest/archive projections
and transient local files such as `__pycache__`, `.pyc`, and `.DS_Store`; symlinks, special
files, unsafe names, symlinked path components, inventory drift, and unsupported mode bits
are rejected. Sources are read once through a pinned, no-follow root descriptor; that immutable
snapshot feeds both outputs. Archive entries are sorted and use a fixed timestamp, deflate
settings, Unix file type, and source mode so regeneration is byte-reproducible. Publication
locks the pinned destination parents, stages each artifact on its destination filesystem,
and restores the previous pair if either replacement fails. A failed rollback preserves any
unapplied backup for recovery. Custom output parents must already exist outside the package
root; intermediate archive construction does not require source-parent write access.

```bash
python tools/package_vdd.py
```

Run it after every package-source change, then run `python -m unittest tests.test_package`
and `shasum -a 256 -c MANIFEST.sha256`.

## `vdd_accept.py`

A minimal acceptance control-plane reference. `issue`:

1. validates the Contract against Draft 2020-12 Schema plus semantic rules, validates
   every fixed shell-free argv plan step, and derives the actual allowlisted environment
   and command-executable identity before execution;
2. verifies full candidate/protected/output workspace scope coverage;
3. copies a point-in-time workspace through a pinned root descriptor without following
   source symlink ancestors, rejects special files and any copied
   content/type/mode/directory manifest that differs from preflight, and remaps
   source-workspace argv and environment paths into the snapshot;
4. runs every step in a network-denied `sandbox-exec`/`bwrap` boundary with protected
   inputs read-only, dedicated outputs writable, and bounded lifetime. Linux uses a PID
   namespace for complete descendant containment. The macOS reference denies
   `process-fork`; plans that require child processes must use Linux or another governed
   control plane because `sandbox-exec` cannot contain detached descendants race-free;
5. when `--output-directory` is supplied, reserves an absent final root, writes each
   bounded stdout/stderr stream and the actual sandbox policy to a private sibling staging
   directory, then atomically publishes that directory only after Evidence validation and
   signing. Failed issuance removes its staging directory and leaves the requested root
   absent; an existing final root is never overwritten. The signed Evidence records safe
   digest-derived paths, raw-byte digests, lengths, and file identities; `verify` requires
   the verifier to supply that same control-plane-owned `--output-directory`, re-reads all
   retained material through no-follow paths, and rejects drift;
6. when the Contract declares `source_provenance`, requires `--source-workspace`, pins that
   checkout generation, verifies its raw local origin URL, immutable commit, and rooted
   worktree directly against the Git tree without invoking repository filters or trusting
   status/index shortcuts. Git commands use a trusted system executable path selected at
   control-plane startup, recheck its complete filesystem identity before launch and before
   accepting output, have bounded output
   and deadlines, use literal paths, and ignore replacement refs. Each
   candidate record binds separate accepted-candidate and materialized-source fingerprints
   to the same Git blob/type/executable bit. The control
   plane repeats that check before signing and rejects source or output/attestation paths
   that overlap the source checkout;
7. requires each structured discovery/metric/cutover/release result to name a protected
   producer, captures it at that producer step, and seals it against later replacement;
8. accepts fresh known-bad rejection only with its Contract-owned semantic failure
   signal and derives stability from dedicated post-restoration records;
9. resolves signed reused qualification only when Oracle, fixture/corpus, environment,
   trial, and Defeater identities still match;
10. derives candidate revision from copied artifact identity and discards
   proposal-supplied metric, cutover, rollback, and release facts;
11. resolves and verifies a release-parent attestation when required;
12. validates the assembled Evidence against Draft 2020-12 Schema and `vdd_lint.py`
    before recording the canonical digest and HMAC signature.

The CLI transport accepts only regular, directly addressed input/key files: symlink leaves
or non-system symlink ancestors are rejected. JSON inputs are capped at 8 MiB and signing
keys at 1 MiB. The Python API accepts already-parsed objects and therefore has no JSON-file
transport limit.

The hardened `vdd-evidence-0.4` source-provenance record requires
`candidate_artifacts[].source_fingerprint`. Attestations produced by earlier development
builds without that field cannot prove the materialized checkout identity and must be
reissued; verification intentionally fails closed instead of silently upgrading them.

```bash
python tools/vdd_accept.py issue \
  --contract contract.json \
  --proposal evidence-proposal.json \
  --workspace /clean/checkout \
  --source-workspace /clean/pinned-upstream-checkout \
  --output-directory /control-plane/retained-evidence \
  --qualification-attestation prior-qualification.json \
  --parent-attestation accepted-merge.json \
  --key-file /control-plane/signing.key \
  --run-id ci-123 \
  --output attestation.json

python tools/vdd_accept.py verify \
  --contract contract.json \
  --attestation attestation.json \
  --source-workspace /clean/pinned-upstream-checkout \
  --output-directory /control-plane/retained-evidence \
  --qualification-attestation prior-qualification.json \
  --parent-attestation accepted-merge.json \
  --key-file /control-plane/signing.key \
  --as-of 2026-07-15T12:00:00Z
```

Supply the qualification and parent options only when the Contract uses reused Oracle
qualification or the attestation is at release stage. Verification resolves those
artifacts again; a signed link record alone is not treated as a re-verifiable chain.
`verify` rejects accepted residual risks that have expired at verification time.
`--as-of` is intended for reproducible historical verification; omit it to use the
current UTC time.

The reference HMAC mechanism demonstrates provenance and tamper detection. It is not a
production trust boundary unless key access, workspace isolation, protected assets, and
issuer authority are enforced by CI/KMS or an equivalent control plane.

Neither tool executes arbitrary project policy beyond the declared acceptance plan or
proves software correct. Project-specific behavioral Oracles remain mandatory.
