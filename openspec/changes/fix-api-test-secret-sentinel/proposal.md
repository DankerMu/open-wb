## Why
Issue #69: a generic `private` leakage sentinel collides with macOS source stack paths, producing four false failures without a production leak.
## What Changes
Use one stable unique fixture secret in the existing ServiceInfo leakage matrix and both exclusion assertions; no runtime change.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: pathname-independent ServiceInfo leakage oracle.
## Impact
Only web/test/api-info-logout.test.ts fixture values/assertions. Fixture level none: isolated test expectation/fixture update with unchanged product behavior; upstream level absent. Repair low.
