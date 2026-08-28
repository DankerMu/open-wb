# Migration Failure Routing

Preserve the exact counterexample, candidate snapshot, artifact digests, environment and command
result before changing anything. A repeated symptom is not automatically a local repair.

A failure on the candidate is not yet a classified defect. Before routing, run the same check
against the immutable reference: reference-fails-too means the behavior is inherited — classify
it as accepted or corrected, never count it as a port regression; reference-passes means a
candidate regression or an environment difference. Never classify from the candidate's output
alone.

| Signal | Owner and next action | Evidence impact |
|---|---|---|
| One unit fails its public behavior check | Bounded unit repair via TDD/diagnosis. | Reopen only the unit; rerun its gates. |
| Same mapping/delta fails repeatedly | Route-artifact owner (rulebook / delta catalog / behavior catalog) or playbook owner amends upstream between Missions. | New revision invalidates dependent evidence; run pilot/affected scope. |
| Same rulebook/catalog section amended twice for one cause | Stop wording attempts; the Contract Owner decides the policy. | A third rewording without an owner decision is invalid; affected slices stay open. |
| Inventory omits/duplicates a source unit | Inventory owner and protected scanner. Enter `INVENTORY_DISPUTE`. | Regenerate inventory; invalidate dependent plans/closure. |
| Dependency edge/cycle is wrong | Graph owner decides and revises graph. | Recompute affected readiness; revoke stale external assignments. |
| Legacy behavior conflicts with intent | Contract Owner via VDD `SPEC_DISPUTE`. | Revise behavior classification/contract; requalify affected oracle. |
| Judge misses a plausible deviation or false-rejects | Verifier Owner. | New oracle identity, qualification, and affected gate reruns. |
| Most or all checks fail at once | Suspect the judge first; Verifier Owner requalifies the judge/harness. | No candidate blame is assigned until the judge passes known-good again. |
| Candidate result arrives after retry/generation change | Missions/runtime owns rejection under fencing token. | Do not integrate or attest the stale result. |
| Build/integration failure spans multiple patches | Integration owner isolates deterministically before assigning blame. | Preserve batch snapshot; reopen a diagnosable scope. |
| Wave batch trips the circuit breaker | Stop the wave per workflow G4; queue amendments, re-verify on one failed unit, then resume. | Trip evidence preserved; units reported as remaining/failed/blocked re-passable lists. |
| Cutover leaves a legacy production dependency | Cutover owner. | Completion is insufficient; cutover remains blocked. |
| Release threshold/canary fails | Release Owner. | Release remains blocked; execute declared containment/rollback path. |

Never solve any row by weakening test discovery, ignoring exit status, silently accepting a
legacy fallback, editing a protected oracle, or treating a current queue projection as the
source of truth.
