## ADDED Requirements

### Requirement: Product results carry verifiable field sources

The product search tool SHALL emit structured product cards whose catalog facts include a catalog citation, and SHALL add a calculation citation when landed price is available.

#### Scenario: Catalog result without landed price

- **WHEN** a product search returns a valid catalog product without a landed price quote
- **THEN** the product card SHALL include a catalog citation covering its catalog-backed fields
- **AND** it SHALL NOT contain an empty calculation citation

#### Scenario: Catalog result with landed price

- **WHEN** landed price calculation succeeds for a product
- **THEN** the card SHALL include the landed price values
- **AND** a calculation citation SHALL identify the calculated field

### Requirement: Retrieval tools expose safe answer sources

Category knowledge and web search tools SHALL include bounded, user-displayable source summaries in their result events without exposing internal request data.

#### Scenario: Knowledge retrieval succeeds

- **WHEN** category retrieval returns one or more insights
- **THEN** the result event SHALL include a stable source identifier, label, source type, and bounded summary for each displayed insight

#### Scenario: Web search succeeds

- **WHEN** web search returns results
- **THEN** the result event SHALL include title, bounded summary, and optional URL for each displayed result

### Requirement: Unknown event data is validated before rendering

The frontend SHALL project commerce artifacts from unknown event payloads through runtime validation and SHALL isolate invalid entries.

#### Scenario: One product is malformed

- **WHEN** a result contains valid products and one product with missing required fields or invalid money values
- **THEN** the malformed product SHALL be skipped
- **AND** all valid products SHALL remain renderable

#### Scenario: A source has a dangerous URL

- **WHEN** a source URL does not use HTTP or HTTPS
- **THEN** the URL SHALL be removed before reaching the source component
- **AND** the source text MAY remain visible if its remaining fields are valid

### Requirement: Projection selects stable current artifacts

The frontend SHALL display the last successful product search result for a generation and SHALL deduplicate sources using stable identifiers.

#### Scenario: A generation performs multiple sequential product searches

- **WHEN** multiple successful product search results exist in the same generation
- **THEN** only the final successful result group SHALL be displayed

#### Scenario: The same source appears more than once

- **WHEN** multiple events contain the same source identifier
- **THEN** the projected source list SHALL contain one stable entry for that identifier

### Requirement: Commerce artifacts remain attached to their assistant message

The chat UI SHALL show projected artifacts while streaming and SHALL freeze them into the matching assistant message on terminal completion.

#### Scenario: A response is still streaming

- **WHEN** commerce tool events arrive for the active generation
- **THEN** its assistant bubble SHALL update with the current product cards and sources

#### Scenario: A response reaches a terminal event

- **WHEN** the generation completes, fails, or is cancelled
- **THEN** the current products and sources SHALL be copied into the matching assistant message before live state is cleared
- **AND** later events SHALL NOT mutate that frozen message snapshot

### Requirement: Product cards and sources are accessible and responsive

The UI SHALL present product facts with a clear price hierarchy and SHALL expose source details through keyboard-operable disclosure controls across supported viewport and color modes.

#### Scenario: A user expands product evidence

- **WHEN** the user activates a product source control using keyboard or pointer
- **THEN** the control SHALL expose its expanded state and associated panel to assistive technology
- **AND** any valid external link SHALL open with opener isolation

#### Scenario: A card has no landed price

- **WHEN** a valid product has no landed price quote
- **THEN** the card SHALL omit the landed price row without rendering a misleading zero or empty placeholder

### Requirement: Persistence scope is explicit

The feature SHALL preserve structured artifacts for the current page lifetime and active generation replay, but SHALL NOT claim completed-history restoration until the history protocol stores them.

#### Scenario: A completed message is revisited without refreshing

- **WHEN** the user returns to a completed message in the current application lifetime
- **THEN** its frozen product and source snapshots SHALL remain visible
