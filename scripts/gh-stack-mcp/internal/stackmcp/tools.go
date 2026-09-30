package stackmcp

import (
	"context"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type StageMode string

const (
	StageNone    StageMode = "none"
	StageIndex   StageMode = "index"
	StageTracked StageMode = "tracked"
	StageAll     StageMode = "all"
)

type RebaseAction string

const (
	RebaseStart    RebaseAction = "start"
	RebaseContinue RebaseAction = "continue"
)

type RebaseScope string

const (
	RebaseFull      RebaseScope = "full"
	RebaseUpstack   RebaseScope = "upstack"
	RebaseDownstack RebaseScope = "downstack"
	RebaseNoTrunk   RebaseScope = "noTrunk"
)

type UnstackMode string

const (
	UnstackRemoteAndLocal UnstackMode = "remoteAndLocal"
	UnstackLocalOnly      UnstackMode = "localOnly"
)

type OutcomeStatus string

const (
	OutcomeRejected         OutcomeStatus = "rejected"
	OutcomeLocalObservation OutcomeStatus = "local_observation"
	OutcomeExitedUnverified OutcomeStatus = "exited_unverified"
	OutcomeConflictPending  OutcomeStatus = "conflict_pending"
	OutcomeTimedOutUnknown  OutcomeStatus = "timed_out_unknown"
	OutcomeCleanupUnknown   OutcomeStatus = "cleanup_unknown"
)

type ViewInput struct {
	Path   string `json:"path"`
	Remote string `json:"remote"`
}

type InitInput struct {
	Path     string   `json:"path"`
	Remote   string   `json:"remote"`
	Trunk    string   `json:"trunk"`
	Branches []string `json:"branches"`
}

type AddInput struct {
	Path    string    `json:"path"`
	Remote  string    `json:"remote"`
	Branch  string    `json:"branch,omitempty"`
	Stage   StageMode `json:"stage,omitempty"`
	Message string    `json:"message,omitempty"`
}

type CheckoutInput struct {
	Path   string `json:"path"`
	Remote string `json:"remote"`
	Branch string `json:"branch"`
}

type RebaseInput struct {
	Path   string       `json:"path"`
	Remote string       `json:"remote"`
	Action RebaseAction `json:"action"`
	Scope  RebaseScope  `json:"scope,omitempty"`
}

type SyncInput struct {
	Path   string `json:"path"`
	Remote string `json:"remote"`
	Prune  bool   `json:"prune,omitempty"`
}

type PushInput struct {
	Path   string `json:"path"`
	Remote string `json:"remote"`
}

type SubmitInput struct {
	Path   string `json:"path"`
	Remote string `json:"remote"`
	Open   bool   `json:"open,omitempty"`
}

type LinkInput struct {
	Path     string   `json:"path"`
	Remote   string   `json:"remote"`
	Branches []string `json:"branches"`
	Base     string   `json:"base,omitempty"`
	Open     bool     `json:"open,omitempty"`
}

type UnstackInput struct {
	Path        string      `json:"path"`
	Remote      string      `json:"remote"`
	StackNumber int         `json:"stackNumber"`
	Mode        UnstackMode `json:"mode"`
}

type Outcome struct {
	Operation  string        `json:"operation"`
	Repository string        `json:"repository"`
	Spawned    bool          `json:"spawned"`
	ExitCode   *int          `json:"exitCode,omitempty"`
	Status     OutcomeStatus `json:"status"`
	Stdout     string        `json:"stdout"`
	Stderr     string        `json:"stderr"`
	Truncated  bool          `json:"truncated"`
}

type Dispatcher interface {
	Dispatch(context.Context, string, any) (Outcome, error)
}

type unavailableDispatcher struct{}

func (unavailableDispatcher) Dispatch(_ context.Context, operation string, _ any) (Outcome, error) {
	return Outcome{
		Operation: operation,
		Status:    OutcomeRejected,
		Stderr:    "Stack command execution is unavailable until the command runner is configured.",
	}, nil
}

type toolDefinition struct {
	name        string
	description string
	inputSchema map[string]any
}

func NewServer() *mcp.Server {
	return newServer(unavailableDispatcher{})
}

func newServer(dispatcher Dispatcher) *mcp.Server {
	if dispatcher == nil {
		dispatcher = unavailableDispatcher{}
	}
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "gh-stack-mcp",
		Version: "0.1.0",
	}, nil)
	registerTools(server, dispatcher)
	return server
}

func registerTools(server *mcp.Server, dispatcher Dispatcher) {
	definitions := []toolDefinition{
		{
			name:        "stack_view",
			description: "Reads local Stack tracking and may refresh local metadata; this is not a remote Stack listing and does not list remote Stack objects.",
			inputSchema: targetSchema(nil, nil, nil),
		},
		{
			name:        "stack_init",
			description: "Creates local Stack tracking for the explicit trunk and ordered branches, and may fetch a missing trunk from the selected remote.",
			inputSchema: targetSchema(
				[]string{"trunk", "branches"},
				map[string]any{
					"trunk":    stringField("Existing Git branch to use as the Stack trunk."),
					"branches": stringArrayField("Branches to add in bottom-to-top order.", 1),
				},
				nil,
			),
		},
		{
			name:        "stack_add",
			description: "May stage selected changes and create a commit; the caller-selected staging scope and message determine which local changes are affected.",
			inputSchema: addInputSchema(),
		},
		{
			name:        "stack_checkout",
			description: "Changes the worktree's checked-out branch and may update local tracking for the selected branch.",
			inputSchema: targetSchema(
				[]string{"branch"},
				map[string]any{"branch": stringField("Explicit local branch name to check out.")},
				nil,
			),
		},
		{
			name:        "stack_rebase",
			description: "Rewrites local branch history for the selected Stack scope; a conflict can leave a pending rebase requiring typed continuation.",
			inputSchema: targetSchema(
				[]string{"action"},
				map[string]any{
					"action": enumField("Start a scoped Stack rebase or continue a validated pending rebase.", "start", "continue"),
					"scope":  enumField("Required for start: full, upstack, downstack, or noTrunk.", "full", "upstack", "downstack", "noTrunk"),
				},
				map[string]any{"allOf": []any{
					map[string]any{
						"if": map[string]any{
							"properties": map[string]any{"action": map[string]any{"const": "start"}},
							"required":   []string{"action"},
						},
						"then": map[string]any{"required": []string{"scope"}},
					},
					map[string]any{
						"if": map[string]any{
							"properties": map[string]any{"action": map[string]any{"const": "continue"}},
							"required":   []string{"action"},
						},
						"then": map[string]any{"not": map[string]any{"required": []string{"scope"}}},
					},
				}},
			),
		},
		{
			name:        "stack_sync",
			description: "Fetches and reconciles local Stack state with the selected remote; prune=true may remove merged local branches.",
			inputSchema: targetSchema(
				nil,
				map[string]any{"prune": boolField("Opt in to pruning merged local branches.", false)},
				nil,
			),
		},
		{
			name:        "stack_push",
			description: "Publishes Stack branches to the selected remote; a multi-branch push can partially succeed.",
			inputSchema: targetSchema(nil, nil, nil),
		},
		{
			name:        "stack_submit",
			description: "Creates or updates pull requests on the selected remote; open=true can mark affected pull requests ready for review.",
			inputSchema: targetSchema(
				nil,
				map[string]any{"open": boolField("Opt in to marking affected pull requests ready for review.", false)},
				nil,
			),
		},
		{
			name:        "stack_link",
			description: "Changes pull-request base and grouping for the ordered branches; open=true can mark affected pull requests ready for review.",
			inputSchema: targetSchema(
				[]string{"branches"},
				map[string]any{
					"branches": stringArrayField("At least two branches in the requested order.", 2),
					"base":     stringField("Optional explicit base branch for the first linked branch."),
					"open":     boolField("Opt in to marking affected pull requests ready for review.", false),
				},
				nil,
			),
		},
		{
			name:        "stack_unstack",
			description: "Removes grouping for the explicitly numbered Stack; localOnly leaves remote grouping unchanged, and this operation does not delete pull requests or branches.",
			inputSchema: targetSchema(
				[]string{"stackNumber", "mode"},
				map[string]any{
					"stackNumber": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"description": "Positive number of the Stack to unstack.",
					},
					"mode": enumField("Remove remote and local grouping or remove local grouping only.", "remoteAndLocal", "localOnly"),
				},
				nil,
			),
		},
	}

	registerTypedTool[ViewInput](server, dispatcher, definitions[0], "stack_view")
	registerTypedTool[InitInput](server, dispatcher, definitions[1], "stack_init")
	registerTypedTool[AddInput](server, dispatcher, definitions[2], "stack_add")
	registerTypedTool[CheckoutInput](server, dispatcher, definitions[3], "stack_checkout")
	registerTypedTool[RebaseInput](server, dispatcher, definitions[4], "stack_rebase")
	registerTypedTool[SyncInput](server, dispatcher, definitions[5], "stack_sync")
	registerTypedTool[PushInput](server, dispatcher, definitions[6], "stack_push")
	registerTypedTool[SubmitInput](server, dispatcher, definitions[7], "stack_submit")
	registerTypedTool[LinkInput](server, dispatcher, definitions[8], "stack_link")
	registerTypedTool[UnstackInput](server, dispatcher, definitions[9], "stack_unstack")
}

func registerTypedTool[Input any](server *mcp.Server, dispatcher Dispatcher, definition toolDefinition, expectedName string) {
	if definition.name != expectedName {
		panic(fmt.Sprintf("tool definition order mismatch: got %q, want %q", definition.name, expectedName))
	}
	destructive := definition.name != "stack_view"
	openWorld := true
	mcp.AddTool(server, &mcp.Tool{
		Name:        definition.name,
		Description: definition.description,
		InputSchema: definition.inputSchema,
		OutputSchema: map[string]any{
			"type":                 "object",
			"additionalProperties": false,
			"properties": map[string]any{
				"operation":  map[string]any{"type": "string", "enum": []string{definition.name}},
				"repository": map[string]any{"type": "string"},
				"spawned":    map[string]any{"type": "boolean"},
				"exitCode":   map[string]any{"type": "integer"},
				"status": map[string]any{
					"type": "string",
					"enum": []OutcomeStatus{
						OutcomeRejected,
						OutcomeLocalObservation,
						OutcomeExitedUnverified,
						OutcomeConflictPending,
						OutcomeTimedOutUnknown,
						OutcomeCleanupUnknown,
					},
				},
				"stdout":    map[string]any{"type": "string"},
				"stderr":    map[string]any{"type": "string"},
				"truncated": map[string]any{"type": "boolean"},
			},
			"required": []string{"operation", "repository", "spawned", "status", "stdout", "stderr", "truncated"},
		},
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    false,
			OpenWorldHint:   &openWorld,
			IdempotentHint:  false,
			DestructiveHint: &destructive,
		},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, input Input) (*mcp.CallToolResult, Outcome, error) {
		outcome, err := dispatcher.Dispatch(ctx, definition.name, input)
		if err != nil {
			return nil, Outcome{}, err
		}
		if outcome.Operation != definition.name {
			return nil, Outcome{}, fmt.Errorf("dispatcher returned operation %q for %q", outcome.Operation, definition.name)
		}
		return nil, outcome, nil
	})
}

func targetSchema(required []string, extraProperties map[string]any, constraints map[string]any) map[string]any {
	properties := map[string]any{
		"path":   stringField("Absolute path to the Git worktree for this operation."),
		"remote": stringField("Git remote name identifying the target repository."),
	}
	for name, schema := range extraProperties {
		properties[name] = schema
	}
	allRequired := []string{"path", "remote"}
	allRequired = append(allRequired, required...)
	schema := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"required":             allRequired,
		"additionalProperties": false,
	}
	for name, value := range constraints {
		schema[name] = value
	}
	return schema
}

func addInputSchema() map[string]any {
	return targetSchema(
		nil,
		map[string]any{
			"branch":  stringField("Explicit branch to add; required unless a commit-creation staging mode and message are supplied."),
			"stage":   enumFieldWithDefault("Select no staging, the index, tracked changes, or all changes.", "none", "none", "index", "tracked", "all"),
			"message": stringField("Explicit commit message when a staging mode creates a commit."),
		},
		map[string]any{
			"anyOf": []any{
				map[string]any{"required": []string{"branch"}},
				map[string]any{
					"required":   []string{"stage", "message"},
					"properties": map[string]any{"stage": map[string]any{"enum": []string{"index", "tracked", "all"}}},
				},
			},
			"allOf": []any{
				map[string]any{
					"if": map[string]any{
						"properties": map[string]any{"stage": map[string]any{"enum": []string{"index", "tracked", "all"}}},
						"required":   []string{"stage"},
					},
					"then": map[string]any{"required": []string{"message"}},
				},
			},
		},
	)
}

func stringField(description string) map[string]any {
	return map[string]any{"type": "string", "minLength": 1, "description": description}
}

func enumField(description string, values ...string) map[string]any {
	return map[string]any{"type": "string", "enum": values, "description": description}
}

func enumFieldWithDefault(description, defaultValue string, values ...string) map[string]any {
	return map[string]any{
		"type":        "string",
		"enum":        values,
		"default":     defaultValue,
		"description": description,
	}
}

func boolField(description string, defaultValue bool) map[string]any {
	return map[string]any{
		"type":        "boolean",
		"default":     defaultValue,
		"description": description,
	}
}

func stringArrayField(description string, minimum int) map[string]any {
	return map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "string", "minLength": 1},
		"minItems":    minimum,
		"description": description,
	}
}
