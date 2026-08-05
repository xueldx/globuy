## 1. Planning and contracts

- [x] 1.1 Write the F6 decision with alternatives, reference analysis, privacy boundary, and fragile assumption
- [x] 1.2 Define OpenSpec proposal, design, requirements, validation plan, and rollback

## 2. Event model and store

- [x] 2.1 Add process step types and a pure event-to-step projector with safe summaries
- [x] 2.2 Replace the global process array with session-scoped, deduplicated, bounded event storage
- [x] 2.3 Add projector and store tests for pairing, terminal states, diagnostics, privacy, and limits

## 3. UI and chat integration

- [x] 3.1 Rebuild `EventTimeline` as an accessible live/collapsed process panel
- [x] 3.2 Feed process events from both generation subscription paths and freeze terminal snapshots into assistant messages
- [x] 3.3 Render live and frozen process panels inside virtualized assistant rows
- [x] 3.4 Add component and integration tests for live updates, retained snapshots, and safe copy

## 4. Verification and documentation

- [ ] 4.1 Run OpenSpec validation, frontend tests, typecheck, and production build
- [ ] 4.2 Verify the rendered panel at 1280 px and 375 px, in light/dark mode and reduced motion
- [ ] 4.3 Run adversarial race/privacy review and code-quality review, then resolve findings
- [ ] 4.4 Complete implementation, exception, and interview documents and update F6 status
