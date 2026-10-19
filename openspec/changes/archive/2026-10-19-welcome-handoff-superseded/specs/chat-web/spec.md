# Spec Delta

## ADDED Requirements

### Requirement: 欢迎态交接不被后续导航打断
When a welcome-state first send has created its session, the page SHALL commit its own navigation to `?session=<id>` synchronously, so that no later navigation (a history back, a replace or push by the page or the user, an address-bar change handled by the router) can be merged with it into one render. When the send has nothing left to upload at that point (no attachment tag still `待上传`) and a non-empty message or at least one sendable attachment, the page SHALL therefore issue the prompt request for the created session exactly once — never zero times, never twice — whatever navigation follows (a navigation away while that request is still in flight invalidates its continuation as for any user-initiated navigation, as 「会话页」 already specifies), and after a following navigation back to the welcome state the composer SHALL accept a new send (`发送`, no `停止`). Selecting that session afterwards SHALL NOT send its prompt again. When the send still waits for attachment uploads (message-attachments), a navigation away before the uploads finish cancels the send under the existing 「会话页」 rule: no prompt request is issued, the created session stays empty, and the welcome composer accepts a new send. While the create request is still in flight, the welcome-state composer keeps its locked `停止` state as before. The page's other navigations keep their existing commit behaviour.

#### Scenario: Replace right after the create returns
- **WHEN** a welcome-state send of `你好` creates session `D`, and in the same batch of work, right after the create resolves, the location is replaced with `/`
- **THEN** the URL is `/`, exactly one prompt request `你好` has been issued to `D`, the composer shows `发送` and no `停止`; a following send of `再来` creates session `E` and sends exactly one prompt to it, and no further prompt is sent to `D`

#### Scenario: History back right after the create returns
- **WHEN** a welcome-state send of `你好` creates session `D`, and right after the create resolves the user goes back in history to `/`
- **THEN** the outcome is the same as for the replace: URL `/`, exactly one prompt to `D`, `发送` available, and a following send creates `E` with exactly one prompt

#### Scenario: The created session is not prompted again
- **WHEN** after either of the above the user selects `D` from the session list
- **THEN** no prompt is sent; `D` still has received exactly one prompt in total
