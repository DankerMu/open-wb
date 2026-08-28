# States and feedback

A product interface is incomplete when only its success screenshot exists. Model the states implied by the task, then give every recoverable failure a usable next action.

## State inventory

Consider these states for each data region or interaction:

- initial/default;
- hover/focus/pressed;
- selected;
- disabled with reason;
- loading/pending;
- partial or stale data;
- empty;
- error;
- permission denied;
- destructive confirmation;
- success/result;
- retry, cancel, back, or alternate path.

Include only applicable states, but do not omit a real condition because it is visually inconvenient.

## Loading posture

Use duration bands as a design guide, not a fake timer:

- **Under roughly 300ms:** avoid flashing a loader.
- **300ms–2s:** preserve layout with skeleton or local pending state.
- **Over 2s:** show explicit activity and meaningful progress/context where available.
- **Long-running or timed out:** explain that work continues or failed, preserve user context, and provide cancel, retry, background, or status tracking as the product permits.

Do not use arbitrary sleeps to simulate correctness.

## Empty states

An empty state should distinguish:

- first use;
- no results after filtering;
- missing configuration;
- permission-limited visibility;
- genuinely zero activity.

Explain why the region is empty and offer the correct next action. Do not fill operational products with decorative illustrations that displace the task.

## Error and recovery

A useful error state answers:

1. What failed?
2. What remains safe or preserved?
3. What can the user do now?
4. Where can they inspect details when needed?

Retry must visibly enter pending and then success/failure. A “Retry” button that only changes text locally without representing the task state is weak evidence.

## Permission states

Do not hide every restricted control if visibility helps the user understand the product. Choose based on product policy:

- hide unavailable capability;
- disable it with a reason;
- show read-only data;
- offer an access-request path.

Never imply a user has permission they do not have.

## Forms and validation

- Validate at a useful moment, not on every untouched field.
- Associate errors with fields and explain correction.
- Preserve user input after recoverable failure.
- Distinguish validation, submission pending, server rejection, and success.
- Keep the primary action available only when its preconditions are clear.

## Feedback placement

Put feedback near the action or object whose state changed. Use global toast only for genuinely global or non-blocking confirmation. Avoid stacking toast, banner, badge, and modal for one event.

## Motion

Motion must explain change, continuity, hierarchy, or causality.

- Prefer transform and opacity for UI motion.
- Keep routine UI transitions short, generally within 300ms.
- Avoid bounce, elastic overshoot, and entrance choreography by default.
- Keyboard-triggered actions should not add unnecessary decoration.
- Respect reduced-motion preferences.
- Never make motion the only indicator of state.