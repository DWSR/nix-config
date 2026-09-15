#!/usr/bin/env node

'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

type FileStats = {
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

type SourceMetadata = {
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type SourceNote = {
  absolutePath: string;
  relativePath: string;
  bytes: Buffer;
  metadata: SourceMetadata;
};

type SourceIssue = {
  relativePath: string;
  reason: string;
};

type SourceDiscovery = {
  sourcePath: string;
  memoriesPath: string;
  discovered: number;
  notes: SourceNote[];
  skipped: SourceIssue[];
};

function fail(message: string): never {
  throw new Error(`agentmemory-import-obsidian: ${message}`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isContained(candidatePath: string, rootPath: string): boolean {
  const relativePath = nodePath.relative(rootPath, candidatePath);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${nodePath.sep}`)
    && !nodePath.isAbsolute(relativePath);
}

function relativeSourcePath(name: string): string {
  return nodePath.posix.join('memories', name);
}

function issueForSymlink(
  entryPath: string,
  relativePath: string,
  memoriesPath: string,
): SourceIssue {
  try {
    const linkTarget = nodeFs.readlinkSync(entryPath);
    const resolvedTarget = nodePath.isAbsolute(linkTarget)
      ? nodePath.normalize(linkTarget)
      : nodePath.resolve(memoriesPath, linkTarget);
    if (!isContained(resolvedTarget, memoriesPath)) {
      return { relativePath, reason: 'path escapes memories directory' };
    }
  } catch {
    // The entry is already known to be a symlink. Do not resolve or read it.
  }
  return { relativePath, reason: 'symlink' };
}

function sourceMetadata(stat: FileStats): SourceMetadata {
  return {
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

function readRegularSource(
  entryPath: string,
  relativePath: string,
  realMemoriesPath: string,
): SourceNote | SourceIssue {
  let entryStat: FileStats;
  try {
    entryStat = nodeFs.lstatSync(entryPath);
  } catch (error: unknown) {
    return {
      relativePath,
      reason: `cannot inspect source: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (entryStat.isSymbolicLink()) {
    return issueForSymlink(entryPath, relativePath, realMemoriesPath);
  }
  if (!entryStat.isFile()) {
    return { relativePath, reason: 'non-regular entry' };
  }

  let realPath: string;
  try {
    realPath = nodeFs.realpathSync(entryPath);
  } catch (error: unknown) {
    return {
      relativePath,
      reason: `cannot resolve source path: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isContained(realPath, realMemoriesPath)) {
    return { relativePath, reason: 'path escapes memories directory' };
  }

  try {
    const currentEntryStat = nodeFs.lstatSync(entryPath);
    if (currentEntryStat.isSymbolicLink()) {
      return issueForSymlink(entryPath, relativePath, realMemoriesPath);
    }
    if (!currentEntryStat.isFile()) {
      return { relativePath, reason: 'non-regular entry' };
    }

    const openFlags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0);
    const descriptor = nodeFs.openSync(realPath, openFlags);
    try {
      const openedStat = nodeFs.fstatSync(descriptor);
      if (!openedStat.isFile()) {
        return { relativePath, reason: 'non-regular entry' };
      }
      const bytes = nodeFs.readFileSync(descriptor);
      return {
        absolutePath: realPath,
        relativePath,
        bytes,
        metadata: sourceMetadata(openedStat),
      };
    } finally {
      nodeFs.closeSync(descriptor);
    }
  } catch (error: unknown) {
    return {
      relativePath,
      reason: `cannot read source: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function requireReadableDirectory(directoryPath: string, label: string): void {
  try {
    nodeFs.accessSync(directoryPath, nodeFs.constants.R_OK | nodeFs.constants.X_OK);
  } catch {
    fail(`${label} is not readable: ${directoryPath}`);
  }
}

function realDirectory(directoryPath: string, label: string): string {
  let stat: FileStats;
  try {
    stat = nodeFs.statSync(directoryPath);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      fail(`${label} does not exist: ${directoryPath}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      fail(`${label} is not readable: ${directoryPath}`);
    }
    fail(`cannot inspect ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isDirectory()) fail(`${label} is not a directory: ${directoryPath}`);
  requireReadableDirectory(directoryPath, label);

  try {
    return nodeFs.realpathSync(directoryPath);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      fail(`${label} does not exist: ${directoryPath}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      fail(`${label} is not readable: ${directoryPath}`);
    }
    fail(`cannot resolve ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateVaultRoot(vaultPath: string): string {
  if (typeof vaultPath !== 'string' || !nodePath.isAbsolute(vaultPath)) {
    fail('vault path must be absolute');
  }
  if (vaultPath.includes('\0')) fail('vault path contains a NUL byte');

  let rootStat: FileStats;
  try {
    rootStat = nodeFs.lstatSync(vaultPath);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') fail(`vault path does not exist: ${vaultPath}`);
    if (code === 'EACCES' || code === 'EPERM') fail(`vault path is not readable: ${vaultPath}`);
    fail(`cannot inspect vault path: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
    fail(`vault path is not a directory: ${vaultPath}`);
  }
  return realDirectory(vaultPath, 'vault path');
}

function listDirectMarkdownChildren(memoriesPath: string): string[] {
  try {
    return nodeFs.readdirSync(memoriesPath)
      .filter((name: string) => name.toLowerCase().endsWith('.md'))
      .sort();
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') {
      fail(`memories directory is not readable: ${memoriesPath}`);
    }
    fail(`cannot read memories directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function discoverSourceNotes(vaultPath: string): SourceDiscovery {
  const realVaultPath = validateVaultRoot(vaultPath);
  const requestedMemoriesPath = nodePath.join(realVaultPath, 'memories');
  const realMemoriesPath = realDirectory(requestedMemoriesPath, 'memories directory');
  if (!isContained(realMemoriesPath, realVaultPath)) {
    fail(`memories directory escapes vault path: ${requestedMemoriesPath}`);
  }

  const names = listDirectMarkdownChildren(realMemoriesPath);
  const notes: SourceNote[] = [];
  const skipped: SourceIssue[] = [];
  for (const name of names) {
    const relativePath = relativeSourcePath(name);
    const result = readRegularSource(
      nodePath.join(realMemoriesPath, name),
      relativePath,
      realMemoriesPath,
    );
    if ('bytes' in result) notes.push(result);
    else skipped.push(result);
  }

  return {
    sourcePath: realVaultPath,
    memoriesPath: realMemoriesPath,
    discovered: names.length,
    notes,
    skipped,
  };
}

module.exports = {
  discoverSourceNotes,
  isContained,
};
