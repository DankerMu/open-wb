## Context
Change surface: web/src/lib/api.ts and paired API tests; current five-code server registry is irrelevant to mock network-contract tests.
Existing canonical source: api.ts request/getRequestOptions/parseJsonResponse/ApiError; support.ts test helpers.
Must preserve: getMe/login/logout/getInfo contracts, same-origin credentials, GET no-store, optional signal, one 401 notification even malformed/non-JSON response; callback failure cannot replace ApiError.
Governing invariant: method arguments reach the intended same-origin endpoint without URL interpretation, successful preview metadata retains original server size, and errors cannot become successful preview data.
Sibling surfaces: auth/provider.tsx uses ApiClient; api.test.ts and api-info-logout.test.ts defend existing consumers; server wire contracts live in parent workspaces/audit-core specs; future files page owns preview lifetime.
## Goals / Non-Goals
Add six methods on the existing client. No server/error-registry changes, routes, UI rendering, auth-state redesign, new dependencies or alternative client implementation.
Return listWorkspaces as {workspaces:[{id,name,dir,root,createdAt}]}, createWorkspace as the direct workspace, listTree as {path,entries:[{name,type,size,mtime}]}, createDir as {path}, listAudit as {events:[{id,ts,actorId,kind,title,detail,workspaceId}]}.
Use numeric byte sizes and epoch-ms mtime/createdAt/ts; audit workspaceId is string|null and detail is the JSON object described by parent contract. Do not coerce or derive values from display strings.
## Decisions
Reuse existing request/error helpers and strict response-shape style rather than weakening existing parsers or casting unknown JSON.
Methods accept optional request options consistently with existing calls; listAudit optional filter {limit?:number,before?:string} serializes supplied values, leaves validation to server.
Encode workspaceId as one URL segment; encode path query exactly once, preserving literal ../, slashes, Unicode, spaces, percent, # and ? as data, not normalizing it client-side.
POST body selects only declared name/optional dir or path; absent dir omitted. GET requests remain no-store; all requests same-origin credentials.
Preview success is text/plain (optional charset) or image/png/image/jpeg. Return discriminated {kind:'text',text,size,truncated} or {kind:'image',url,size,truncated}; header X-Workbuddy-Size is required nonnegative safe integer, X-Workbuddy-Truncated === '1' means true (absence/other values false).
Read non-success responses through canonical error parser before any text/blob success path. Missing/invalid size, unexpected success content type, body-read/URL creation failure produce stable request_failed, without leaking response/transport details.
Create Blob URL only after successful image body and metadata; ownership transfers to caller on resolve. Caller MUST revoke on replacement/unmount; no hidden client cache, timer or revoke-before-use. AbortSignal follows existing request behavior; no retry or cancellation framework.
## Evidence and risks
Seam: public createApiClient plus real Response/Headers/Blob objects and mocked fetch. Assert all six request/response contracts, independent error status/code/message, 401 callback, encoded path roundtrip, original-size versus body-size divergence, text/image/empty body.
Known-bad qualification: temporary callable missing-behavior baseline yields semantic RED (not import/type failure); include a header-size-vs-body-size discriminating case and error-before-blob check. Preserve logs and restore real implementation before full GREEN.
Image oracle: inspect Blob given to URL.createObjectURL, prove exact bytes and MIME, return URL to caller and release in test cleanup; reject errors without allocating a URL. Parent runtime smoke exercises actual client with controlled fetch outside tests.
Risks: server endpoints not implemented yet -> contract mocks do not prove deployment; real HTTP/UI wiring belongs #127/#129/#133. Future caller disposal is an explicit consumer obligation, not a claim of page completion.
Review focus: exact URL/body binding; old auth behavior; malformed response/error precedence; original header sizes; URL ownership; no duplicated parser/client.
Rollback: revert this additive feature commit; no persistence migration.
Archive coordination: promote only API 客户端扩展; all other files-web requirements remain in parent change until their slices finish.
