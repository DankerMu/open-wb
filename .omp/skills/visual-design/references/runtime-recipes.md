# Runtime recipes

Load only the section needed for the selected medium. Existing project conventions override standalone recipes.

## Standalone artifact

- Prefer a complete HTML file with inline CSS/JS for a fresh self-contained prototype.
- Split files only when complexity or the existing project structure benefits.
- Use semantic HTML, CSS custom properties, Grid/Flexbox, and progressive enhancement.
- Keep the artifact runnable without a build step unless the task requires a framework project.

## Standalone React in HTML

Use these pinned scripts:

```html
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>
```

For Motion React hooks:

```html
<script src="https://unpkg.com/framer-motion@11.11.13/dist/framer-motion.js"></script>
```

Read hooks from `window.Motion`. Avoid `type="module"` when Babel is used. Give component style objects specific names rather than `styles`. If Babel scripts share components, publish them deliberately through `window`.

## Decks and fixed canvases

- Default to a 1920×1080 canvas unless the user specifies another format.
- Implement scale-to-fit, keyboard navigation, visible slide counter, print styles, and localStorage position restore.
- Keep navigation controls outside the scaled canvas.
- Tag each slide with `data-screen-label="01 Title"`; labels are 1-indexed.
- Use one main idea per slide; maintain composition rhythm instead of repeating one grid.
- Verify at full canvas and scaled viewport.

## Responsive web prototypes

Design content behavior at meaningful widths rather than merely adding one breakpoint. Common checkpoints include 360/390/430, 600/744, 768/834, 1024/1180, 1280/1366, 1440/1536, and 1920.

- Preserve reading and focus order.
- Define what collapses, moves, hides, or becomes a drawer.
- Test long labels, data growth, and reduced viewport height.
- Do not use `scrollIntoView`; calculate offsets or use the intended scroll container.

## iOS prototypes

- Use iPhone framing only when device context benefits the artifact.
- Respect status area, Dynamic Island where appropriate, safe areas, bottom/home affordance, 44px targets, and iOS navigation patterns.
- Ensure device chrome does not cover content.
- Account for keyboard and modal/sheet behavior when forms are central.

## Android prototypes

- Use Pixel/Material framing where appropriate.
- Respect 48dp targets, system bars, back navigation, sheets/dialogs, and Android navigation patterns.
- Do not make an iOS interface with Android chrome.

## Dashboards and tools

- Optimize density, sorting, filtering, selection, status, bulk actions, and tabular numerics.
- Connect summary anomalies to detail or investigation.
- Make empty/filter-empty/loading/error/permission states coherent.
- Avoid decorative hero treatment that reduces working space.

## Media surfaces

Do not fake binary image, video, or audio output inside HTML. Use the available media-generation tool. If no media tool exists, deliver a production-ready prompt, storyboard, or specification and state that no binary file was generated.

A useful media prompt includes subject, action, composition, camera/lens, lighting, style, duration/aspect when relevant, references, and negative constraints.