## ADDED Requirements

### Requirement: Virtualized dynamic-height rendering
The frontend SHALL render only the visible message range plus configured overscan, SHALL support messages whose height is unknown before rendering, and SHALL keep the full logical scroll height available.

#### Scenario: Long conversation is opened
- **WHEN** a conversation contains 1,000 messages
- **THEN** the list mounts only the viewport and overscan message nodes while every message remains reachable by scrolling

#### Scenario: A measured message height changes
- **WHEN** Markdown layout, code highlighting, font loading, or streaming content changes an item height
- **THEN** the virtualizer updates following item positions and the logical list height without rendering all messages

### Requirement: Stable message identity
The virtualized list MUST use each message's stable id as its item key and MUST isolate measurement state between sessions.

#### Scenario: Streaming content updates the active message
- **WHEN** the active assistant message receives new content without changing its id
- **THEN** React updates the same logical item instead of mounting a different message identity

#### Scenario: User switches sessions
- **WHEN** the route changes from one session id to another
- **THEN** the new list does not reuse the previous session's item measurements or scroll intent

### Requirement: Intent-aware bottom following
The frontend SHALL model scrolling as `FOLLOWING`, `USER_READING`, or `RESTORING`, SHALL follow new output only while following or restoring, and SHALL use a non-zero bottom threshold.

#### Scenario: Stream grows while user is at the bottom
- **WHEN** the active assistant item grows and the list is within 80 pixels of the bottom
- **THEN** the viewport remains aligned to the latest content

#### Scenario: User scrolls up during generation
- **WHEN** the user moves outside the bottom threshold while tokens continue arriving
- **THEN** the state becomes `USER_READING` and no height update forces the viewport back to the bottom

#### Scenario: User manually returns to the bottom
- **WHEN** the list reports that the viewport is within the bottom threshold again
- **THEN** the state becomes `FOLLOWING` and later output resumes automatic following

### Requirement: Restore latest content on demand
The frontend SHALL expose a keyboard-operable control whenever the user is reading above the latest content and SHALL restore bottom following when activated.

#### Scenario: User activates the latest-content control
- **WHEN** the list is in `USER_READING` and the user activates “回到最新”
- **THEN** the state becomes `RESTORING`, the final item is aligned to the viewport end, and arrival at the bottom changes the state to `FOLLOWING`

#### Scenario: User sends from a historical position
- **WHEN** a new user message is appended while the list is in `USER_READING`
- **THEN** the list restores to the bottom so the sent message and assistant response are visible

### Requirement: Bounded scroll work
The frontend SHALL coalesce repeated height-change notifications into at most one programmatic bottom alignment per animation frame and SHALL cancel pending work on unmount.

#### Scenario: Multiple measurements finish in one frame
- **WHEN** the virtualizer reports multiple total-height changes before the next animation frame while following
- **THEN** only one bottom-alignment operation executes in that frame

#### Scenario: List unmounts with pending work
- **WHEN** the user changes route or session before a scheduled alignment runs
- **THEN** the pending frame is cancelled and cannot scroll the replacement list

### Requirement: Overscan and accessible status
The list SHALL render additional content above and below the viewport to reduce blank gaps during fast scrolling and SHALL expose scroll-follow state without obstructing message reading.

#### Scenario: User leaves the latest content
- **WHEN** the list enters `USER_READING`
- **THEN** a visible “回到最新” button with an accessible name appears without covering the composer

#### Scenario: User scrolls quickly
- **WHEN** the visible range changes faster than message components mount
- **THEN** the configured top and bottom overscan provides already-mounted nearby content while keeping mounted message count bounded
