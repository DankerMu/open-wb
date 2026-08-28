# Delta Catalog

| Delta ID | Exact version pair | Category | Source evidence | Affected units | Touched sites | Silent behavior risk | Mechanical or judgment | Required check | Disposition |
|---|---|---|---|---|---|---|---|---|---|

A delta exists only where this code actually hits the change: a removed API nobody calls is
not a delta. Record ecosystem-tool evidence in three states — present, runnable here, actually
ran — and fold a tool's findings into the catalog only when it actually ran; otherwise record
the lost coverage explicitly. Weigh route fitness by touched sites, not entry count: one
judgment delta can touch thousands of sites, and a codebase-wide mechanical codemod is a
de-facto rewrite. When the catalog forces most of the tree to change, reclassify the route
before planning waves.
