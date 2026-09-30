package main

import (
	"context"
	"fmt"
	"os"

	"github.com/brandonmcnama/gh-stack-mcp/internal/stackmcp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	server := stackmcp.NewServer()
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		fmt.Fprintf(os.Stderr, "gh-stack-mcp: %v\n", err)
		os.Exit(1)
	}
}
