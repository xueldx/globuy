# agent-process-timeline Specification

## ADDED Requirements

### Requirement: Session-scoped event storage

The frontend SHALL store process events under the session that owns the generation and SHALL deduplicate replayed events by generation identity and sequence.

#### Scenario: Background session receives events

- **WHEN** a generation emits a process event while another session is visible
- **THEN** the event is stored under the generation session
- **AND** the visible session timeline is unchanged

#### Scenario: SSE replay repeats an event

- **WHEN** an event with the same generation ID and sequence is received again
- **THEN** only one copy contributes to the projected timeline

### Requirement: Bounded process history

The frontend SHALL ignore token delta events for process visualization and SHALL keep no more than 160 process events for one session.

#### Scenario: Long generation exceeds the limit

- **WHEN** more than 160 process events are accepted for one session
- **THEN** the oldest events are removed
- **AND** the newest 160 events remain projectable

### Requirement: Event-to-step projection

The frontend SHALL project ordered process events into user-readable steps with running, completed, warning, failed, or cancelled status.

#### Scenario: Tool invocation completes

- **WHEN** a `tool.invoke` event is followed by a matching `tool.result`
- **THEN** one tool step is shown
- **AND** its status changes from running to completed or failed

#### Scenario: Tool result has no matching invocation

- **WHEN** replay contains a `tool.result` without a matching `tool.invoke`
- **THEN** a completed or failed result step is still shown

### Requirement: Diagnostic errors do not end a generation

The frontend SHALL distinguish diagnostic warning events from terminal generation errors.

#### Scenario: Retry warning arrives before final result

- **WHEN** an `error` event contains `retrying: true` or only a diagnostic `message`
- **THEN** the timeline shows a warning
- **AND** the assistant message remains streaming until a real terminal event arrives

#### Scenario: Terminal error arrives

- **WHEN** an `error` event contains a non-empty `error` field
- **THEN** the active process is marked failed
- **AND** the assistant message is finalized with error status

### Requirement: Live and retained visualization

The frontend SHALL show the current process inside the streaming assistant message and SHALL retain a frozen step snapshot after the message reaches a terminal state.

#### Scenario: Final answer replaces streaming bubble

- **WHEN** `final.result` finalizes the assistant message
- **THEN** the normal message row contains the same process steps
- **AND** the process panel is collapsed by default but remains expandable

### Requirement: Safe process summaries

The frontend SHALL render process copy from an allowlist and SHALL NOT serialize unknown payloads or sensitive tool arguments into the DOM.

#### Scenario: Order tool carries shipping data

- **WHEN** an order tool invocation payload includes an address or phone number
- **THEN** the timeline shows a generic order-validation summary
- **AND** the address and phone number are absent from rendered text

### Requirement: Accessible disclosure

The process panel SHALL use a keyboard-operable button with an accessible name, expanded state, visible focus style, and a minimum 40 px target.

#### Scenario: Keyboard user toggles completed process

- **WHEN** focus is on the process summary button and the user activates it
- **THEN** the step list opens or closes
- **AND** `aria-expanded` reflects the visible state
