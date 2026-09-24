## ADDED Requirements

### Requirement: Isolated bounded upstream dialogue gate
The existing loopback fake-upstream SHALL expose test-only authenticated gate control using its existing expected bearer: POST `/__control/gates/{uuid}` arm, GET phase, POST `/__control/gates/{uuid}/release` release held response, DELETE cleanup. Gate identity SHALL bind one final text response selected by the last user's `WORKBUDDY_UI_WALK:<uuid>` marker; the tool round remains unchanged. An armed final response SHALL send role and first nonempty content prefix but withhold remaining content/finish/DONE until explicit release. Released bytes SHALL reconstruct the unchanged fixed reply. Default/unarmed requests SHALL retain existing behavior.
The fixture SHALL reject wrong bearer401, invalid ID400, duplicate arm or invalid transition409, unknown ID404 and claims of an already-bound gate without stealing ownership. Gates SHALL be instance-local, bounded to32 entries and30s lifetime; expiry/delete/disconnect/server close SHALL clear owned timers/state and destroy unfinished held responses instead of forging completion. Control failure SHALL not release another gate. No gate route SHALL exist in product app-server.

#### Scenario: Hold and release preserve real protocol
- WHEN an authenticated test arms a UUID gate and real omp sends matching final text request after bash
- THEN the upstream publishes prefix and held phase without finish; release sends the remaining original chunks and DONE exactly once

#### Scenario: Ownership and cleanup fail closed
- WHEN two distinct gates coexist, a request targets a different/unknown gate, authentication fails, a transition duplicates, or TTL/delete/disconnect/close occurs
- THEN only the owning gate can change; invalid controls fail explicitly, unfinished cancelled responses do not complete successfully and no owned gate/timer remains after cleanup
