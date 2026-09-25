## Risk Packs
- Legacy compatibility — selected: accessible names, `type="submit"`, `disabled={pending}`, Menu trigger `ref` and focus return, popover-close-then-dialog flow, `chat-new-session` width → 1.1–1.4, 2.2, 2.3.
- Documentation / migration notes — selected: spec 基元组件库 `.ui-button*` transition clause superseded by the ADDED requirement → spec delta; no user docs affected.
- Public API, Config, Schema, File IO/path safety, Auth/secrets, Concurrency, Resource limits, Error handling, Release — not selected: presentation-only class migration inside web features, no API/storage/route change.

## 1. Implementation
- [x] 1.1 `chat/conversation-view.tsx:181` `新建会话` → `<Button variant="primary" className="chat-new-session" onClick={onCreateSession}>`.
- [x] 1.2 `files/preview.tsx:198` and `files/page.tsx:150` → `<Button>` (secondary), handlers unchanged.
- [x] 1.3 `files/dialogs.tsx:46` Menu trigger → `<Button aria-label="新建" ref={triggerRef}>＋</Button>`; `:76` `取消` → `<Button onClick={onCancel}>`; `:79` `创建` → `<Button variant="primary" type="submit" disabled={pending}>`.
- [x] 1.4 Delete `.ui-button*` rule blocks from `web/src/styles.css` (including dead `.ui-button-danger`).
- [x] 1.5 `web/test/ui-guardrails.test.ts`: repo scan case (zero hits in `web/src` `.ts/.tsx/.css`) and self-proof case (injected sample: 1 hit on the `ui-button` line, 0 on a `ui-btn` line), reusing `listRepoFiles`/`lineHits` (the `ui-btn` non-hit is a sanity line only; evidence is the exact-1-hit sample plus 2.4).

## 2. Verification
- [x] 2.1 `grep -rn "ui-button" web/src` → no output.
- [x] 2.2 Existing suites unchanged and green: chat-page*, files-page*, files-overlays, files-* dialog/preview tests (`cd web && npx vitest run test/chat-page test/files test/preview test/ui-menu`), including Menu open/close focus return to `新建` and switcher → `新建工作空间` focus flow.
- [x] 2.3 A jsdom className assertion for each of the six migrated buttons that its className is `ui-btn ui-btn--<variant> ui-btn--md` (plus `chat-new-session` on `新建会话`), added to an existing relevant test file; RED on pre-change source (class was `ui-button…`), GREEN after.
- [x] 2.4 Guard self-proof: temporarily reintroduce `className="ui-button"` in one feature file → repo-scan case RED; revert → GREEN.
- [x] 2.5 `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift`, `npm run build --workspace web` exit 0.
