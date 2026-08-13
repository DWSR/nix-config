"use strict";

let buffer = Buffer.alloc(0);
let rootUri = null;
let readyRequestId = 1000;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sourceUri() {
  return new URL("source.ts", `${rootUri.endsWith("/") ? rootUri : `${rootUri}/`}`).href;
}

function implementationUri() {
  return new URL("implementation.ts", `${rootUri.endsWith("/") ? rootUri : `${rootUri}/`}`).href;
}

function workspaceUri(relative) {
  return new URL(relative, `${rootUri.endsWith("/") ? rootUri : `${rootUri}/`}`).href;
}

function location(uri, line, character, length = 5) {
  return {
    uri,
    range: {
      start: { line, character },
      end: { line, character: character + length },
    },
  };
}

function diagnostics(uri) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: [
        {
          range: {
            start: { line: 4, character: 22 },
            end: { line: 4, character: 27 },
          },
          severity: 2,
          source: "managed-fixture-lsp",
          message: "Known managed fixture diagnostic",
        },
      ],
    },
  });
}

function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    rootUri = params.rootUri;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          implementationProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          renameProvider: true,
          codeActionProvider: true,
        },
      },
    });
    return;
  }
  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }
  if (method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        contents: { kind: "markdown", value: "`greet(name: string): string`" },
        range: {
          start: { line: 4, character: 22 },
          end: { line: 4, character: 27 },
        },
      },
    });
    return;
  }
  if (method === "textDocument/definition") {
    send({ jsonrpc: "2.0", id, result: location(sourceUri(), 0, 16) });
    return;
  }
  if (method === "textDocument/references") {
    send({
      jsonrpc: "2.0",
      id,
      result: [location(sourceUri(), 0, 16), location(sourceUri(), 4, 22)],
    });
    return;
  }
  if (method === "textDocument/implementation") {
    send({ jsonrpc: "2.0", id, result: [location(implementationUri(), 0, 13, 7)] });
    return;
  }
  if (method === "textDocument/documentSymbol") {
    send({
      jsonrpc: "2.0",
      id,
      result: [
        {
          name: "greet",
          kind: 12,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 2, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 16 },
            end: { line: 0, character: 21 },
          },
        },
      ],
    });
    return;
  }
  if (method === "workspace/symbol") {
    if (params.query === "fixture-null-response") {
      send({ jsonrpc: "2.0", id, result: null });
      return;
    }
    if (params.query === "fixture-non-file-location") {
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            name: "TASK_4_8_NON_FILE_LOCATION_SENTINEL",
            kind: 12,
            location: location("https://TASK_4_8_NON_FILE_LOCATION_SENTINEL.invalid/source.ts", 0, 0),
          },
        ],
      });
      return;
    }
    if (params.query === "fixture-server-error") {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message: "TASK_4_8_SERVER_ERROR_SENTINEL",
          data: "TASK_4_8_SERVER_ERROR_DATA_SENTINEL",
        },
      });
      return;
    }
    if (params.query === "fixture-malformed-response") {
      send({
        jsonrpc: "2.0",
        id,
        result: { value: "TASK_4_8_MALFORMED_RESPONSE_SENTINEL" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: [
        {
          name: "greet",
          kind: 12,
          location: location(sourceUri(), 0, 16),
          containerName: "source",
        },
      ],
    });
    return;
  }
  if (method === "textDocument/rename") {
    const uri = sourceUri();
    const edits = [
      {
        range: {
          start: { line: 0, character: 16 },
          end: { line: 0, character: 21 },
        },
        newText: params.newName,
      },
      {
        range: {
          start: { line: 4, character: 22 },
          end: { line: 4, character: 27 },
        },
        newText: params.newName,
      },
    ];
    let result = { changes: { [uri]: edits } };
    if (params.newName === "documentChanges") {
      result = {
        documentChanges: [{ textDocument: { uri, version: 1 }, edits }],
      };
    } else if (params.newName === "mixedEncodings") {
      result = {
        changes: { [uri]: edits },
        documentChanges: [{ textDocument: { uri, version: null }, edits }],
      };
    } else if (params.newName === "resourceOperation") {
      result = {
        documentChanges: [
          { textDocument: { uri, version: null }, edits },
          { kind: "create", uri: workspaceUri("created.ts") },
        ],
      };
    } else if (params.newName === "annotatedEdit") {
      result = {
        changes: {
          [uri]: edits.map((edit) => ({ ...edit, annotationId: "managed-annotation" })),
        },
        changeAnnotations: {
          "managed-annotation": { label: "TASK_4_8_ANNOTATION_SENTINEL" },
        },
      };
    } else if (params.newName === "multipleFiles") {
      result = {
        changes: {
          [uri]: edits,
          [implementationUri()]: [
            {
              range: {
                start: { line: 0, character: 13 },
                end: { line: 0, character: 20 },
              },
              newText: params.newName,
            },
          ],
        },
      };
    } else if (params.newName === "emptySecondFile") {
      result = { changes: { [uri]: edits, [implementationUri()]: [] } };
    } else if (params.newName === "malformedEdit") {
      result = { changes: { [uri]: [edits[0], { newText: params.newName }] } };
    } else if (params.newName === "outsideTraversal") {
      result = { changes: { [workspaceUri("../outside.ts")]: [edits[0]] } };
    } else if (params.newName === "outsideSymlinkParent") {
      result = { changes: { [workspaceUri("escape/outside.ts")]: [edits[0]] } };
    } else if (params.newName === "insideSymlinkAlias") {
      result = { changes: { [workspaceUri("alias.ts")]: edits } };
    } else if (params.newName === "emptyQueryAlias") {
      result = { changes: { [`${uri}?`]: edits } };
    } else if (params.newName === "queryAlias") {
      result = { changes: { [`${uri}?TASK_4_8_QUERY_ALIAS_SENTINEL`]: edits } };
    } else if (params.newName === "emptyFragmentAlias") {
      result = { changes: { [`${uri}#`]: edits } };
    } else if (params.newName === "fragmentAlias") {
      result = { changes: { [`${uri}#TASK_4_8_FRAGMENT_ALIAS_SENTINEL`]: edits } };
    }
    send({
      jsonrpc: "2.0",
      id,
      result,
    });
    return;
  }
  if (method === "textDocument/codeAction") {
    send({ jsonrpc: "2.0", id, result: [] });
    return;
  }
  send({ jsonrpc: "2.0", id, result: null });
}

function handleMessage(message) {
  if (Object.hasOwn(message, "id") && typeof message.method === "string") {
    handleRequest(message);
    return;
  }
  if (message.method === "initialized") {
    const token = "managed-fixture-ready";
    send({
      jsonrpc: "2.0",
      id: readyRequestId++,
      method: "window/workDoneProgress/create",
      params: { token },
    });
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token, value: { kind: "begin", title: "fixture index" } },
    });
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token, value: { kind: "end" } },
    });
    return;
  }
  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    const uri = message.params.textDocument.uri;
    diagnostics(uri);
    return;
  }
  if (message.method === "exit") process.exit(0);
}

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handleMessage(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
process.stdin.on("end", () => process.exit(0));
