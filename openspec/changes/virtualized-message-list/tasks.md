## 1. Dependency and component boundary

- [ ] 1.1 Install and lock the open-source `react-virtuoso` dependency
- [ ] 1.2 Extract message rows and streaming rendering into `VirtualMessageList`

## 2. Virtualization and anchoring

- [ ] 2.1 Configure stable message keys, initial bottom position, dynamic height handling, and asymmetric overscan
- [ ] 2.2 Implement the `FOLLOWING / USER_READING / RESTORING` state machine and frame-coalesced height alignment
- [ ] 2.3 Add the accessible “回到最新” control and restore on a newly sent user message

## 3. Tests and integration

- [ ] 3.1 Add component tests for virtual range props, stable identity, empty/loading states, and session isolation
- [ ] 3.2 Add state tests for user reading protection, restore behavior, stream growth, and unmount cleanup
- [ ] 3.3 Replace the full message map and unconditional `AutoScrollBottom` in `ChatPage`

## 4. Verification and documentation

- [ ] 4.1 Run OpenSpec validation, frontend tests, typecheck, and production build
- [ ] 4.2 Verify the rendered list at 1280 px and 375 px with long dynamic messages and user-scroll scenarios
- [ ] 4.3 Run adversarial and quality reviews, resolve findings, and complete implementation, exception, and interview documents
