# Analysis Guides (Phase 2 depth)

Detailed procedures for the analysis principles listed in SKILL.md Phase 2. Read the sections relevant to the change at hand.

## Reading project conventions (Phase 1b detail)

Check for project-specific context that shapes what "good" looks like. Many agents auto-load project instruction files into context — check what's already available before reading files redundantly.

- Project instruction files (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `copilot-instructions.md`, or similar) — may already be in context
- Linter/formatter configs (`.eslintrc`, `.prettierrc`, `pyproject.toml`) — if these exist, don't flag style issues they cover
- PR template or contributing guide — check if the PR follows the project's expected format
- Recent commit messages — understand the project's conventions

This context prevents generic feedback that ignores team decisions (e.g., flagging ORM usage when the project explicitly avoids ORMs).

## Cross-cutting concerns

Beyond the per-type checklists, always check these regardless of content type:

- **Code-doc consistency**: If code and docs changed in the same PR, do the docs reflect the new behavior?
- **Missing companions**: New API endpoint with no tests? New feature with no docs? Schema change with no migration?
- **Changelog**: User-facing changes should have a changelog entry (if the project uses one).

## Spec conformance (second axis)

When an originating spec was located (Phase 1e), check the diff against it as its own axis, separate from the checklists:

- **Missing or partial**: requirements the spec asks for that the change does not deliver
- **Unrequested**: behavior in the diff the spec never asked for — scope creep; flag it, don't assume it's wrong
- **Implemented but wrong**: requirements that look addressed but whose implementation contradicts the spec's wording

Quote the spec line for each finding. Spec findings carry severities like any other (a missing Must requirement is typically P1), but they report under their own group — see `output-formats.md`.

## Behavioral change analysis

Checklist-driven code review tends to focus on code-level patterns (injection, N+1, naming) and can miss *behavioral* changes — places where the system does something different than before, even if the code looks clean. This matters most in refactoring PRs where the intent is "same behavior, better structure." For any PR that modifies or replaces existing logic, explicitly check:

- **State model changes**: Did enums gain/lose variants? Did a 3-state machine become 2-state? This changes what the system can express.
- **Error handling changes**: Did error paths change from silent to throwing, or vice versa? Did catch-all branches (`_ => ...`, `default:`) change what they swallow?
- **Default value changes**: Did a field go from required to optional (or `String` to `Option<String>`)? Downstream consumers may break.
- **Timing/ordering changes**: Did synchronous calls become async? Did fire-and-forget become blocking (or vice versa)? These change backpressure and failure modes.
- **API contract changes**: Were CLI flags, environment variables, response shapes, or event types removed or renamed? These are breaking changes even if the code compiles.
- **Scope narrowing**: Did a function that previously handled N cases now only handle a subset? The dropped cases may fail silently.

When you find a behavioral change, assess whether it is **intentional** (documented in PR description) or **accidental** (a side effect of refactoring). Accidental behavioral changes are typically P1.

## Removal inventory (Deep mode)

For large refactoring PRs with significant deletions, briefly inventory what was removed and confirm clean removal:
- Are all references to deleted types/functions/modules also removed?
- Are there orphaned imports, dead config entries, or stale test helpers?
- Is the removal documented in the PR description or changelog?

This catches partial removals where a type is deleted but a consumer still references it at runtime via a string key or dynamic dispatch.

## Open questions

A good review doesn't just find problems — it also surfaces things the reviewer *can't determine from the diff alone*. After analyzing, note questions where the answer would change your assessment:

- Implementation details outside the diff that affect correctness (e.g., "The `with_command_meta` method isn't in this diff — does it already exist on main?")
- Design intent that isn't documented (e.g., "Is the `--apply` flag in `command_path` intentional per the envelope spec, or should it be normalized to `apply`?")
- Missing context about contracts, consumers, or deployment (e.g., "Are there schema-level contract tests validating these envelope fields?")

Use a question only when the missing answer would materially change severity, correctness, or whether something is a finding at all. Do not soften a clear bug, contract break, or migration risk into a question. These go in a dedicated "Questions" section in the output.

## Impact analysis (Deep mode only)

For changes to exported functions, public APIs, schemas, or shared interfaces:
1. Search the codebase for all callers/consumers of the changed interface
2. Identify if any consumer would break or behave differently
3. Check if migration scripts are needed and included
