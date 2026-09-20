## ADDED Requirements

### Requirement: 审计只读端点
`registerAccounts(app,{db})` SHALL register GET /api/audit behind the existing cookie guard, call canonical core/audit.query with the guard-bound principal and parsed limit/before, and return200 `{events:[...]}`. Responses SHALL carry Cache-Control:no-store, including guard401, invalid-query400 and unexpected500. The route SHALL preserve core actor filtering, exact-admin visibility, id order, JSON representation and cursor precision. It SHALL NOT accept authorization identity from query parameters or append/update/delete audit rows. Production app assembly remains a separate task.

#### Scenario: 成员与管理员读取
- WHEN real authenticated u1 and admin u3 query interleaved u1/u2 events with limit/before
- THEN u1 sees only its events, u3 sees all, pages preserve id DESC without duplicates, response body is exactly an events array and header is no-store

#### Scenario: 参数错误与认证优先级
- WHEN an authenticated request supplies limit0/201/1.5, beforeabc/0/-1, an empty value or repeated limit/before
- THEN it returns400 canonical bad_request without altering audit rows and with no-store
- WHEN a request without valid login supplies even invalid query parameters
- THEN guard returns401 before query processing, with no-store and no audit data

#### Scenario: 原始游标与服务端故障
- WHEN a valid canonical huge before string exceeds signed64 on ordinary stored rows
- THEN query returns200 with the correct visible rows without cursor rounding/rejection
- WHEN before='9007199254740993' includes stored audit id9007199254740992, or a real audit SELECT fails
- THEN native query failure remains generic500 with no-store and no internal detail, never bad_request or a fabricated empty/safe-only200
