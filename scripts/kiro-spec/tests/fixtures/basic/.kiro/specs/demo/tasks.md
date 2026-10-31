# Implementation Plan

- [ ] 1. Crate foundation
- [x] 1.1 Scaffold the crate
  - _Requirements: 1.1_
- [!] 1.2 Add the entry point
  - _Blocked: waits for the operator to approve the release._
  - _Requirements: 1.2_
  - _Boundary: cli entry (`src/main.rs`)_
  - _Depends: 1.1_
- [x]* 1.3 Optional polish
  - _Requirements: 1.3_

- [ ] 2. Reporting
- [ ] 2.1 Print the task list
  - _Requirements: 2.1,
     2.2_
  - _Verified: manual run_
- [x] 2.2 Print the next task

- [ ]* 3. Optional follow-up
  - _Blocked: legacy prose on a pending entry is ignored._
- [ ] 4. Adjacent entry
- [ ] 5. Legacy blocked prose
  - _Blocked: legacy prose survives parsing
     and keeps its continuation line._
  - _Reopened: after review_
