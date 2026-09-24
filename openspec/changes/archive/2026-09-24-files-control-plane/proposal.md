## Why
#135 completes the final documentation mirror after#130/#133/#107 are closed. Runtime already has four-file HTTP smoke and files browser journey; Directory Map and HTTP evidence do not yet name sandbox fixtures/four files.
Issue type: test
Fixture level: none
Upstream suggested level: none (agree: documentation and isolated expected-text updates only; no shared harness execution/parser behavior change).
Blast radius: exact AGENTS wording mirrored by existing source-derived oracle.
Selected risk packs: documentation; legacy compatibility; verifier error handling.
Evidence floor: semantic updated-oracle RED on old wording, restored source baseline GREEN and negative controls, strictfixture, exactheadCI.
Design.md omitted at none; no runtime/UI/CIconfiguration trigger is introduced by literal-expectation edits.

## What Changes
Only AGENTS.md two lines and existing scripts/test-ci-harness.sh expected strings/mutation anchors.
Directory smoke line: `smoke/      Hurl HTTP 冒烟用例、对话链路、沙箱夹具与深链 exact-byte fixture`.
HTTP row: | HTTP smoke | Hurl（调用方拥有已运行服务） | `make smoke` | 退出码 0；public.hurl、auth.hurl、chat.hurl、files.hurl 四文件真实 HTTP 断言全绿 |
Existing server line already has sandbox/audit/workspace: preserve byte-for-byte. UI matrix row andallcommands/surfaces/enforcementremainunchanged. No fixedHTTPrequestcount.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- files-harness: control-plane/oracle synchronization requirement.
- verification-harness: additive files documentation requirement under complete currentCI contract.

## Impact
No parser/generalhelper/workflow/product/constraints/threshold/dependencychange. Preserve#134exactthree downgrades/UIDblock/peerheadingownership, ten surfaces, eightdirectjobs andalloldtests. Caller-owned service wording unchanged. No claim of productiondeployment or finaluseracceptance.
