# Design

## Context
Baseline99056cf has #105 native omp, fake upstream, three-file Make recipe and process-group lifecycle guardrails. Canonical verification spec still awaits #105 selective archival, so this delta starts from the merged upstream child requirement and preserves all its scenarios; archive rechecks current canonical to avoid overwriting concurrent promotion.
Governing invariant: every smoke run actually exercises the workspace owned by the current account, rejects traversal with fresh correlated audit, returns tracked preview bytes and refuses the other account; tolerated creation conflicts never bypass later assertions.
Sibling surfaces: tracked fixture → caller/job sandbox → workspace adoption/list capture → tree/preview/audit/auth → Hurl; Make exact argv → shared CI helper → both workflow jobs → source-derived/runtime oracle.

## Goals / Non-Goals
One harness slice, no product behavior change. No browser journey additions (#133), AGENTS/control-plane expansion (#135), uid job (#132), real model credentials or upstream dependency beyond existing controlled fake.
Retain raw Make export, PATH-only env, serial Hurl/global retry0, exact chat text/min_bash_steps1, smoke-live unchanged, pinned tools, readiness/PGID/cleanup behavior and failure precedence.

## Decisions
- Canonical tracked Markdown header, CSV header+two rows, decodable tiny PNG; expected text bytes read from tracked files using existing Hurl fixture conventions.
- Start files.hurl from a new cookie store. POST workspace and initial mkdir accept only201/409; derive workspace ID from the following list filtered by name, never from conflict body. Deliberate duplicate mkdir must409 conflict.
- Check all three file entries, snapshot latest owner audit state before traversal query403 sandbox_denied, then require newest owner audit to be new and match kind/workspace/relPath/op. Query data must reach server unchanged. Preview md exactbytes/text+nosniff, png image/png, csv200; logout both zhangsan u1 and lisi u3 after foreign404. No live auth sessions remain.
- Add fixture mkdir/copy in existing shared compiled-server helper before any process launch. Both mode paths inherit it. Destination is caller-supplied job-owned SANDBOX_ROOT; preserve existing extra workspace entries rather than deleting trees. Copy failure exits before service starts.
- No workflow action/job-count change needed if shared helper serves both jobs; retain workflow shape checks and add exact provisioning/order mutations plus runtime mode proof. No parallel provisioning implementation.

## Risks / Trade-offs
201/409 can conceal a failed creator → exact later list/capture/tree/duplicate assertions and same-state replay.
Old identical audit can make a false green on rerun → compare pre/post audit state as well as workspace/path/op; qualify by retaining old rejection while suppressing only the new event. No timing sleep or timestamp-resolution assumption.
Fixture copy may silently be removed or moved after launch → guardrail negative controls; real smoke proves API-visible files.
Global smoke must still run chat → preserve all three older files/vars/ordering and use pinned real omp, not fake-omp substitution.

## Migration Plan
Fixture review/strict validation; implement one atomic slice; Main runs real service via supervised processes with fresh job-owned data, two complete smoke runs without restart/reseed, standalone files smoke, fault controls and guardrails. Frozen expanded review then exact-head CI and automatic merge. Selectively archive only this child, preserving upstream scenarios and leaving parents active.
Rollback is whole PR revert; no partial fixture/Make/CI split. Parent global reconciliation debt is not repaired or hidden here.
