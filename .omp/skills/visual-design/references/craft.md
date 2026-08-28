# Interface craft

Craft turns a correct structure into a deliberate interface. Apply it after intent, shape, content, components, and states are sound.

## Hierarchy

- Give each screen or slide one obvious focal point.
- Use scale, position, density, contrast, and whitespace before adding decoration.
- Do not make every section a same-sized card with equal heading weight.
- Keep primary actions visually dominant without coloring every action.
- Let secondary information become quieter, not merely smaller.

## Typography

- Choose a display role and a reading role; they may use the same family when the product is intentionally software-native.
- For CJK interfaces, use a CJK-capable stack and verify actual line height, punctuation, weight, and mixed Latin/numeric rhythm.
- Use `text-wrap: balance` or `pretty` where supported for major copy.
- Use tabular numerals for changing metrics, prices, timers, and aligned tables.
- Keep deck text readable at 1920×1080: body copy generally at least 24px and headlines generally at least 36px.

## Space and density

- Separate component internal spacing from layout spacing.
- Dense tools should preserve scanability; marketing pages should not inherit console density.
- Repeated spacing should follow a small intentional scale.
- Use container queries, grid, flex, and `clamp()` where they make content behavior clearer.
- Test content growth rather than composing only for one exact sentence.

## Surfaces and geometry

- Use borders, background levels, grouping, and spacing to express hierarchy before shadows.
- Radius should reflect component size and product posture; nested radii should relate.
- Do not put every region on a floating white card.
- Reserve glass/blur for a small number of surfaces whose overlay role benefits from it.
- Avoid rounded cards with a colored left accent strip as a default module style.

## Color

- Use one accent deliberately and semantic colors for real states.
- Do not use purple/blue gradients as an automatic signifier of technology or AI.
- Do not let brand color appear everywhere; when every module is emphasized, none is.
- Verify contrast in the rendered composition, including text over imagery and gradients.
- Do not use color alone to encode risk, selection, or success.

## Content specificity

- Use domain-specific labels, actions, fields, and state language.
- Avoid “Feature One,” lorem ipsum, invented metrics, generic quotes, and placeholder icons.
- Prefer short honest unknowns (`—`) over fabricated completeness.
- Match the user's language and locale.

## Motion posture

- Every animation needs a purpose: orientation, continuity, feedback, emphasis, or storytelling.
- One decisive motion idea is stronger than many unrelated effects.
- Avoid animation that delays routine work or makes operational data harder to scan.
- Respect reduced motion and keyboard interaction.

## Accessibility basics

- Mobile hit targets should be at least 44px; Android-native targets generally 48dp.
- Preserve visible keyboard focus.
- Give controls names and use semantic HTML.
- Do not rely on placeholder text as a label.
- Maintain reading and focus order when layouts reflow.
- Ensure hover-only affordances have touch and keyboard equivalents.

## Anti-slop review

Reject these unless the brand or concept explicitly requires them:

- default purple/violet gradient hero;
- emoji as feature icons;
- icon beside every heading;
- equal white card grid with no information hierarchy;
- giant low-information hero in a task-focused console;
- generic uppercase eyebrow on every module;
- decorative charts with no diagnostic meaning;
- hand-drawn people or scenery used as filler;
- demo/settings controls embedded in the final product UI;
- predictable landing-page sections that ignore the brief.

Do not remove personality to avoid slop. Replace generic effects with a specific idea tied to the product.