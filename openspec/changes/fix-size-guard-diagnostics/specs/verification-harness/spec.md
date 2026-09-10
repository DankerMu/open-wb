## ADDED Requirements
### Requirement: Locale-independent oversized-file diagnostics
The size guard SHALL retain the 800-line limit and nonzero rejection while reporting one BLOCK line with the actual count and path for every oversized supported file, independent of C or UTF-8 locale. Guard self-verification SHALL reject missing diagnostics even if the command exits nonzero.
#### Scenario: Multiple violations under macOS locales
- **WHEN** Bash 3.2 or 5.x checks two supported files with 801 and 802 lines under C.UTF-8, en_US.UTF-8, zh_CN.UTF-8 or C
- **THEN** each file has its own BLOCK line with its count and path, exit is nonzero and stderr has no unbound variable error
#### Scenario: Valid boundary and diagnostic regression
- **WHEN** the guard checks an 800-line file, or self-verification sees a failing guard with missing count/path diagnostics
- **THEN** the valid file exits zero and the broken diagnostic oracle fails rather than accepting arbitrary nonzero status
