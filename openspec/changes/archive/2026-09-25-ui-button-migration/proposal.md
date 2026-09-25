## Why
#348 — S1e 1.2 (#276) landed the `Button` primitive (`web/src/ui/button.tsx`, `.ui-btn--*` in `web/src/ui/button.css`) but the spec deliberately left legacy `.ui-button*` classes untouched "until a migration slice" (`openspec/specs/ui-primitives/spec.md:16`), and no slice was ever assigned. Six call sites still hand-write `<button className="ui-button…">` on master, bypassing the Button variant/size/loading/focus-visible contract:
- `web/src/features/chat/conversation-view.tsx:181` `新建会话` (`ui-button ui-button-primary chat-new-session`)
- `web/src/features/files/preview.tsx:198` `查看源码`/`渲染视图` (`ui-button`)
- `web/src/features/files/page.tsx:150` switcher `＋ 新建工作空间` (`ui-button`)
- `web/src/features/files/dialogs.tsx:46` `CreationMenu` trigger `＋` (`aria-label="新建"`, `ref={triggerRef}`, passed as `Menu` `trigger`)
- `web/src/features/files/dialogs.tsx:76` dialog `取消`; `:79` dialog `创建` (`type="submit"`, `disabled={pending}`)
Legacy rules: `web/src/styles.css:120-158` (`.ui-button`, hover, `-primary`, `-danger` — the last has no caller). #302 (the declared dependency) is merged. #301 demo-parity sign-off would otherwise list non-primitive buttons.

## Triage
Issue type: refactor
Fixture level: compact
Upstream suggested level: absent (compact: presentation-only class migration inside web features; no API/schema/route/storage change)
Blast radius: button look and behavior on chat sidebar, files switcher/menu/dialogs/preview; a broken ref would break Menu trigger focus return; a wrong `type` would break dialog submit.
Selected risk packs: Legacy compatibility — internal call sites only, no outside consumer of `.ui-button*` (git grep: none in web/e2e, web/test, feature css) — (accessible names, behavior, `type`, `disabled`, ref/focus return, `chat-new-session` width); Documentation (spec clause superseded by an ADDED requirement).
Evidence floor: `grep -rn "ui-button" web/src` empty; new guardrail test with injected-sample self-proof; existing chat/files jsdom suites green without assertion changes; `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift`, `npm run build --workspace web` exit 0. `make ui-walk` is covered by CI (role/name locators).
design.md omitted (compact).

## What Changes
- Replace the six call sites with `Button` imported from `web/src/ui` (`../../ui` per existing feature imports): `ui-button ui-button-primary` → `variant="primary"`; `ui-button` → default `variant="secondary"`; size stays default `md`. Keep every other prop (`onClick`, `aria-label`, `ref`, `type="submit"`, `disabled`). `新建会话` keeps `className="chat-new-session"`.
- `dialogs.tsx:46` trigger: `ref` passes through `...rest` (React 19 ref-as-prop; `ButtonProps` extends `ComponentProps<"button">`); the Menu trigger must still open the menu and receive focus back on close.
- Delete the `.ui-button*` rule blocks from `web/src/styles.css`.
- `web/test/ui-guardrails.test.ts`: new case scanning `web/src` `.ts/.tsx/.css` for `ui-button` (word-boundary so `ui-btn` never matches), zero hits; plus a self-proof case where the same matcher hits an injected sample exactly once and does not hit `ui-btn`.

Must preserve: accessible names and roles of all six buttons; `创建` still `type="submit"` and disabled while pending; `取消`/`创建` behavior; Menu open/close and focus return to `新建`; switcher `＋ 新建工作空间` closes the popover and opens the dialog with focus return; `查看源码`/`渲染视图` toggling; `新建会话` full sidebar width; existing test assertions unchanged. Out of scope: `.ui-alert`/`.ui-muted`/`.ui-empty`; button copy/layout alignment with demo; any `web/src/ui` primitive change.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `ui-primitives`: ADDED requirement that `Button` is the only button styling in `web/src` and the legacy `.ui-button*` classes are retired (supersedes the `.ui-button*` part of the "既有类…迁移切片前不动" clause in 基元组件库; that 27 KB requirement is not copied as MODIFIED to avoid drift with the active S1e parent change).

## Impact
`web/src/features/chat/conversation-view.tsx`, `web/src/features/files/{preview,page,dialogs}.tsx`, `web/src/styles.css`, `web/test/ui-guardrails.test.ts`. No server, API or CI change.
