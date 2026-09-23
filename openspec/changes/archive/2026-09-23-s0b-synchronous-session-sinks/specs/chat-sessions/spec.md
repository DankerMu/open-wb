## ADDED Requirements

### Requirement: Synchronous supervisor observation sinks
SessionSupervisor onEvent and onError sinks, including sinks passed through registerSessions and createApp assembly, SHALL complete synchronously. Ordinary non-thenable return values SHALL remain ignored, preserving existing void-callback compatibility. Each sink SHALL be invoked once per notification. The options interfaces SHALL document the synchronous contract; an undefined optional onEvent SHALL retain its existing no-observer behavior.

A returned thenable, whether a native Promise or a structural thenable object/function, SHALL be an owned programming error regardless of fulfilled, rejected or pending settlement. The returned value's rejection SHALL be contained without a process-global rejection handler, without invoking the sink again and without later reporting the same violation a second time. Reading a throwing then getter or invoking a synchronous sink that throws SHALL enter the existing synchronous error ownership path. Invalid never-settling sink work SHALL NOT be awaited by publication, runtime retirement or shutdown; arbitrary asynchronous side effects created by an invalid callback are not supported app-owned work.

For an onEvent violation, the supervisor SHALL retain/report one infrastructure fault, stop further publication for that pump and retire its native runtime/token through existing ownership. For an onError violation, the supervisor SHALL retain the violation alongside the source fault without recursive onError calls. Shutdown SHALL surface retained faults while still awaiting existing native/pump cleanup and allowing registerSessions to close its store before returning control of the still-usable caller DB. Existing synchronous throw semantics, modeled public-error behavior, session isolation and runtime→listener→DB ordering SHALL remain unchanged. App/module composition SHALL not discard an external sink result before the guard sees it.

#### Scenario: Supported synchronous controls
- WHEN an event recorder or error observer returns an ordinary synchronous value such as an array-push count
- THEN event publication and successful turns continue normally, or the original source failure alone is retained; no spurious programming fault is introduced
- WHEN an existing observer/error sink throws synchronously
- THEN its original fault ownership, runtime/token retirement and shutdown report remain unchanged

#### Scenario: Unsupported event-sink return
- WHEN an event observer returns a rejected, fulfilled or never-settling Promise, or a non-native thenable
- THEN one programming fault is reported, later events from that pump are not published, its native child/token are retired, shutdown reports the owned fault, and neither detached rejection nor waiting for the invalid sink occurs

#### Scenario: Unsupported error-sink return
- WHEN a real source failure reaches onError and that sink returns a rejected native Promise or a non-native thenable
- THEN the source error and one sink-contract fault remain observable at shutdown, onError was called only once, and no detached rejection or recursive notification escapes

#### Scenario: Structural thenable and assembly fidelity
- WHEN a callable value with a callable then property, or a value whose then getter throws, is returned through the real app/module sink seam
- THEN structural thenable rejection is consumed or the getter's synchronous failure is retained through the same ownership path; wrapping or composing the sink never hides its return value
