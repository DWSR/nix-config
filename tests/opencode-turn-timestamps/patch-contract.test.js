'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const patchPath = path.join(repoRoot, 'overlays/opencode-turn-timestamps.patch');
const allowedTarget = 'packages/tui/src/routes/session/index.tsx';

const forbiddenTargets = [
  {
    label: 'session_schema_target',
    pattern: /(?:^|\/)(?:packages\/opencode\/src\/session\/(?:schema|storage|message|messages|index|system)|session[-_/]schema|schema\.(?:ts|tsx|js|jsx))(?:$|[./])/i,
  },
  { label: 'plugin_target', pattern: /(?:^|\/)(?:plugins?|plugin)(?:$|[./_-])/i },
  { label: 'tool_execution_target', pattern: /(?:^|\/)(?:tool|tools|tool-call|tool_call|toolcall)(?:$|[./_-])/i },
  { label: 'cavemem_target', pattern: /cavemem/i },
  { label: 'obsidian_target', pattern: /obsidian/i },
  { label: 'rtk_target', pattern: /(?:^|[./_-])rtk(?:$|[./_-])/i },
  { label: 'cost_diagnosis_target', pattern: /opencode-cost-diagnosis|cost[-_/]diagnosis/i },
  { label: 'mcpproxy_target', pattern: /mcpproxy|mcp[-_]proxy/i },
];

function contractFailure(label, detail) {
  return `[opencode-turn-timestamps: ${label}] ${detail}`;
}

function readPatch() {
  try {
    return fs.readFileSync(patchPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      assert.fail(
        contractFailure(
          'patch_missing',
          `expected timestamp patch at ${path.relative(repoRoot, patchPath)}`,
        ),
      );
    }
    throw error;
  }
}

function targetFiles(patch) {
  const targets = new Set();
  for (const line of patch.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      targets.add(diffMatch[1]);
      targets.add(diffMatch[2]);
      continue;
    }

    const fileMatch = line.match(/^(?:---|\+\+\+) (?:a|b)\/(.+)$/);
    if (fileMatch) {
      targets.add(fileMatch[1]);
    }
  }
  return [...targets].filter((target) => target !== '/dev/null').sort();
}

function additions(patch) {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

function removals(patch) {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    .map((line) => line.slice(1))
    .join('\n');
}

function sourceAfterPatch(patch) {
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) return line.slice(1);
      if (line.startsWith(' ')) return line.slice(1);
      return line;
    })
    .join('\n');
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

const formatterCallPattern = /(?:formatCreatedTime|turnTimestamp|createdTimestamp)\s*\(|Locale\.todayTimeOrDateTime\s*\(/;

function sharedFormatterName(source) {
  for (const name of ['formatCreatedTime', 'turnTimestamp', 'createdTimestamp']) {
    const declarationPattern = new RegExp(
      `(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=)[\\s\\S]{0,700}Locale\\.todayTimeOrDateTime\\s*\\(`,
    );
    if (declarationPattern.test(source)) return name;
  }
  return undefined;
}

function isSharedFormatterImplementation(lines, index, formatterName) {
  if (!formatterName) return false;

  const context = lines.slice(Math.max(0, index - 80), index + 1).join('\n');
  const declarationPattern = new RegExp(
    `(?:function\\s+${formatterName}\\s*\\(|(?:const|let)\\s+${formatterName}\\s*=)`,
  );
  return declarationPattern.test(context) && /Locale\.todayTimeOrDateTime\s*\(/.test(lines[index]);
}

function timestampRenderingSites(source, formatterName) {
  const lines = source.split('\n');
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => {
      if (!formatterCallPattern.test(line)) return false;
      if (isSharedFormatterImplementation(lines, index, formatterName)) return false;
      return !new RegExp(
        `(?:function\\s+${formatterName}\\s*\\(|(?:const|let)\\s+${formatterName}\\s*=)`,
      ).test(line);
    });
}

function sourceDepths(lines) {
  let depth = 0;
  return lines.map((line) => {
    const before = depth;
    const code = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
    depth += countMatches(code, /\{/g);
    depth -= countMatches(code, /\}/g);
    if (depth < 0) depth = 0;
    return before;
  });
}

function caseRolePattern(role) {
  return new RegExp(`^\\s*case\\s+["']${role}["']\\s*:`);
}

function anyCaseOrDefault(line) {
  return /^\s*(?:case\s+["'][^"']+["']\s*:|default\s*:)/.test(line);
}

function roleConditionPattern(role) {
  return new RegExp(
    `(?:message\\.role\\s*={2,3}\\s*["']${role}["']|["']${role}["']\\s*={2,3}\\s*message\\.role)`,
  );
}

function isWithinRoleCaseBranch(lines, depths, index, role) {
  for (let i = index; i >= 0; i -= 1) {
    if (!anyCaseOrDefault(lines[i])) continue;

    const caseDepth = depths[i];
    for (let j = i + 1; j <= index; j += 1) {
      if (depths[j] < caseDepth) return false;
      if (j < index && depths[j] === caseDepth && anyCaseOrDefault(lines[j])) return false;
    }

    return caseRolePattern(role).test(lines[i]);
  }

  return false;
}

function isWithinRoleConditionBlock(lines, depths, index, role) {
  const roleCondition = roleConditionPattern(role);

  for (let i = index; i >= 0; i -= 1) {
    if (!roleCondition.test(lines[i])) continue;
    if (i === index) return true;
    if (!lines[i].includes('{')) continue;
    if (depths[index] <= depths[i]) continue;

    let branchClosed = false;
    for (let j = i + 1; j <= index; j += 1) {
      if (depths[j] <= depths[i]) {
        branchClosed = true;
        break;
      }
    }
    if (!branchClosed) return true;
  }

  return false;
}

function roleScopedRenderingSites(source, role, formatterName) {
  const lines = source.split('\n');
  const depths = sourceDepths(lines);

  return timestampRenderingSites(source, formatterName).filter(({ index }) => {
    return (
      isWithinRoleCaseBranch(lines, depths, index, role) ||
      isWithinRoleConditionBlock(lines, depths, index, role)
    );
  });
}

test('RoleScopeFixture accepts timestamp rendering structurally contained in role branches', () => {
  const source = `
function formatCreatedTime(message) {
  return message.time.created ? Locale.todayTimeOrDateTime(message.time.created) : undefined;
}

switch (message.role) {
  case "user": {
    const timestamp = formatCreatedTime(message);
    return <UserMessage timestamp={timestamp} message={message} />;
  }
  case "assistant": {
    const timestamp = formatCreatedTime(message);
    return <AssistantMessage timestamp={timestamp} message={message} />;
  }
  default:
    return <OtherMessage message={message} />;
}
`;
  const formatterName = sharedFormatterName(source);

  assert.equal(roleScopedRenderingSites(source, 'user', formatterName).length, 1);
  assert.equal(roleScopedRenderingSites(source, 'assistant', formatterName).length, 1);
});

test('RoleScopeFixture rejects generic all-role timestamp rendering near role branches', () => {
  const source = `
function formatCreatedTime(message) {
  return message.time.created ? Locale.todayTimeOrDateTime(message.time.created) : undefined;
}

switch (message.role) {
  case "user":
    return <UserMessage message={message} />;
  case "assistant":
    return <AssistantMessage message={message} />;
  default:
    return <OtherMessage message={message} />;
}

const timestamp = formatCreatedTime(message);
return <TranscriptRow timestamp={timestamp} message={message} />;
`;
  const formatterName = sharedFormatterName(source);
  const renderingSites = timestampRenderingSites(source, formatterName);
  const scopedSites = [
    ...roleScopedRenderingSites(source, 'user', formatterName),
    ...roleScopedRenderingSites(source, 'assistant', formatterName),
  ];

  assert.equal(renderingSites.length, 1);
  assert.equal(scopedSites.length, 0);
});

test('patch file exists as timestamp contract source', () => {
  assert.ok(
    fs.existsSync(patchPath),
    contractFailure(
      'patch_missing',
      `expected timestamp patch at ${path.relative(repoRoot, patchPath)}`,
    ),
  );
});

test('PatchBoundaryGuard limits modifications to the live TUI session route', () => {
  const patch = readPatch();
  const targets = targetFiles(patch);

  assert.deepEqual(
    targets,
    [allowedTarget],
    contractFailure(
      'boundary_invalid',
      `patch targets must be exactly ${allowedTarget}; saw ${targets.join(', ') || '<none>'}`,
    ),
  );
});

test('PatchBoundaryGuard rejects adjacent subsystem targets', () => {
  const patch = readPatch();
  const targets = targetFiles(patch);
  const forbidden = [];

  for (const target of targets) {
    if (target === allowedTarget) continue;
    for (const check of forbiddenTargets) {
      if (check.pattern.test(target)) {
        forbidden.push(`${check.label}:${target}`);
      }
    }
  }

  assert.deepEqual(
    forbidden,
    [],
    contractFailure(
      'forbidden_target',
      `patch must not target session schemas, plugins, tool execution, cavemem, Obsidian, RTK, cost-diagnosis, or mcpproxy paths; saw ${forbidden.join(', ')}`,
    ),
  );
});

test('TimestampVerificationSuite requires a visible timestamp default and toggle surface', () => {
  const patchedSource = sourceAfterPatch(readPatch());

  assert.match(
    patchedSource,
    /(?:timestamp|timestamps)[\w.-]*(?:key|Key)|(?:key|Key)[\w.-]*(?:timestamp|timestamps)/,
    contractFailure('visible_default_missing', 'expected a feature-owned timestamp state key'),
  );
  assert.match(
    patchedSource,
    /(?:default|fallback|initial)[\s\S]{0,120}["']show["']|["']show["'][\s\S]{0,120}(?:default|fallback|initial)/,
    contractFailure('visible_default_missing', 'expected timestamp visibility to default to show'),
  );
  assert.match(
    patchedSource,
    /session\.toggle\.timestamps|toggle-timestamps|\/timestamps/,
    contractFailure('visible_default_missing', 'expected existing timestamp toggle surface to remain present'),
  );
});

test('TimestampVerificationSuite requires user and assistant timestamp rendering', () => {
  const patchedSource = sourceAfterPatch(readPatch());

  assert.match(
    patchedSource,
    /(?:role\s*[=:]\s*["']user["']|message\.role\s*={2,3}\s*["']user["']|case\s+["']user["'])[\s\S]{0,700}(?:showTimestamps|formatCreatedTime|todayTimeOrDateTime|turnTimestamp|timestamp)/i,
    contractFailure('user_timestamp_missing', 'expected user turn timestamp rendering'),
  );
  assert.match(
    patchedSource,
    /(?:role\s*[=:]\s*["']assistant["']|message\.role\s*={2,3}\s*["']assistant["']|case\s+["']assistant["'])[\s\S]{0,900}(?:showTimestamps|formatCreatedTime|todayTimeOrDateTime|turnTimestamp|timestamp)/i,
    contractFailure('assistant_timestamp_missing', 'expected assistant turn timestamp rendering'),
  );
});

test('TimestampVerificationSuite requires assistant timestamps to use creation time', () => {
  const patchedSource = sourceAfterPatch(readPatch());

  assert.match(
    patchedSource,
    /(?:assistant|Assistant)[\s\S]{0,900}(?:time\.created|\.created)|(?:time\.created|\.created)[\s\S]{0,900}(?:assistant|Assistant)/,
    contractFailure('assistant_creation_time_missing', 'expected assistant timestamp rendering from time.created'),
  );
  assert.doesNotMatch(
    additions(readPatch()),
    /(?:assistant|Assistant)[\s\S]{0,500}(?:time\.completed|\.completed)[\s\S]{0,500}(?:todayTimeOrDateTime|formatCreatedTime|turnTimestamp|timestamp)/,
    contractFailure('assistant_creation_time_missing', 'assistant timestamp must not be based on completion time'),
  );
});

test('TimestampVerificationSuite requires message text preservation', () => {
  const patch = readPatch();
  const added = additions(patch);
  const removed = removals(patch);

  assert.match(
    sourceAfterPatch(patch),
    /(?:message\.text|message\.parts|part\.text|text\(\)|children)/,
    contractFailure('message_text_preservation_missing', 'expected original message text rendering path to remain visible in patched source'),
  );
  assert.doesNotMatch(
    added,
    /(?:content|text|parts)\s*[:=]\s*(?:`[^`]*(?:timestamp|turnTimestamp)|[^\n]*(?:timestamp|turnTimestamp)[^\n]*\+)|(?:timestamp|turnTimestamp)[^\n]*\+[^\n]*(?:content|text|parts)/i,
    contractFailure('message_text_preservation_missing', 'timestamp text must not be concatenated into message text/content'),
  );
  assert.doesNotMatch(
    removed,
    /(?:message\.text|message\.parts|part\.text)/,
    contractFailure('message_text_preservation_missing', 'patch must not remove existing message text rendering'),
  );
});

test('TurnTimestampFormatter uses the existing local-time formatter consistently', () => {
  const patchedSource = sourceAfterPatch(readPatch());
  const formatterUses = countMatches(patchedSource, /Locale\.todayTimeOrDateTime\s*\(/g);
  const formatterName = sharedFormatterName(patchedSource);

  assert.ok(
    formatterUses >= 1,
    contractFailure('formatter_missing', 'expected Locale.todayTimeOrDateTime usage'),
  );
  assert.ok(
    formatterName,
    contractFailure('formatter_inconsistent', 'expected one shared helper/value for user and assistant timestamp formatting'),
  );
  assert.equal(
    formatterUses,
    1,
    contractFailure('formatter_inconsistent', `expected only one direct Locale.todayTimeOrDateTime call inside the shared formatter; saw ${formatterUses}`),
  );
  assert.ok(
    roleScopedRenderingSites(patchedSource, 'user', formatterName).some(({ line }) => new RegExp(`${formatterName}\\s*\\(`).test(line)),
    contractFailure('formatter_inconsistent', `expected user timestamp rendering to use shared formatter ${formatterName}`),
  );
  assert.ok(
    roleScopedRenderingSites(patchedSource, 'assistant', formatterName).some(({ line }) => new RegExp(`${formatterName}\\s*\\(`).test(line)),
    contractFailure('formatter_inconsistent', `expected assistant timestamp rendering to use shared formatter ${formatterName}`),
  );
});

test('TurnTimestampFormatter keeps cross-day-capable formatting and missing-metadata fallback', () => {
  const patchedSource = sourceAfterPatch(readPatch());

  assert.match(
    patchedSource,
    /Locale\.todayTimeOrDateTime\s*\([^)]*(?:time\.created|\.created|created)/s,
    contractFailure('formatter_not_cross_day', 'expected creation time to flow through Locale.todayTimeOrDateTime'),
  );
  assert.match(
    patchedSource,
    /(?:time\.created|\.created|created)[\s\S]{0,160}(?:\?|&&|if\s*\(|return\s+(?:undefined|null))|(?:undefined|null)[\s\S]{0,160}(?:time\.created|\.created|created)/,
    contractFailure('fallback_missing', 'expected no timestamp when creation metadata is absent'),
  );
});

test('PatchBoundaryGuard limits turn timestamps to user and assistant transcript elements', () => {
  const patchedSource = sourceAfterPatch(readPatch());
  const formatterName = sharedFormatterName(patchedSource);
  const renderingSites = timestampRenderingSites(patchedSource, formatterName);
  const siteKey = ({ index, line }) => `${index}:${line}`;
  const scopedRenderingSites = new Set(
    [
      ...roleScopedRenderingSites(patchedSource, 'user', formatterName),
      ...roleScopedRenderingSites(patchedSource, 'assistant', formatterName),
    ].map(siteKey),
  );

  assert.ok(
    roleScopedRenderingSites(patchedSource, 'user', formatterName).length > 0,
    contractFailure('role_limit_missing', 'expected timestamp rendering inside an explicit user role branch'),
  );
  assert.ok(
    roleScopedRenderingSites(patchedSource, 'assistant', formatterName).length > 0,
    contractFailure('role_limit_missing', 'expected timestamp rendering inside an explicit assistant role branch'),
  );
  assert.deepEqual(
    renderingSites.filter((site) => !scopedRenderingSites.has(siteKey(site))).map(({ index, line }) => `${index + 1}:${line.trim()}`),
    [],
    contractFailure('role_limit_missing', 'timestamp-rendering additions must be scoped to explicit user or assistant branches'),
  );
  assert.doesNotMatch(
    additions(readPatch()),
    /(?:role\s*={0,3}\s*["'](?:system|tool|part|summary)["']|message\.role\s*={2,3}\s*["'](?:system|tool|part|summary)["'])[\s\S]{0,400}(?:showTimestamps|formatCreatedTime|todayTimeOrDateTime|turnTimestamp|timestamp)/i,
    contractFailure('role_limit_missing', 'non-user and non-assistant transcript elements must not receive turn timestamps'),
  );
});
