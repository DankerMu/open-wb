# Built-in visual directions

Use these only when no project design system, brand guide, screenshot, or stronger product reference exists. A direction is a posture, not a brand imitation. Bind the selected palette and repeated values to CSS custom properties.

## Editorial authority

Use for reports, essays, publishing, cultural products, and decision documents.

- Display: a readable editorial serif; body: quiet sans serif.
- Palette: warm-neutral paper, dark ink, restrained red or oxblood accent.
- Structure: strong headlines, rules, captions, columns, deliberate whitespace, one decisive image or chart.
- Surfaces: avoid generic rounded cards and decorative shadows.
- Motion: minimal; reveal hierarchy rather than decorate.

Suggested seed:

```css
:root {
  --bg: oklch(98% 0.004 95);
  --surface: oklch(100% 0.002 95);
  --fg: oklch(20% 0.018 70);
  --muted: oklch(48% 0.012 70);
  --border: oklch(90% 0.006 95);
  --accent: oklch(52% 0.10 28);
}
```

## Software-native minimal

Use for SaaS, developer tools, product launches, and documentation-like interfaces.

- Typography: crisp software-native sans; tabular numerals where data appears.
- Palette: cool-neutral base with one clear functional accent.
- Structure: hairline dividers, disciplined alignment, restrained chrome, one product demonstration.
- Surfaces: use cards only for real containment; do not make every section float.
- Motion: short opacity/transform transitions tied to state changes.

```css
:root {
  --bg: oklch(99% 0.002 240);
  --surface: oklch(100% 0 0);
  --fg: oklch(18% 0.012 250);
  --muted: oklch(54% 0.012 250);
  --border: oklch(92% 0.005 250);
  --accent: oklch(58% 0.18 255);
}
```

## Human tactile

Use for consumer tools, education, marketplaces, wellness, and approachable services.

- Typography: warm humanist sans with comfortable line height.
- Palette: neutral foundation with purposeful green, teal, coral, or brand-specific accent.
- Structure: clear tasks, generous touch spacing, tactile selected and pressed states.
- Surfaces: comfortable radii are allowed, but avoid pastel beige wash and indiscriminate pills.
- Motion: responsive and reassuring, never elastic by default.

```css
:root {
  --bg: oklch(98% 0.004 240);
  --surface: oklch(100% 0 0);
  --fg: oklch(20% 0.02 240);
  --muted: oklch(50% 0.018 240);
  --border: oklch(90% 0.006 240);
  --accent: oklch(56% 0.12 170);
}
```

## Dense operational

Use for consoles, analytics, operations, engineering tools, and internal systems.

- Typography: compact system sans plus mono for identifiers and code.
- Palette: neutral work surface with semantic status roles.
- Structure: tables, filters, inline actions, status visibility, high information per square inch.
- Surfaces: hierarchy comes from grouping, dividers, headers, and density—not decorative hero cards.
- Motion: state feedback only; avoid entrance choreography during routine work.

```css
:root {
  --bg: oklch(98% 0.005 250);
  --surface: oklch(100% 0 0);
  --fg: oklch(22% 0.02 240);
  --muted: oklch(50% 0.018 240);
  --border: oklch(90% 0.008 240);
  --accent: oklch(58% 0.16 145);
}
```

## Controlled experimental

Use for art, independent studios, manifestos, campaigns, and explicitly experimental briefs.

- Typography: one loud typographic gesture plus a disciplined supporting face.
- Structure: visible grid, asymmetry, strong rules, unusual crop, or deliberate scale contrast.
- Color: high contrast with one intentional shock.
- Control: every disruption must reinforce the idea or reading path.
- Avoid random ugliness, illegible type, and effects competing with content.

## Selection rule

Choose the direction that reinforces the task and domain. Do not blend all directions. One posture should govern typography, density, surfaces, and motion. A single contrasting flourish is enough.