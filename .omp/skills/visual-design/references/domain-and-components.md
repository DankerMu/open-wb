# Domain and component semantics

A visually similar component can carry a different product responsibility. Decide what the information means before choosing how it looks.

## Domain pass

For product UI, identify:

- domain objects and accepted terminology;
- lifecycle states and allowed transitions;
- severity/risk levels and their consequences;
- permissions and ownership;
- sensitive fields and reveal rules;
- reversible versus destructive actions;
- evidence, data source, time window, units, and uncertainty;
- actions the user can take from each non-terminal state.

Do not make a domain-specific screen that could belong unchanged to any product.

## Semantic status

Distinguish:

- **status** — lifecycle or runtime condition (`queued`, `running`, `failed`);
- **risk/severity** — consequence and urgency (`critical`, `warning`);
- **category** — classification (`compute`, `production`);
- **result** — completed outcome (`succeeded`, `rejected`);
- **progress** — degree or phase of work.

Do not encode all five as interchangeable colored pills. Color is not the only carrier; pair semantic color with text, icon, pattern, or position as appropriate.

## Common component boundaries

### Badge versus tag

- Badge: attached status, risk, count, or compact result.
- Tag: category, attribute, filter value, or removable classification.
- A dedicated risk badge may be warranted when domain risk has stable semantics.

### Dialog versus drawer

- Dialog: focused interruption, confirmation, short decision, or bounded form.
- Drawer: contextual detail or a longer secondary task that preserves the parent context.
- Full page: complex task with navigation, deep editing, or durable URL/state.

### Tabs versus segmented mode switch

- Tabs: switch between sibling views within one information space.
- Segmented switch: change mode, metric basis, or presentation of the same object.
- Filter chips: constrain a result set; they are not tabs.

### Select, menu, and command

- Select/dropdown: choose one or more values.
- Menu: invoke an action.
- Command interface: search and execute from a broad action space.
- Do not hide the only primary action inside an overflow menu.

### Toast, inline feedback, and blocking alert

- Inline feedback: local validation or local state.
- Toast: transient confirmation that does not require a decision.
- Alert/banner: persistent or cross-surface information requiring attention.
- Dialog: consequential decision or interruption.

## Risk and destructive actions

For irreversible, high-impact, permission-changing, deletion, or security actions:

- state the consequence, not only “Are you sure?”;
- identify the affected object and scope;
- require confirmation proportionate to the risk;
- show success/failure and the resulting state;
- offer undo only when the operation is genuinely reversible.

## Sensitive data

When the domain includes credentials, personal data, account identifiers, infrastructure addresses, financial data, or private content:

- default to the repository/domain policy;
- mask when required;
- make reveal explicit;
- do not fabricate audit behavior;
- do not place sensitive values into decorative demo content.

## Data and evidence

Data displays should expose enough context to be trusted:

- metric name and unit;
- time window and timezone when relevant;
- source or freshness;
- comparison baseline;
- uncertainty and supporting evidence for AI-derived results; never invent numeric confidence scores or citations;
- path to detail or evidence.

Do not invent statistics, customer quotes, certifications, or benchmarks to make a design look complete.

When source data is absent, prefer `—` or a clearly labeled unknown. Illustrative or estimated values are acceptable only when their status and scope are visible on the surface that contains them; a page-level disclaimer does not cover unrelated market, customer, or performance claims.