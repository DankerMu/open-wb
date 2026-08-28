# Agentic interaction

Load this only for AI, Agent, Copilot, generative UI, conversational workflows, dynamic reports, or products where the system acts on the user's behalf.

## Experience loop

Design the full collaboration loop:

1. User expresses an outcome.
2. The system identifies known and missing context.
3. The Agent clarifies only what blocks safe progress.
4. Execution exposes the right level of status and evidence.
5. User confirms consequential decisions.
6. Result returns with evidence, uncertainty, and next actions.
7. User can correct, continue, retry, undo, or return to an earlier point when the product permits.

The goal is not to expose hidden reasoning. Show information that helps the user understand state, make a decision, or maintain control.

## Intent entry

An intent entry may need more than a text box:

- target object;
- time range;
- files or data sources;
- knowledge base;
- prior context;
- permissions;
- output format;
- constraints.

Represent selected context visibly so the user can verify what the Agent will act on.

## Runtime states

Use product-appropriate labels for:

- understanding;
- clarifying;
- planning;
- executing;
- waiting for user;
- blocked;
- failed;
- completed;
- cancelled.

Do not present all states as an indeterminate spinner. Long-running work needs persistence, progress/context, and a way to leave and return when supported.

## Responsibility boundary

For each step decide whether the Agent may:

- act automatically;
- act and notify;
- propose and wait for confirmation;
- never act.

Require confirmation before consequential access, spending, publishing, deletion, permission change, or other domain-defined risk. Explain the consequence and scope.

## Process transparency

Expose progressively:

1. current phase and status;
2. inputs and scope being used;
3. assumptions or missing information;
4. requested decision and its impact;
5. evidence, references, or data behind the result;
6. expanded technical detail on demand.

More detail is not automatically more trustworthy. Avoid dumping logs or chain-of-thought into the primary experience.

## Trust and evidence

AI-derived results should distinguish:

- observed fact;
- source-backed inference;
- recommendation;
- uncertainty;
- unavailable information.

Give users paths to inspect evidence, affected objects, data freshness, and scope. Do not fabricate confidence scores or citations.

## GenUI and A2UI boundary

Prefer controlled generation:

- Agent declares intent, content, data, available actions, status, validation needs, and whether execution is blocked.
- Client owns component selection, tokens, accessibility, interaction rules, validation, security, and fallback rendering.

Do not let a production Agent freely author arbitrary HTML/JavaScript when a structured component contract can express the experience.

## Dynamic surface selection

Use dynamic UI where task path, evidence, or user decision changes with context. Keep stable navigation, settings, recurring dashboards, and durable information architecture predesigned.

Choose the smallest suitable surface:

- inline clarification;
- decision card;
- permission/risk confirmation;
- task-progress module;
- evidence panel;
- generated report/artifact.

A dynamic card is not a miniature dashboard. A generated report is not a chat bubble enlarged.

## Recovery

Provide the applicable controls:

- edit the intent;
- change inputs/scope;
- retry failed work;
- cancel running work;
- undo reversible actions;
- inspect failure detail;
- resume from a checkpoint;
- compare revised result.

Do not force the user to restart the entire conversation for a local correction.