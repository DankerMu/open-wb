# Spec Delta

## ADDED Requirements

### Requirement: 浏览器不执行被取代的自身上报回声
`WorkspaceBrowser` SHALL treat a new `path` value that equals one of its own earlier `onPathChange` reports, when a later report of its own has been made since (the host has not yet written that later one back), as a superseded echo: it SHALL record that value as applied and SHALL NOT clear the selection, cancel the in-flight preview, change the preview pane's notice, or start a walk because of it. When the value occurs more than once among the reports still waiting for their echo, its earliest occurrence decides. A `path` value equal only to the browser's most recent pending report, or one the browser never reported, SHALL be applied under the existing rules (「工作空间浏览器组件」). A `path` applied again because `pathSeq` changed, and the first `path` after mounting, SHALL always be applied under the existing rules, whatever the browser reported before. The sequence of `onPathChange` and `onSelectionChange` calls SHALL be unchanged except that a superseded echo no longer adds a cleared-then-reselected pair.

#### Scenario: A 404's echo arrives after the next click
- **WHEN** under `onlyPaths={"deep/x.md","deep/y.md"}` the user selects `deep/y.md` and the host writes it back; its `file` answers 404 and the browser reports `null`; before the host writes `null` back the user selects `deep/x.md`; then the host writes back `null`, and after that `deep/x.md`
- **THEN** `file?path=deep/x.md` is requested exactly once; `onPathChange` was called with `deep/y.md`, `null`, `deep/x.md` in that order; the reported actual selection went `deep/y.md`, `null`, `deep/x.md` and nothing after; `deep/x.md` stays selected throughout and its preview is shown

#### Scenario: A reveal's echo arrives after the next click
- **WHEN** `reveal("a.md")` lands on `a.md` and reports it; before the host writes it back the user selects `b.md`; then the host writes back `a.md`, and after that `b.md`
- **THEN** `b.md` stays selected throughout; `a.md` and `b.md` are each requested once; the reported actual selection does not change after `b.md`

#### Scenario: The host's own value is still applied
- **WHEN** reports of the browser are still waiting for their echo, and the host sends a `path` with a new `pathSeq` (even one equal to an earlier report), or a `path` the browser never reported
- **THEN** it is applied under the existing rules: `null` clears the selection, another file is walked to and selected
