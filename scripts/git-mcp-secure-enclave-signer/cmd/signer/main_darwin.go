//go:build darwin

package main

import (
	"os"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/signer"
)

func main() {
	if err := signer.RunPublic(os.Args[1:]); err != nil {
		signer.ReportError(err)
		os.Exit(signer.ExitCode(err))
	}
}
