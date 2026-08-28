# QueueScope design authority

- Product posture: dense operational console, light mode, neutral work surfaces.
- Keep the existing 56px sidebar and 48px top bar.
- Use the supplied semantic variables from `tokens.css`; do not add another palette or gradient.
- Geometry: 4px controls and panels, square table rows, hairline borders, no floating card grid.
- Typography: system sans for UI, mono for job ids and durations.
- Status semantics: queued = neutral, running = info, failed = danger, recovered = success.
- Primary task: inspect and recover failed jobs without losing table context.
- Drawer is the established secondary-detail pattern.
- Routine state transitions should be short and use opacity/transform only.
