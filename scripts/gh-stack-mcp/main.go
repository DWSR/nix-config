package main

import (
	"context"
	"fmt"
	"os"

	"github.com/brandonmcnama/gh-stack-mcp/internal/stackmcp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	server, err := stackmcp.NewServer()
	if err != nil {
		fmt.Fprintf(os.Stderr, "gh-stack-mcp: %v\n", err)
		os.Exit(1)
	}
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		fmt.Fprintf(os.Stderr, "gh-stack-mcp: %v\n", err)
		os.Exit(1)
	}
}
