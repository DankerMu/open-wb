## ADDED Requirements

### Requirement: 公共错误类型归属 core
The canonical HttpError class, error codes and messages SHALL reside in core/errors and SHALL be usable by core modules without importing http or feature modules. HTTP status codes, content-parser ownership and reply mapping SHALL remain in http. Existing callers SHALL migrate atomically to the sole core export; http SHALL NOT retain compatibility class/type re-exports. Existing name/code/message identity, five-code HTTP status/envelope/no-store behavior and generic failure handling SHALL remain unchanged.

#### Scenario: 核心错误贯穿既有信封
- WHEN core emits an existing typed application error and HTTP maps it
- THEN the mapper recognizes the canonical constructor and preserves its existing status, exact message/envelope and no-store response; plain forged code/status objects remain generic server errors

#### Scenario: 分层无旧导出
- WHEN application, guards and existing tests use the shared error API after cutover
- THEN all use core/errors directly, with no duplicate error implementation or reverse core dependency, and existing HTTP regression suites pass
