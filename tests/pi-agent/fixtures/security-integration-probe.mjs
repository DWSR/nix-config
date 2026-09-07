import fs from "node:fs";
import net from "node:net";

const [operation, ...operationArguments] = process.argv.slice(2);
const [value, portValue] =
  operation === "listen"
    ? [undefined, operationArguments[0]]
    : operationArguments;
const SYNTHETIC_PROVIDER_HOSTS = new Set([
  "provider.allowed.localhost",
  "provider.denied.localhost",
]);
const SANDBOX_DENIAL_CODES = new Set([
  "EACCES",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPERM",
]);

function report(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function reportFailure(kind, error, sideEffects = null) {
  const denied = SANDBOX_DENIAL_CODES.has(error?.code);
  report({
    code: error?.code ?? null,
    denied,
    kind,
    ok: false,
    sideEffects: denied ? sideEffects ?? [] : null,
  });
}

function snapshotFile(target) {
  try {
    const stat = fs.statSync(target);
    return {
      contents: stat.isFile() ? fs.readFileSync(target) : null,
      exists: true,
      type: stat.isFile() ? "file" : "other",
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, type: null, contents: null };
    throw error;
  }
}

function fileSideEffects(before, target) {
  const after = snapshotFile(target);
  return before.exists !== after.exists ||
      before.type !== after.type ||
      (before.contents === null
        ? after.contents !== null
        : after.contents === null || !before.contents.equals(after.contents))
    ? [target]
    : [];
}

function filesystemOperation(kind, target) {
  const before = kind === "write" ? snapshotFile(target) : null;
  try {
    if (kind === "read") fs.readFileSync(target, "utf8");
    else if (kind === "write") fs.writeFileSync(target, "security-probe\n");
    else if (kind === "list") fs.readdirSync(target);
    else throw new Error(`unknown filesystem operation: ${kind}`);
    report({ kind, ok: true });
  } catch (error) {
    reportFailure(kind, error, before === null ? [] : fileSideEffects(before, target));
  }
}

function networkOperation(kind, host, port) {
  const proxyValue =
    SYNTHETIC_PROVIDER_HOSTS.has(host) &&
    (process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY);
  if (proxyValue) {
    proxyOperation(kind, host, port, proxyValue);
    return;
  }

  const socket = new net.Socket();
  let settled = false;
  const finish = (ok, error) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    if (ok) report({ kind, ok: true });
    else reportFailure(kind, error);
  };

  socket.setTimeout(2_000, () => finish(false, { code: "TIMEOUT" }));
  socket.once("error", (error) => finish(false, error));
  socket.connect({
    host,
    lookup: SYNTHETIC_PROVIDER_HOSTS.has(host)
      ? (_hostname, _options, callback) => callback(null, "127.0.0.1", 4)
      : undefined,
    port,
  }, () => finish(true, null));
}

function proxyOperation(kind, host, port, proxyValue) {
  let proxy;
  try {
    proxy = new URL(proxyValue);
    if (proxy.protocol !== "http:" || proxy.hostname === "" || proxy.port === "") {
      throw new Error("invalid proxy");
    }
  } catch {
    reportFailure(kind, { code: "EINVAL" });
    return;
  }

  const socket = net.createConnection(Number(proxy.port), proxy.hostname);
  let response = "";
  let settled = false;
  const finish = (ok, error) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    if (ok) report({ kind, ok: true });
    else reportFailure(kind, error);
  };

  socket.setTimeout(2_000, () => finish(false, { code: "TIMEOUT" }));
  socket.once("error", (error) => finish(false, error));
  socket.once("connect", () => {
    const credentials =
      proxy.username === "" && proxy.password === ""
        ? ""
        : `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString("base64")}\r\n`;
    socket.write(
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${credentials}\r\n`,
    );
  });
  socket.on("data", (chunk) => {
    response += chunk.toString("latin1");
    const end = response.indexOf("\r\n\r\n");
    if (end === -1) return;
    const status = Number(response.slice(0, end).split("\r\n", 1)[0].split(" ")[1]);
    if (status === 200) finish(true, null);
    else finish(false, { code: "EPERM" });
  });
}

if (operation === "read" || operation === "write" || operation === "list") {
  filesystemOperation(operation, value);
} else if (operation === "connect") {
  networkOperation(operation, value, Number(portValue));
} else if (operation === "listen") {
  const server = net.createServer();
  server.once("error", (error) => {
    reportFailure(operation, error);
  });
  server.listen(Number(portValue), "127.0.0.1", () => {
    report({ kind: operation, ok: true });
    server.close();
  });
} else {
  reportFailure(operation ?? null, { code: "EINVAL" });
}
