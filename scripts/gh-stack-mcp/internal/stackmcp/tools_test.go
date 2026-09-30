package stackmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const fixtureRoleEnv = "GH_STACK_MCP_TEST_ROLE"

var wantToolNames = []string{
	"stack_add",
	"stack_checkout",
	"stack_init",
	"stack_link",
	"stack_push",
	"stack_rebase",
	"stack_submit",
	"stack_sync",
	"stack_unstack",
	"stack_view",
}

func TestMain(m *testing.M) {
	switch os.Getenv(fixtureRoleEnv) {
	case "server":
		err := newServer(fakeProcessDispatcher{}).Run(context.Background(), &mcp.StdioTransport{})
		if err != nil {
			fmt.Fprintf(os.Stderr, "fixture server: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	case "extension":
		os.Exit(runFakeExtension())
	default:
		os.Exit(m.Run())
	}
}

func TestToolCatalogOverStdio(t *testing.T) {
	fixture := startFixtureClient(t)
	listed, err := fixture.session.ListTools(fixture.ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("ListTools over stdio: %v", err)
	}
	if len(listed.Tools) != len(wantToolNames) {
		t.Fatalf("ListTools returned %d tools, want %d: %v", len(listed.Tools), len(wantToolNames), toolNames(listed.Tools))
	}

	byName := make(map[string]*mcp.Tool, len(listed.Tools))
	for _, tool := range listed.Tools {
		byName[tool.Name] = tool
	}
	if got := toolNames(listed.Tools); !slices.Equal(got, wantToolNames) {
		t.Fatalf("tool names = %v, want exactly %v", got, wantToolNames)
	}

	for _, name := range wantToolNames {
		tool := byName[name]
		if tool == nil {
			t.Fatalf("tool %q is missing", name)
		}
		if tool.Description == "" {
			t.Errorf("tool %q has no side-effect description", name)
		}
		if tool.Annotations == nil {
			t.Errorf("tool %q has no annotations", name)
			continue
		}
		if tool.Annotations.ReadOnlyHint {
			t.Errorf("tool %q is marked read-only", name)
		}
		if tool.Annotations.OpenWorldHint == nil || !*tool.Annotations.OpenWorldHint {
			t.Errorf("tool %q must have openWorldHint=true", name)
		}
		if tool.Annotations.IdempotentHint {
			t.Errorf("tool %q must have idempotentHint=false", name)
		}
		wantDestructive := name != "stack_view"
		if tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint != wantDestructive {
			t.Errorf("tool %q destructiveHint = %v, want %t", name, tool.Annotations.DestructiveHint, wantDestructive)
		}

		inputSchema := schemaObject(t, tool.InputSchema)
		if inputSchema["additionalProperties"] != false {
			t.Errorf("tool %q input schema is not closed: additionalProperties=%v", name, inputSchema["additionalProperties"])
		}
		properties, ok := inputSchema["properties"].(map[string]any)
		if !ok {
			t.Errorf("tool %q has no object properties", name)
			continue
		}
		for _, common := range []string{"path", "remote"} {
			if _, ok := properties[common]; !ok {
				t.Errorf("tool %q is missing common input %q", name, common)
			}
			if !schemaRequires(inputSchema, common) {
				t.Errorf("tool %q does not require common input %q", name, common)
			}
		}

		outputSchema := schemaObject(t, tool.OutputSchema)
		if inputSchema["type"] != "object" || outputSchema["type"] != "object" {
			t.Errorf("tool %q input/output schemas must be objects", name)
		}
		if outputSchema["additionalProperties"] != false {
			t.Errorf("tool %q output schema is not closed: additionalProperties=%v", name, outputSchema["additionalProperties"])
		}
	}

	view := byName["stack_view"]
	viewDescription := strings.ToLower(view.Description)
	for _, phrase := range []string{"refresh", "local metadata", "not a remote stack listing"} {
		if !strings.Contains(viewDescription, phrase) {
			t.Errorf("stack_view description %q does not disclose %q", view.Description, phrase)
		}
	}

	assertSchemaEnum(t, byName["stack_add"].InputSchema, "stage", []string{"all", "index", "none", "tracked"})
	assertSchemaEnum(t, byName["stack_rebase"].InputSchema, "action", []string{"continue", "start"})
	assertSchemaEnum(t, byName["stack_rebase"].InputSchema, "scope", []string{"downstack", "full", "noTrunk", "upstack"})
	assertSchemaEnum(t, byName["stack_unstack"].InputSchema, "mode", []string{"localOnly", "remoteAndLocal"})
	assertArrayMinimum(t, byName["stack_init"].InputSchema, "branches", 1)
	assertArrayMinimum(t, byName["stack_link"].InputSchema, "branches", 2)
	assertNumberMinimum(t, byName["stack_unstack"].InputSchema, "stackNumber", 1)
}

func TestTypedToolsDispatchOverStdioAndCaptureChildOutput(t *testing.T) {
	fixture := startFixtureClient(t)
	cases := []struct {
		name string
		args map[string]any
	}{
		{"stack_view", map[string]any{}},
		{"stack_init", map[string]any{"trunk": "main", "branches": []string{"feature/a"}}},
		{"stack_add", map[string]any{"branch": "feature/a", "stage": "none"}},
		{"stack_checkout", map[string]any{"branch": "feature/a"}},
		{"stack_rebase", map[string]any{"action": "start", "scope": "full"}},
		{"stack_sync", map[string]any{"prune": false}},
		{"stack_push", map[string]any{}},
		{"stack_submit", map[string]any{"open": false}},
		{"stack_link", map[string]any{"branches": []string{"feature/a", "feature/b"}, "open": false}},
		{"stack_unstack", map[string]any{"stackNumber": 1, "mode": "localOnly"}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			args := map[string]any{
				"path":   "/tmp/gh-stack-mcp-fixture",
				"remote": "origin",
			}
			for key, value := range testCase.args {
				args[key] = value
			}
			result, err := fixture.session.CallTool(fixture.ctx, &mcp.CallToolParams{
				Name:      testCase.name,
				Arguments: args,
			})
			if err != nil {
				t.Fatalf("CallTool(%s): %v", testCase.name, err)
			}
			if result.IsError {
				t.Fatalf("CallTool(%s) returned an error: %v", testCase.name, result.Content)
			}
			var got Outcome
			decodeStructuredContent(t, result.StructuredContent, &got)
			if got.Operation != testCase.name || got.Status != "exited_unverified" || !got.Spawned {
				t.Errorf("tool output = %+v, want dispatched unverified fake-extension outcome", got)
			}
			if !strings.Contains(got.Stdout, "FAKE_EXTENSION_STDOUT:"+testCase.name) {
				t.Errorf("tool output did not capture fake child stdout: %q", got.Stdout)
			}
			if !strings.Contains(got.Stderr, "FAKE_EXTENSION_STDERR:"+testCase.name) {
				t.Errorf("tool output did not capture fake child stderr: %q", got.Stderr)
			}
		})
	}
}

func TestUnknownFieldsAreRejectedBeforeDispatch(t *testing.T) {
	fixture := startFixtureClient(t)
	result, err := fixture.session.CallTool(fixture.ctx, &mcp.CallToolParams{
		Name: "stack_view",
		Arguments: map[string]any{
			"path":        "/tmp/gh-stack-mcp-fixture",
			"remote":      "origin",
			"shell":       "echo unsafe",
			"passthrough": []string{"--force"},
		},
	})
	if err != nil {
		t.Fatalf("CallTool with an unknown field: %v", err)
	}
	if !result.IsError {
		t.Fatalf("unknown input fields were accepted: %+v", result)
	}
}

type fixtureClient struct {
	ctx     context.Context
	session *mcp.ClientSession
}

func startFixtureClient(t *testing.T) fixtureClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)

	var serverStderr bytes.Buffer
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^$")
	command.Env = setEnv(os.Environ(), fixtureRoleEnv, "server")
	command.Stderr = &serverStderr
	client := mcp.NewClient(&mcp.Implementation{Name: "gh-stack-mcp-fixture", Version: "test"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatalf("connect fixture client over stdio: %v; server stderr: %s", err, serverStderr.String())
	}
	t.Cleanup(func() {
		if err := session.Close(); err != nil {
			t.Errorf("close fixture session: %v; server stderr: %s", err, serverStderr.String())
		}
	})
	return fixtureClient{ctx: ctx, session: session}
}

type fakeProcessDispatcher struct{}

func (fakeProcessDispatcher) Dispatch(ctx context.Context, operation string, input any) (Outcome, error) {
	request, err := json.Marshal(struct {
		Operation string `json:"operation"`
		Input     any    `json:"input"`
	}{Operation: operation, Input: input})
	if err != nil {
		return Outcome{}, fmt.Errorf("marshal fake extension request: %w", err)
	}

	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^$")
	command.Env = setEnv(os.Environ(), fixtureRoleEnv, "extension")
	command.Stdin = bytes.NewReader(request)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return Outcome{}, fmt.Errorf("run fake extension: %w; stderr: %s", err, stderr.String())
	}
	code := 0
	return Outcome{
		Operation:  operation,
		Repository: "fixture/repo",
		Spawned:    true,
		ExitCode:   &code,
		Status:     "exited_unverified",
		Stdout:     strings.TrimSpace(stdout.String()),
		Stderr:     strings.TrimSpace(stderr.String()),
	}, nil
}

func runFakeExtension() int {
	var request struct {
		Operation string          `json:"operation"`
		Input     json.RawMessage `json:"input"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&request); err != nil {
		fmt.Fprintf(os.Stderr, "invalid fake extension request: %v\n", err)
		return 2
	}
	if !slices.Contains(wantToolNames, request.Operation) {
		fmt.Fprintf(os.Stderr, "unexpected fake extension operation %q\n", request.Operation)
		return 2
	}
	var input struct {
		Path   string `json:"path"`
		Remote string `json:"remote"`
	}
	if err := json.Unmarshal(request.Input, &input); err != nil {
		fmt.Fprintf(os.Stderr, "invalid typed fake extension input: %v\n", err)
		return 2
	}
	fmt.Fprintf(os.Stdout, "FAKE_EXTENSION_STDOUT:%s path=%s remote=%s\n", request.Operation, input.Path, input.Remote)
	fmt.Fprintf(os.Stderr, "FAKE_EXTENSION_STDERR:%s controlled fixture diagnostic\n", request.Operation)
	return 0
}

func setEnv(env []string, name, value string) []string {
	key := name + "="
	filtered := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, key) {
			filtered = append(filtered, entry)
		}
	}
	return append(filtered, key+value)
}

func toolNames(tools []*mcp.Tool) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names)
	return names
}

func schemaObject(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal schema: %v", err)
	}
	var schema map[string]any
	if err := json.Unmarshal(encoded, &schema); err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	return schema
}

func schemaRequires(schema map[string]any, property string) bool {
	required, ok := schema["required"].([]any)
	if !ok {
		return false
	}
	for _, value := range required {
		if value == property {
			return true
		}
	}
	return false
}

func assertSchemaEnum(t *testing.T, rawSchema any, property string, want []string) {
	t.Helper()
	schema := schemaObject(t, rawSchema)
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("schema has no properties: %v", schema)
	}
	propertySchema, ok := properties[property].(map[string]any)
	if !ok {
		t.Fatalf("schema property %q is missing or invalid", property)
	}
	values, ok := propertySchema["enum"].([]any)
	if !ok {
		t.Fatalf("schema property %q has no enum: %v", property, propertySchema)
	}
	got := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := value.(string)
		if !ok {
			t.Fatalf("schema property %q enum contains non-string %T", property, value)
		}
		got = append(got, text)
	}
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Errorf("schema property %q enum = %v, want %v", property, got, want)
	}
}

func assertArrayMinimum(t *testing.T, rawSchema any, property string, want float64) {
	t.Helper()
	propertySchema := schemaProperty(t, rawSchema, property)
	if propertySchema["type"] != "array" || propertySchema["minItems"] != want {
		t.Errorf("schema property %q = %v, want array with minItems=%v", property, propertySchema, want)
	}
}

func assertNumberMinimum(t *testing.T, rawSchema any, property string, want float64) {
	t.Helper()
	propertySchema := schemaProperty(t, rawSchema, property)
	if propertySchema["type"] != "integer" || propertySchema["minimum"] != want {
		t.Errorf("schema property %q = %v, want integer with minimum=%v", property, propertySchema, want)
	}
}

func schemaProperty(t *testing.T, rawSchema any, property string) map[string]any {
	t.Helper()
	schema := schemaObject(t, rawSchema)
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("schema has no properties: %v", schema)
	}
	propertySchema, ok := properties[property].(map[string]any)
	if !ok {
		t.Fatalf("schema property %q is missing or invalid", property)
	}
	return propertySchema
}

func decodeStructuredContent(t *testing.T, content any, target any) {
	t.Helper()
	encoded, err := json.Marshal(content)
	if err != nil {
		t.Fatalf("marshal structured content: %v", err)
	}
	if err := json.Unmarshal(encoded, target); err != nil {
		t.Fatalf("decode structured content: %v", err)
	}
}
