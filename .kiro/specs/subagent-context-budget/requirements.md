# Requirements Document

## Introduction

The subagent-context-budget feature reduces opencode Task-dispatch input
cost by bounding the prompt, instruction, and tool context each subagent
receives. It uses existing cost-diagnostic reports as the baseline and
validation surface, while preserving the existing subagent roster and
declared task capabilities.

## Boundary Context

- **In scope**:
  - Inventory and baseline measurement for every configured subagent on
    each nix-darwin host.
  - Explicit allowed tool sets for existing subagents.
  - Role-scoped instruction context for existing subagents.
  - A minimal read-only subagent baseline for future comparison.
  - Before/after validation using the existing opencode cost diagnostic.
  - Smoke tests proving trimmed subagents still complete their declared
    task classes.
  - Operator-visible reversibility per agent.
- **Out of scope**:
  - Modifications to opencode source code or the Task tool API.
  - Adding, removing, renaming, or replacing subagent types.
  - Subagent dispatch caps, routing rules, fan-out limits, or cost
    circuit breakers.
  - Main-thread context budgeting, session compaction, or tool-output
    compression.
  - Cross-session prompt caching.
  - External SaaS observability or hosted cost analysis.
- **Adjacent expectations**:
  - `opencode-cost-report` provides the baseline and before/after
    comparison surface, including per-agent `subagentDispatch` data
    where available.
  - `session-compaction` remains complementary: it bounds long-session
    accumulation, while this feature bounds per-dispatch subagent
    overhead.
  - Mandatory memory and mcpproxy safety rules remain in force for
    subagents after instruction trimming.

## Requirements

### Requirement 1: Subagent inventory and baseline audit

**Objective:** As the operator, I want a measured baseline for each
configured subagent, so that trimming decisions are evidence-based.

#### Acceptance Criteria

1. When the audit is run on a host, the Subagent Context Budget feature
   shall enumerate every configured subagent available on that host,
   including common and host-specific subagents.
2. When the audit is run for an agent type, the Subagent Context Budget
   feature shall report that agent type's first-turn input token count
   before budget enforcement.
3. When recent diagnostic data includes child-session tool use for an
   agent type, the Subagent Context Budget feature shall report the
   observed tool names for that agent type.
4. If an agent type has no recent diagnostic usage, then the Subagent
   Context Budget feature shall mark its observed-tool baseline as
   absent rather than inferring usage.
5. The Subagent Context Budget feature shall distinguish instruction
   context, exposed tool context, and observed tool-use data in its
   audit output.

### Requirement 2: Explicit per-agent tool budgets

**Objective:** As the operator, I want every subagent to have an
explicit allowed tool set, so that unused tool context is not sent to
short-lived subagent sessions.

#### Acceptance Criteria

1. The Subagent Context Budget feature shall assign each configured
   subagent an explicit allowed tool set.
2. The Subagent Context Budget feature shall include in an agent's
   allowed tool set only tools required for that agent's declared
   responsibilities and mandatory memory workflow.
3. When an agent's declared workflow requires write or destructive
   capability, the Subagent Context Budget feature shall name that
   capability in the agent's budget rationale.
4. If an operator enables the full-tool escape hatch for an agent, then
   the Subagent Context Budget feature shall mark that agent as
   unbudgeted in audit and validation output.
5. The Subagent Context Budget feature shall keep tool-budget decisions
   separate per agent type.

### Requirement 3: Role-scoped instruction context

**Objective:** As the operator, I want each subagent to receive only the
instructions relevant to its role, so that reference material for
unrelated workflows does not inflate every dispatch.

#### Acceptance Criteria

1. The Subagent Context Budget feature shall provide each subagent with
   mandatory universal instructions and role-relevant playbooks only.
2. When an agent type does not perform a specialized workflow, the
   Subagent Context Budget feature shall omit that workflow's reference
   content from the agent type's instruction context.
3. The Subagent Context Budget feature shall preserve mandatory memory,
   cavemem, and mcpproxy safety expectations for subagents.
4. If a subagent later needs an omitted instruction section, then the
   Subagent Context Budget feature shall allow the operator to widen
   that agent's instruction budget without widening all agents.
5. The Subagent Context Budget feature shall not change main-thread
   instruction loading.

### Requirement 4: Minimal read-only subagent baseline

**Objective:** As the operator, I want a minimal baseline for read-only
subagents, so that future subagent additions have a concrete budget to
compare against.

#### Acceptance Criteria

1. The Subagent Context Budget feature shall define a minimal read-only
   subagent baseline.
2. The minimal read-only subagent baseline shall include its measured
   first-turn token count, instruction categories, and allowed tool
   categories.
3. When a subagent budget is evaluated, the Subagent Context Budget
   feature shall report that agent type's delta from the minimal
   read-only baseline.
4. The minimal read-only subagent baseline shall exclude project-specific
   and host-specific instructions unless those instructions are required
   for all read-only subagents.
5. The Subagent Context Budget feature shall expose the minimal read-only
   baseline in an operator-readable artifact.

### Requirement 5: Before/after cost validation

**Objective:** As the operator, I want measurable proof that the budget
reduces subagent-dispatch cost, so that the feature is accepted only if
it moves the diagnostic bucket that triggered it.

#### Acceptance Criteria

1. When validation starts, the Subagent Context Budget feature shall use
   a baseline opencode cost report captured before budget enforcement.
2. When validation completes, the Subagent Context Budget feature shall
   use a post-change opencode cost report captured from a representative
   workload.
3. When validation compares baseline and post-change reports, the
   Subagent Context Budget feature shall compare `subagentDispatch`
   tokens per parent session.
4. When validation completes on the representative workload, the
   Subagent Context Budget feature shall demonstrate at least 40%
   reduction in `subagentDispatch` tokens per parent session compared
   with the baseline.
5. Where per-agent subagent-dispatch data is present, the Subagent
   Context Budget feature shall report which agent types contributed to
   the reduction.
6. If required diagnostic fields are absent or unusable, then the
   Subagent Context Budget feature shall fail validation with an
   operator-facing reason instead of declaring success.
7. The Subagent Context Budget feature shall preserve the diagnostic's
   default privacy posture for prompt and tool-output content.

### Requirement 6: Subagent capability preservation

**Objective:** As the operator, I want trimmed subagents to keep working
for their declared task classes, so that cost reduction does not trade
away agent reliability.

#### Acceptance Criteria

1. When an agent type is budgeted, the Subagent Context Budget feature
   shall provide a smoke test for that agent type's declared task class.
2. When smoke tests run, each existing subagent type shall complete its
   declared representative task with budget enforcement enabled.
3. If a smoke test fails because a required tool or instruction was
   removed, then the Subagent Context Budget feature shall mark that
   agent budget as insufficient.
4. If any required smoke test fails, then the Subagent Context Budget
   feature shall not report the feature as validation-passing.
5. The Subagent Context Budget feature shall preserve direct invocation
   workflows for existing subagents.

### Requirement 7: Host parity and operator control

**Objective:** As the operator, I want budget enforcement to behave
predictably across both nix-darwin hosts, so that cost reports remain
comparable and rollback is simple.

#### Acceptance Criteria

1. The Subagent Context Budget feature shall be available on both
   nix-darwin hosts through the existing declarative configuration
   workflow.
2. When host-specific subagents are present, the Subagent Context Budget
   feature shall budget and validate them without changing the budgets
   for common subagents.
3. When host-specific tool surfaces differ, the Subagent Context Budget
   feature shall account for those differences in audit and validation
   output.
4. The Subagent Context Budget feature shall provide operator-visible
   controls to disable budget enforcement per agent type.
5. If budget enforcement is disabled for an agent type, then the
   Subagent Context Budget feature shall leave that agent type's
   behavior unchanged and report the disabled state.

### Requirement 8: Scope guardrails

**Objective:** As the operator, I want this feature to stay focused on
subagent context budgeting, so that adjacent cost-reduction work remains
separate and independently measurable.

#### Acceptance Criteria

1. The Subagent Context Budget feature shall not change how callers
   invoke the Task tool.
2. The Subagent Context Budget feature shall not add subagent dispatch
   caps, fan-out limits, routing rules, or cost circuit breakers.
3. The Subagent Context Budget feature shall not implement main-thread
   context budgeting, session compaction, or tool-output compression.
4. The Subagent Context Budget feature shall not require external SaaS
   services.
5. The Subagent Context Budget feature shall not modify opencode source
   code.
