'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const {
  buildScript,
  createScriptFixture,
  evalDarwinFixture,
  repoRoot,
  runScript,
} = require('./helpers');

const HASH_A = '0123456789abcdfghijklmnpqrsvwxyz';
const HASH_B = '11111111111111111111111111111111';
const HASH_C = '22222222222222222222222222222222';
const HASH_D = '33333333333333333333333333333333';
const NIX_STORE_DIRECTORY = '/nix/store';
const CACHE_ENDPOINT = 'https://cache.example.test:8443';
const CACHE_NAME = 'darwin';
const CACHE_PUBLIC_KEY = 'darwin:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const OTHER_CACHE_PUBLIC_KEY = `darwin:${'A'.repeat(43)}=`;
const NONCANONICAL_CACHE_PUBLIC_KEY = `darwin:${'A'.repeat(42)}B=`;
const UPSTREAM_CACHE_KEYS = [
  'cache.nixos.org-1',
  'nix-community.cachix.org-1',
];
const TOKEN_VALUE = 'poisoned-runtime-token-value';
const PERSONAL_TOKEN_VALUE = 'poisoned-personal-host-token-value';
const SHOPIFY_TOKEN_VALUE = 'poisoned-shopify-host-token-value';
const IDENTICAL_TOKEN_VALUE = 'poisoned-identical-host-token-value';
const OPERATOR_TOKEN_VALUE = 'poisoned-bootstrap-operator-token-value';
const BOOTSTRAP_HOSTNAME = 'Brandons-MacBook-Pro.local';
const LOGIN_USER = 'bootstrap-test-user';
const STATUS_ENDPOINT = `https://${BOOTSTRAP_HOSTNAME}:8443`;
const STATUS_CACHE_URL = `${STATUS_ENDPOINT}/${CACHE_NAME}/attic-cache-info`;
const STATUS_TOKEN_VALUE = 'poisoned-status-token-value';
const STATUS_PRIVATE_KEY_VALUE = 'poisoned-status-private-key-value';
const STATUS_UPSTREAM_SUBSTITUTERS = [
  'https://cache.nixos.org/',
  'https://nix-community.cachix.org',
  's3://shopify-nix-cache?endpoint=https://storage.googleapis.com&profile=shopify-nix-cache-reader',
];

let identityMaterials;
let jqExecutable;
let opensslExecutable;

function getJqExecutable() {
  if (jqExecutable !== undefined) {
    return jqExecutable;
  }

  const expr = `
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      pkgs.jq.bin
  `;
  const outPath = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    },
  ).trim();
  jqExecutable = path.join(outPath, 'bin', 'jq');
  return jqExecutable;
}

function getOpenSSLExecutable() {
  if (opensslExecutable !== undefined) {
    return opensslExecutable;
  }

  const expr = `
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      pkgs.openssl.bin
  `;
  const outPath = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    },
  ).trim();
  opensslExecutable = path.join(outPath, 'bin', 'openssl');
  return opensslExecutable;
}

function runOpenSSL(args, cwd) {
  return childProcess.execFileSync(getOpenSSLExecutable(), args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

function generateRsaKey(root, name) {
  const key = path.join(root, `${name}.key.pem`);
  runOpenSSL([
    'genpkey',
    '-algorithm', 'RSA',
    '-pkeyopt', 'rsa_keygen_bits:2048',
    '-out', key,
  ], root);
  return key;
}

function readDerElement(der, offset) {
  const tag = der[offset];
  const firstLength = der[offset + 1];
  let contentOffset = offset + 2;
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = (length * 256) + der[contentOffset + index];
    }
    contentOffset += lengthBytes;
  }
  return { contentOffset, end: contentOffset + length, tag };
}

function corruptRsaPrivateExponent(root, source, name) {
  const traditional = path.join(root, `${name}.source.pem`);
  const destination = path.join(root, `${name}.key.pem`);
  runOpenSSL(['rsa', '-in', source, '-traditional', '-out', traditional], root);
  const der = Buffer.from(
    fs.readFileSync(traditional, 'utf8').split('\n').filter(line => !line.startsWith('-----')).join(''),
    'base64',
  );
  const sequence = readDerElement(der, 0);
  assert.equal(sequence.tag, 0x30);
  let offset = sequence.contentOffset;
  let privateExponent;
  for (let index = 0; index <= 3; index += 1) {
    const integer = readDerElement(der, offset);
    assert.equal(integer.tag, 0x02);
    if (index === 3) {
      privateExponent = integer;
    }
    offset = integer.end;
  }
  der[privateExponent.end - 1] ^= 1;
  const base64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  const privateKeyLabel = 'RSA ' + 'PRIVATE KEY';
  fs.writeFileSync(destination, `-----BEGIN ${privateKeyLabel}-----\n${base64}\n-----END ${privateKeyLabel}-----\n`, {
    mode: 0o600,
  });
  return destination;
}

function generateRsaPssKeypair(root, name) {
  const privateKey = path.join(root, `${name}.key.pem`);
  const publicKey = path.join(root, `${name}.public.pem`);
  runOpenSSL([
    'genpkey',
    '-algorithm', 'RSA-PSS',
    '-pkeyopt', 'rsa_keygen_bits:2048',
    '-pkeyopt', 'rsa_pss_keygen_md:sha256',
    '-pkeyopt', 'rsa_pss_keygen_mgf1_md:sha256',
    '-pkeyopt', 'rsa_pss_keygen_saltlen:32',
    '-out', privateKey,
  ], root);
  runOpenSSL(['pkey', '-in', privateKey, '-pubout', '-out', publicKey], root);
  return { privateKey, publicKey };
}

function generateCa(root, name) {
  const key = generateRsaKey(root, name);
  const certificate = path.join(root, `${name}.certificate.pem`);
  runOpenSSL([
    'req', '-new', '-x509',
    '-key', key,
    '-out', certificate,
    '-days', '2',
    '-sha256',
    '-subj', `/CN=${name}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ], root);
  return { certificate, key };
}

function generateLeaf(root, name, ca, options = {}) {
  const key = options.key ?? generateRsaKey(root, name);
  const request = path.join(root, `${name}.request.pem`);
  const certificate = path.join(root, `${name}.certificate.pem`);
  const extensions = path.join(root, `${name}.extensions.cnf`);
  const extensionLines = [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
  ];
  if (options.san !== null) {
    extensionLines.push(`subjectAltName=DNS:${options.san ?? BOOTSTRAP_HOSTNAME}`);
  }
  if (options.usage !== null) {
    extensionLines.push(`extendedKeyUsage=${options.usage ?? 'serverAuth'}`);
  }
  fs.writeFileSync(extensions, `${extensionLines.join('\n')}\n`);
  runOpenSSL([
    'req', '-new',
    '-key', key,
    '-out', request,
    '-subj', `/CN=${options.commonName ?? BOOTSTRAP_HOSTNAME}`,
  ], root);
  runOpenSSL([
    'x509', '-req',
    '-in', request,
    '-CA', ca.certificate,
    '-CAkey', ca.key,
    '-set_serial', options.serial ?? '1',
    '-out', certificate,
    '-days', '2',
    '-sha256',
    '-extfile', extensions,
  ], root);
  return { certificate, key };
}

function getIdentityMaterials() {
  if (identityMaterials !== undefined) {
    return identityMaterials;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-binary-cache-test-identity-'));
  const ca = generateCa(root, 'test-only-ca');
  const otherCa = generateCa(root, 'test-only-other-ca');
  const validLeaf = generateLeaf(root, 'test-only-valid-leaf', ca);
  const noSanLeaf = generateLeaf(root, 'test-only-no-san-leaf', ca, { san: null, serial: '2' });
  const wrongSanLeaf = generateLeaf(root, 'test-only-wrong-san-leaf', ca, {
    san: `not-${BOOTSTRAP_HOSTNAME}`,
    serial: '3',
  });
  const noServerAuthLeaf = generateLeaf(root, 'test-only-client-leaf', ca, {
    usage: 'clientAuth',
    serial: '4',
  });
  const wrongCaLeaf = generateLeaf(root, 'test-only-wrong-ca-leaf', otherCa, { serial: '5' });
  const otherTlsKey = generateRsaKey(root, 'test-only-other-tls');
  const invalidTlsKey = corruptRsaPrivateExponent(root, validLeaf.key, 'test-only-invalid-tls');
  const jwtPrivate = generateRsaKey(root, 'test-only-jwt');
  const jwtPublic = path.join(root, 'test-only-jwt.public.pem');
  runOpenSSL(['pkey', '-in', jwtPrivate, '-pubout', '-out', jwtPublic], root);
  const otherJwtPrivate = generateRsaKey(root, 'test-only-other-jwt');
  const jwtPss = generateRsaPssKeypair(root, 'test-only-jwt-pss');

  identityMaterials = {
    ca: ca.certificate,
    invalidTlsKey,
    jwtPrivate,
    jwtPssPrivate: jwtPss.privateKey,
    jwtPssPublic: jwtPss.publicKey,
    jwtPublic,
    noSanLeaf: noSanLeaf.certificate,
    noServerAuthLeaf: noServerAuthLeaf.certificate,
    otherJwtPrivate,
    otherTlsKey,
    root,
    tlsCertificate: validLeaf.certificate,
    tlsKey: validLeaf.key,
    wrongCaLeaf: wrongCaLeaf.certificate,
    wrongSanLeaf: wrongSanLeaf.certificate,
  };
  return identityMaterials;
}

test.after(() => {
  if (identityMaterials !== undefined) {
    fs.rmSync(identityMaterials.root, { force: true, recursive: true });
  }
});

function createBootstrapFixture(t, options = {}) {
  const materials = getIdentityMaterials();
  const fixture = createScriptFixture({
    executables: {
      attic: `
        const fs = require('node:fs');
        const path = require('node:path');
        const args = process.argv.slice(2);
        const configPath = path.join(process.env.XDG_CONFIG_HOME, 'attic', 'config.toml');
        const config = fs.readFileSync(configPath, 'utf8');
        fs.appendFileSync(process.env.ATTIC_BOOTSTRAP_LOG, JSON.stringify({ args, config }) + '\\n');

        const expected = [
          'cache', 'create', '--public', '--priority', '30',
          '--upstream-cache-key-name', 'cache.nixos.org-1',
          '--upstream-cache-key-name', 'nix-community.cachix.org-1',
          'local:darwin',
        ];
        if (JSON.stringify(args) !== JSON.stringify(expected)) {
          process.stderr.write('unexpected attic arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }
        if (process.env.ATTIC_CREATE_FAIL_STATUS !== undefined) {
          process.stderr.write((process.env.ATTIC_CREATE_FAIL_MESSAGE ?? 'stub cache create failed') + '\\n');
          process.exit(Number(process.env.ATTIC_CREATE_FAIL_STATUS));
        }
        const state = process.env.ATTIC_CREATED_STATE === undefined
          ? {
              public_key: process.env.CACHE_PUBLIC_KEY,
              is_public: true,
              priority: 30,
              upstream_cache_key_names: [
                'cache.nixos.org-1',
                'nix-community.cachix.org-1',
              ],
            }
          : JSON.parse(process.env.ATTIC_CREATED_STATE);
        fs.writeFileSync(process.env.CACHE_STATE, JSON.stringify(state));
      `,
      atticadm: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        if (args.length < 4 || args[0] !== '-f' || args[2] !== 'make-token') {
          process.stderr.write('unexpected atticadm arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }
        const configPath = args[1];
        const config = fs.readFileSync(configPath, 'utf8');
        const expectedSecret = fs.readFileSync(process.env.JWT_PRIVATE_PATH).toString('base64');
        const configMode = (fs.statSync(configPath).mode & 0o777).toString(8).padStart(4, '0');
        const configHasExpectedSecret = config.includes(
          'token-rs256-secret-base64 = "' + expectedSecret + '"',
        );
        fs.appendFileSync(process.env.ATTIC_ADMIN_LOG, JSON.stringify({
          args,
          configHasExpectedSecret,
          configMode,
        }) + '\\n');
        if (!configHasExpectedSecret || configMode !== '0600') {
          process.stderr.write('invalid atticadm runtime config\\n');
          process.exit(65);
        }

        const subjectIndex = args.indexOf('--sub');
        const subject = subjectIndex === -1 ? '' : args[subjectIndex + 1];
        const tokens = {
          'local-binary-cache-bootstrap': process.env.OPERATOR_TOKEN_VALUE,
          'Brandons-MacBook-Pro': process.env.PERSONAL_TOKEN_VALUE,
          ShopifyLaptop: process.env.SHOPIFY_TOKEN_VALUE,
        };
        if (!(subject in tokens)) {
          process.stderr.write('unexpected token subject: ' + subject + '\\n');
          process.exit(66);
        }
        if (process.env.ATTIC_ADMIN_FAIL_SUBJECT === subject) {
          process.stderr.write('stub token issuance failed for ' + subject + '\\n');
          process.exit(23);
        }
        if (process.env.ATTIC_ADMIN_EMPTY_SUBJECT === subject) {
          process.exit(0);
        }
        const token = process.env.ATTIC_ADMIN_IDENTICAL_HOST_TOKENS === '1'
          && ['Brandons-MacBook-Pro', 'ShopifyLaptop'].includes(subject)
          ? process.env.IDENTICAL_TOKEN_VALUE
          : tokens[subject];
        process.stdout.write(token + '\\n');
      `,
      curl: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        const prior = fs.existsSync(process.env.CURL_LOG)
          ? fs.readFileSync(process.env.CURL_LOG, 'utf8').trim().split('\\n').filter(Boolean)
          : [];
        fs.appendFileSync(process.env.CURL_LOG, JSON.stringify(args) + '\\n');
        if (
          args.length !== 8
          || args[0] !== '--silent'
          || args[1] !== '--show-error'
          || args[2] !== '--output'
          || args[4] !== '--write-out'
          || args[5] !== '%{http_code}'
          || args[6] !== '--'
          || args[7] !== process.env.CACHE_QUERY_URL
          || args.some(arg => /authorization/i.test(arg))
        ) {
          process.stderr.write('unexpected curl arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }
        const output = args[3];
        const statusSequence = process.env.CURL_STATUS_SEQUENCE === undefined
          ? []
          : JSON.parse(process.env.CURL_STATUS_SEQUENCE);
        const forcedStatus = prior.length < statusSequence.length
          ? statusSequence[prior.length]
          : process.env.CURL_FORCED_STATUS;
        if (forcedStatus !== undefined) {
          if (forcedStatus === '200' && fs.existsSync(process.env.CACHE_STATE)) {
            fs.copyFileSync(process.env.CACHE_STATE, output);
          } else {
            fs.writeFileSync(output, '{"error":"Unauthorized"}');
          }
          process.stdout.write(forcedStatus);
        } else if (fs.existsSync(process.env.CACHE_STATE)) {
          fs.copyFileSync(process.env.CACHE_STATE, output);
          process.stdout.write('200');
        } else {
          fs.writeFileSync(output, '{"error":"NoSuchCache"}');
          process.stdout.write('404');
        }
      `,
      stat: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        if (
          args.length !== 4
          || args[0] !== '--dereference'
          || args[1] !== '--format=%U:%a'
          || args[2] !== '--'
        ) {
          process.stderr.write('unexpected stat arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }
        const file = args[3];
        const owners = JSON.parse(process.env.STAT_OWNERS);
        const mode = (fs.statSync(file).mode & 0o777).toString(8).padStart(4, '0');
        process.stdout.write((owners[file] ?? 'fixture-public-owner') + ':' + mode + '\\n');
      `,
    },
    statePaths: {
      ca: 'public/ca.pem',
      cachePublicKeyOutput: 'outputs/cache-public-key.txt',
      cacheState: 'state/cache.json',
      configuredCachePublicKey: 'public/configured-cache-public-key.txt',
      atticAdminLog: 'state/atticadm.log',
      atticBootstrapLog: 'state/attic.log',
      curlLog: 'state/curl.log',
      jwtPrivate: 'secrets/jwt-private.pem',
      jwtPublic: 'public/jwt-public.pem',
      personalTokenOutput: 'outputs/personal-token',
      shopifyTokenOutput: 'outputs/shopify-token',
      tlsCertificate: 'public/server.pem',
      tlsKey: 'secrets/server-key.pem',
    },
  });
  t.after(fixture.cleanup);

  const sources = {
    ca: options.ca === undefined ? materials.ca : options.ca,
    jwtPrivate: options.jwtPrivate === undefined ? materials.jwtPrivate : options.jwtPrivate,
    jwtPublic: options.jwtPublic === undefined ? materials.jwtPublic : options.jwtPublic,
    tlsCertificate: options.tlsCertificate === undefined
      ? materials.tlsCertificate
      : options.tlsCertificate,
    tlsKey: options.tlsKey === undefined ? materials.tlsKey : options.tlsKey,
  };
  for (const [name, source] of Object.entries(sources)) {
    if (source !== null) {
      fs.copyFileSync(source, fixture.statePaths[name]);
    }
  }
  if (options.cacheState !== undefined) {
    fs.writeFileSync(fixture.statePaths.cacheState, JSON.stringify(options.cacheState));
  }
  if (options.configuredCachePublicKeyFile !== undefined) {
    fs.writeFileSync(
      fixture.statePaths.configuredCachePublicKey,
      `${options.configuredCachePublicKeyFile}\n`,
    );
  }
  for (const name of ['ca', 'jwtPublic', 'tlsCertificate']) {
    if (sources[name] !== null) {
      fs.chmodSync(fixture.statePaths[name], options[`${name}Mode`] ?? 0o644);
    }
  }
  for (const name of ['jwtPrivate', 'tlsKey']) {
    if (sources[name] !== null) {
      fs.chmodSync(fixture.statePaths[name], options[`${name}Mode`] ?? 0o400);
    }
  }

  const owners = {
    [fixture.statePaths.ca]: 'fixture-public-owner',
    [fixture.statePaths.jwtPrivate]: options.jwtPrivateOwner ?? 'root',
    [fixture.statePaths.jwtPublic]: 'fixture-public-owner',
    [fixture.statePaths.tlsCertificate]: 'fixture-public-owner',
    [fixture.statePaths.tlsKey]: options.tlsKeyOwner ?? LOGIN_USER,
  };
  const executable = buildScript('scripts/local-binary-cache-bootstrap.nix', {
    atticAdminExecutable: fixture.executables.atticadm,
    atticClientExecutable: fixture.executables.attic,
    caCertificate: fixture.statePaths.ca,
    cacheName: CACHE_NAME,
    cachePublicKeyOutput: fixture.statePaths.cachePublicKeyOutput,
    configuredCachePublicKey: options.configuredCachePublicKeyValue ?? '',
    configuredCachePublicKeyFile: options.configuredCachePublicKeyFile === undefined
      ? ''
      : fixture.statePaths.configuredCachePublicKey,
    curlExecutable: fixture.executables.curl,
    endpoint: CACHE_ENDPOINT,
    jwtPrivateKey: fixture.statePaths.jwtPrivate,
    jwtPublicKey: fixture.statePaths.jwtPublic,
    jqExecutable: getJqExecutable(),
    loginUser: LOGIN_USER,
    opensslExecutable: getOpenSSLExecutable(),
    personalTokenOutput: fixture.statePaths.personalTokenOutput,
    shopifyTokenOutput: fixture.statePaths.shopifyTokenOutput,
    statExecutable: fixture.executables.stat,
    tlsCertificate: fixture.statePaths.tlsCertificate,
    tlsKeyFile: fixture.statePaths.tlsKey,
  });
  return { executable, fixture, materials, owners };
}

function runBootstrap(bootstrap, args = [], extraEnv = {}) {
  return runScript(bootstrap.executable, args, {
    fixture: bootstrap.fixture,
    env: {
      STAT_OWNERS: JSON.stringify(bootstrap.owners),
      ATTIC_ADMIN_LOG: bootstrap.fixture.statePaths.atticAdminLog,
      ATTIC_BOOTSTRAP_LOG: bootstrap.fixture.statePaths.atticBootstrapLog,
      CACHE_PUBLIC_KEY,
      CACHE_QUERY_URL: `${CACHE_ENDPOINT}/_api/v1/cache-config/${CACHE_NAME}`,
      CACHE_STATE: bootstrap.fixture.statePaths.cacheState,
      CURL_LOG: bootstrap.fixture.statePaths.curlLog,
      IDENTICAL_TOKEN_VALUE,
      JWT_PRIVATE_PATH: bootstrap.fixture.statePaths.jwtPrivate,
      OPERATOR_TOKEN_VALUE,
      PERSONAL_TOKEN_VALUE,
      SHOPIFY_TOKEN_VALUE,
      ...extraEnv,
    },
  });
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function validCacheState(overrides = {}) {
  return {
    public_key: CACHE_PUBLIC_KEY,
    is_public: true,
    priority: 30,
    upstream_cache_key_names: UPSTREAM_CACHE_KEYS,
    ...overrides,
  };
}

function assertNoBootstrapOutputs(bootstrap) {
  for (const output of [
    bootstrap.fixture.statePaths.cachePublicKeyOutput,
    bootstrap.fixture.statePaths.personalTokenOutput,
    bootstrap.fixture.statePaths.shopifyTokenOutput,
  ]) {
    assert.equal(fs.existsSync(output), false, `unexpected bootstrap output: ${output}`);
  }
  assert.deepEqual(fs.readdirSync(bootstrap.fixture.tmp), []);
}

function assertBootstrapObservabilityRedacted(bootstrap, result) {
  const logContents = [
    bootstrap.fixture.statePaths.atticAdminLog,
    bootstrap.fixture.statePaths.atticBootstrapLog,
    bootstrap.fixture.statePaths.curlLog,
  ].filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8'));
  const observable = [
    result.stdout,
    result.stderr,
    fs.readFileSync(bootstrap.executable, 'utf8'),
    ...logContents,
  ].join('\n');
  const secrets = [
    OPERATOR_TOKEN_VALUE,
    PERSONAL_TOKEN_VALUE,
    SHOPIFY_TOKEN_VALUE,
    fs.readFileSync(bootstrap.fixture.statePaths.tlsKey, 'utf8'),
    fs.readFileSync(bootstrap.fixture.statePaths.jwtPrivate, 'utf8'),
  ];
  for (const secret of secrets) {
    assert.equal(observable.includes(secret), false);
  }
}

function createEnqueueFixture(t) {
  const fixture = createScriptFixture({
    executables: {
      nixStore: `
        const fs = require('node:fs');
        const path = require('node:path');
        const args = process.argv.slice(2);
        fs.appendFileSync(process.env.NIX_STORE_LOG, JSON.stringify(args) + '\\n');

        if (args.length !== 4 || args[0] !== '--add-root' || args[2] !== '--realise') {
          process.stderr.write('unexpected nix-store arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }

        const root = args[1];
        const output = args[3];
        if (process.env.NIX_STORE_FAIL_FOR === output) {
          process.stderr.write('stub root creation failed for ' + output + '\\n');
          process.exit(23);
        }
        if (!fs.existsSync(path.dirname(root))) {
          process.stderr.write('pending directory was not created before nix-store invocation\\n');
          process.exit(65);
        }

        const temporaryRoot = root + '.tmp.' + process.pid;
        fs.rmSync(temporaryRoot, { force: true });
        fs.symlinkSync(output, temporaryRoot);
        fs.renameSync(temporaryRoot, root);
      `,
    },
    statePaths: {
      log: 'state/nix-store.log',
      pending: 'state/pending',
      store: 'store',
    },
  });
  t.after(fixture.cleanup);

  const executable = buildScript('scripts/local-binary-cache-enqueue.nix', {
    nixStoreExecutable: fixture.executables.nixStore,
    pendingDirectory: fixture.statePaths.pending,
    storeDirectory: fixture.statePaths.store,
  });
  return { executable, fixture };
}

function createPostBuildWrapperFixture(t) {
  const fixture = createScriptFixture({
    executables: {
      firstHook: `
        const fs = require('node:fs');
        fs.appendFileSync(
          process.env.HOOK_LOG,
          ['first', process.env.DRV_PATH, process.env.OUT_PATHS].join('\\t') + '\\n',
        );
        if (process.env.FIRST_HOOK_FAIL_STATUS) {
          process.exit(Number(process.env.FIRST_HOOK_FAIL_STATUS));
        }
      `,
      secondHook: `
        const fs = require('node:fs');
        fs.appendFileSync(
          process.env.HOOK_LOG,
          ['second', process.env.DRV_PATH, process.env.OUT_PATHS].join('\\t') + '\\n',
        );
      `,
    },
    statePaths: {
      externalInclude: 'etc/nix/nix.conf.d/shopify.conf',
      hookLog: 'state/hook.log',
      publisher: 'state/publisher',
    },
  });
  t.after(fixture.cleanup);
  const chainedHooks = [fixture.executables.firstHook, fixture.executables.secondHook]
    .map(JSON.stringify)
    .join(' ');
  const rendered = evalDarwinFixture(
    `{ pkgs, ... }:
    let
      nixStoreStub = pkgs.writeShellScriptBin "nix-store" ''
        printf 'enqueue\\t%s\\t%s\\n' "$DRV_PATH" "$OUT_PATHS" >> "$HOOK_LOG"
        if [[ -n "$ENQUEUE_FAIL_STATUS" ]]; then
          exit "$ENQUEUE_FAIL_STATUS"
        fi
      '';
      nixPackage = pkgs.symlinkJoin {
        name = "nix-${'${pkgs.nix.version}'}";
        inherit (pkgs.nix) version;
        paths = [ pkgs.nix ];
        postBuild = ''
          ln -sfn ${'${nixStoreStub}'}/bin/nix-store "$out/bin/nix-store"
        '';
      };
    in {
      nix.package = nixPackage;
      services.localBinaryCache = {
        enable = true;
        hostRole = "shopify";
        bootstrapMode = false;
        cachePublicKey = "darwin:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=";
        caCertificate = ${path.join(__dirname, 'fixtures/tls-certificate.pem')};
        consumer.enable = true;
        publisher = {
          enable = true;
          package = pkgs.hello;
          tokenFile = "/run/secrets/local-binary-cache-token";
          stateDirectory = ${JSON.stringify(fixture.statePaths.publisher)};
          chainedHooks = [ ${chainedHooks} ];
          externalHookInclude = ${JSON.stringify(fixture.statePaths.externalInclude)};
        };
      };
    }`,
    `let
      publisher = config.services.localBinaryCache.publisher;
      wrapperExecutable = "${'${publisher.postBuildHookPackage}'}/bin/local-binary-cache-post-build-hook";
    in {
      inherit wrapperExecutable;
      wrapperText = builtins.readFile wrapperExecutable;
      enqueuePackage = toString publisher.enqueuePackage;
    }`,
  );

  return { fixture, rendered };
}

function enqueueEnvironment(fixture, outPaths, extra = {}) {
  return {
    NIX_STORE_LOG: fixture.statePaths.log,
    ...(outPaths === undefined ? {} : { OUT_PATHS: outPaths }),
    ...extra,
  };
}

function readInvocations(fixture) {
  if (!fs.existsSync(fixture.statePaths.log)) {
    return [];
  }
  return fs.readFileSync(fixture.statePaths.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function createPublisherFixture(t, options = {}) {
  const fixture = createScriptFixture({
    executables: {
      attic: `
        const fs = require('node:fs');
        const path = require('node:path');
        const args = process.argv.slice(2);
        const configPath = path.join(process.env.XDG_CONFIG_HOME, 'attic', 'config.toml');
        const config = fs.readFileSync(configPath, 'utf8');
        const target = args.at(-1);
        const prior = fs.existsSync(process.env.ATTIC_LOG)
          ? fs.readFileSync(process.env.ATTIC_LOG, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)
          : [];
        fs.appendFileSync(process.env.ATTIC_LOG, JSON.stringify({ args, config }) + '\\n');

        if (args.length !== 5 || args[0] !== 'push' || args[1] !== '-j' || args[2] !== '1') {
          process.stderr.write('unexpected attic arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }
        if (process.env.ATTIC_FAIL_FOR === target) {
          process.stderr.write('stub push failed for ' + target + '\\n');
          process.exit(23);
        }
        if (
          process.env.ATTIC_FAIL_ONCE_FOR === target
          && prior.filter(invocation => invocation.args.at(-1) === target).length === 0
        ) {
          process.stderr.write('stub push failed once for ' + target + '\\n');
          process.exit(24);
        }
        if (process.env.ATTIC_ALREADY_PRESENT_FOR === target) {
          process.stderr.write('already present: ' + target + '\\n');
        }
        if (process.env.ATTIC_HOLD_FOR === target) {
          fs.writeFileSync(process.env.ATTIC_READY_FILE, target);
          while (!fs.existsSync(process.env.ATTIC_RELEASE_FILE)) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
      `,
      shlock: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        if (args.length !== 4 || args[0] !== '-p' || args[2] !== '-f') {
          process.stderr.write('unexpected shlock arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }

        const owner = Number(args[1]);
        const lock = args[3];
        while (true) {
          try {
            const descriptor = fs.openSync(lock, 'wx', 0o600);
            fs.writeFileSync(descriptor, String(owner) + '\\n');
            fs.closeSync(descriptor);
            process.exit(0);
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }

          const existingOwner = Number(fs.readFileSync(lock, 'utf8').trim());
          try {
            process.kill(existingOwner, 0);
            process.exit(1);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            fs.rmSync(lock, { force: true });
          }
        }
      `,
    },
    statePaths: {
      log: 'state/attic.log',
      pending: 'state/pending',
      publisher: 'state/publisher',
      ready: 'state/attic.ready',
      release: 'state/attic.release',
      store: 'store',
      token: 'secrets/push-token',
    },
  });
  t.after(fixture.cleanup);

  if (options.withToken !== false) {
    fs.writeFileSync(fixture.statePaths.token, TOKEN_VALUE, { mode: 0o400 });
  }

  const executable = buildScript('scripts/local-binary-cache-publish.nix', {
    atticExecutable: fixture.executables.attic,
    cacheName: CACHE_NAME,
    endpoint: CACHE_ENDPOINT,
    pendingDirectory: fixture.statePaths.pending,
    shlockExecutable: fixture.executables.shlock,
    stateDirectory: fixture.statePaths.publisher,
    storeDirectory: fixture.statePaths.store,
    tokenFile: fixture.statePaths.token,
  });
  return { executable, fixture };
}

function publisherEnvironment(fixture, extra = {}) {
  return {
    ATTIC_LOG: fixture.statePaths.log,
    ...extra,
  };
}

function createPendingRoot(fixture, hash, name, options = {}) {
  const output = path.join(fixture.statePaths.store, `${hash}-${name}`);
  const root = path.join(fixture.statePaths.pending, hash);
  fs.mkdirSync(fixture.statePaths.pending, { recursive: true });
  if (!options.broken) {
    fs.mkdirSync(output, { recursive: true });
  }
  fs.symlinkSync(output, root);
  return { output, root };
}

function readAtticInvocations(fixture) {
  return readInvocations(fixture);
}

function spawnPublisher(executable, fixture, env = {}) {
  const output = { stderr: '', stdout: '' };
  const child = childProcess.spawn(executable, [], {
    cwd: fixture.root,
    detached: true,
    env: {
      HOME: fixture.home,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: fixture.bin,
      TMPDIR: fixture.tmp,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ ...output, signal, status }));
  });
  return { child, completed };
}

async function waitForPath(filePath, child) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`publisher exited before creating ${filePath}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(10);
  }
}

function holdingEnvironment(fixture, output) {
  return publisherEnvironment(fixture, {
    ATTIC_HOLD_FOR: output,
    ATTIC_READY_FILE: fixture.statePaths.ready,
    ATTIC_RELEASE_FILE: fixture.statePaths.release,
  });
}

function createStatusFixture(t, options = {}) {
  const fixture = createScriptFixture({
    executables: {
      curl: `
        const fs = require('node:fs');
        const path = require('node:path');
        const args = process.argv.slice(2);
        fs.appendFileSync(process.env.STATUS_CURL_LOG, JSON.stringify(args) + '\\n');
        const curlConfig = path.join(process.env.HOME, '.curlrc');
        if (fs.existsSync(curlConfig) && args[0] !== '--disable') {
          fs.writeFileSync(process.env.STATUS_AMBIENT_OUTPUT, 'ambient curl output\\n');
          fs.writeFileSync(process.env.STATUS_AMBIENT_TRACE, fs.readFileSync(curlConfig));
          fs.writeFileSync(process.env.STATUS_CACHE_STATE, 'mutated by ambient curl config\\n');
        }
        if (
          args.length !== 9
          || args[0] !== '--disable'
          || args[1] !== '--cacert'
          || args[2] !== process.env.STATUS_CA
          || args[3] !== '--silent'
          || args[4] !== '--show-error'
          || args[5] !== '--write-out'
          || args[6] !== '\\n%{http_code}'
          || args[7] !== '--'
          || args[8] !== process.env.STATUS_CACHE_URL
          || args.some(arg => /authorization|token/i.test(arg))
        ) {
          process.stderr.write('unexpected status curl arguments\\n');
          process.exit(64);
        }
        if (process.env.STATUS_CURL_STDERR) {
          process.stderr.write(process.env.STATUS_CURL_STDERR);
        }
        if (process.env.STATUS_CURL_FAIL === '1') {
          process.exit(35);
        }
        process.stdout.write(
          process.env.STATUS_CACHE_RESPONSE + '\\n' + process.env.STATUS_HTTP_STATUS,
        );
      `,
      date: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        fs.appendFileSync(process.env.STATUS_DATE_LOG, JSON.stringify(args) + '\\n');
        if (args.length !== 1 || args[0] !== '+%s') {
          process.stderr.write('unexpected status date arguments\\n');
          process.exit(64);
        }
        if (process.env.STATUS_DATE_STDERR) {
          process.stderr.write(process.env.STATUS_DATE_STDERR);
        }
        process.stdout.write(process.env.STATUS_NOW_EPOCH + '\\n');
      `,
      nix: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        fs.appendFileSync(process.env.STATUS_NIX_LOG, JSON.stringify(args) + '\\n');
        if (args.length !== 3 || args[0] !== 'config' || args[1] !== 'show') {
          process.stderr.write('unexpected status nix arguments\\n');
          process.exit(64);
        }
        if (process.env.STATUS_NIX_STDERR) {
          process.stderr.write(process.env.STATUS_NIX_STDERR);
        }
        if (process.env.STATUS_NIX_FAIL_SETTING === args[2]) {
          process.exit(23);
        }
        if (args[2] === 'post-build-hook') {
          process.stdout.write(process.env.STATUS_EFFECTIVE_HOOK + '\\n');
        } else if (args[2] === 'substituters') {
          process.stdout.write(process.env.STATUS_EFFECTIVE_SUBSTITUTERS + '\\n');
        } else {
          process.stderr.write('unexpected status setting\\n');
          process.exit(65);
        }
      `,
      readlink: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        fs.appendFileSync(process.env.STATUS_READLINK_LOG, JSON.stringify(args) + '\\n');
        if (args.length !== 2 || args[0] !== '--') {
          process.stderr.write('unexpected status readlink arguments\\n');
          process.exit(64);
        }
        if (process.env.STATUS_READLINK_STDERR) {
          process.stderr.write(process.env.STATUS_READLINK_STDERR);
        }
        process.stdout.write(fs.readlinkSync(args[1]) + '\\n');
      `,
      stat: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        fs.appendFileSync(process.env.STATUS_STAT_LOG, JSON.stringify(args) + '\\n');
        if (args.length !== 3 || args[0] !== '--format=%Y' || args[1] !== '--') {
          process.stderr.write('unexpected status stat arguments\\n');
          process.exit(64);
        }
        if (process.env.STATUS_STAT_STDERR) {
          process.stderr.write(process.env.STATUS_STAT_STDERR);
        }
        const mtimes = JSON.parse(process.env.STATUS_STAT_MTIMES);
        if (!(args[2] in mtimes)) {
          process.exit(24);
        }
        process.stdout.write(String(mtimes[args[2]]) + '\\n');
      `,
    },
    statePaths: {
      ambientOutput: 'state/ambient-curl-output',
      ambientTrace: 'state/ambient-curl-trace',
      ca: 'public/ca.pem',
      cacheState: 'state/cache-state.json',
      curlConfig: 'home/.curlrc',
      curlLog: 'logs/curl.log',
      dateLog: 'logs/date.log',
      expectedHook: 'config/local-binary-cache-post-build-hook',
      nixLog: 'logs/nix.log',
      pending: 'state/pending',
      privateKey: 'secrets/server-key.pem',
      readlinkLog: 'logs/readlink.log',
      statLog: 'logs/stat.log',
      store: 'store',
      token: 'secrets/push-token',
    },
  });
  t.after(fixture.cleanup);

  fs.writeFileSync(fixture.statePaths.ca, 'fixture-only-public-ca-certificate\n');
  fs.writeFileSync(fixture.statePaths.cacheState, JSON.stringify(validCacheState()));
  fs.writeFileSync(fixture.statePaths.privateKey, STATUS_PRIVATE_KEY_VALUE, { mode: 0o400 });
  fs.writeFileSync(fixture.statePaths.token, STATUS_TOKEN_VALUE, { mode: 0o400 });

  const expectedSubstituters = options.expectedSubstituters ?? [
    ...STATUS_UPSTREAM_SUBSTITUTERS,
    STATUS_CACHE_URL.replace('/attic-cache-info', ''),
  ].join(' ');
  const executable = buildScript('scripts/local-binary-cache-status.nix', {
    bootstrapMode: options.bootstrapMode ?? false,
    caCertificate: fixture.statePaths.ca,
    cacheName: CACHE_NAME,
    configuredCachePublicKey: options.configuredCachePublicKey ?? CACHE_PUBLIC_KEY,
    curlExecutable: fixture.executables.curl,
    dateExecutable: fixture.executables.date,
    endpoint: STATUS_ENDPOINT,
    expectedPostBuildHook: fixture.statePaths.expectedHook,
    expectedSubstituters,
    jqExecutable: getJqExecutable(),
    nixExecutable: fixture.executables.nix,
    pendingDirectory: fixture.statePaths.pending,
    readinessOnly: options.readinessOnly ?? false,
    readlinkExecutable: fixture.executables.readlink,
    statExecutable: fixture.executables.stat,
    storeDirectory: fixture.statePaths.store,
  });

  return { executable, expectedSubstituters, fixture };
}

function statusEnvironment(status, extra = {}) {
  return {
    STATUS_CACHE_RESPONSE: JSON.stringify(validCacheState()),
    STATUS_CACHE_URL,
    STATUS_CA: status.fixture.statePaths.ca,
    STATUS_AMBIENT_OUTPUT: status.fixture.statePaths.ambientOutput,
    STATUS_AMBIENT_TRACE: status.fixture.statePaths.ambientTrace,
    STATUS_CACHE_STATE: status.fixture.statePaths.cacheState,
    STATUS_CURL_LOG: status.fixture.statePaths.curlLog,
    STATUS_DATE_LOG: status.fixture.statePaths.dateLog,
    STATUS_EFFECTIVE_HOOK: status.fixture.statePaths.expectedHook,
    STATUS_EFFECTIVE_SUBSTITUTERS: status.expectedSubstituters,
    STATUS_HTTP_STATUS: '200',
    STATUS_NIX_LOG: status.fixture.statePaths.nixLog,
    STATUS_NOW_EPOCH: '1000',
    STATUS_READLINK_LOG: status.fixture.statePaths.readlinkLog,
    STATUS_STAT_LOG: status.fixture.statePaths.statLog,
    STATUS_STAT_MTIMES: '{}',
    ...extra,
  };
}

function runStatus(status, extraEnv = {}) {
  return runScript(status.executable, [], {
    fixture: status.fixture,
    env: statusEnvironment(status, extraEnv),
  });
}

function statusOutputLines(result) {
  return result.stdout.trim().split('\n');
}

function assertStatusReadOnly(status, expectedRoots) {
  assert.deepEqual(fs.readdirSync(status.fixture.statePaths.pending), expectedRoots);
  for (const root of expectedRoots) {
    assert.equal(fs.lstatSync(path.join(status.fixture.statePaths.pending, root)).isSymbolicLink(), true);
  }
}

test('bootstrap readiness is non-ready without probing or mutating runtime state', t => {
  const status = createStatusFixture(t, {
    bootstrapMode: true,
    configuredCachePublicKey: '',
    readinessOnly: true,
  });
  const pending = createPendingRoot(status.fixture, HASH_A, 'bootstrap-pending-output');
  const unchangedFiles = new Map([
    status.fixture.statePaths.ca,
    status.fixture.statePaths.cacheState,
    status.fixture.statePaths.privateKey,
    status.fixture.statePaths.token,
  ].map(file => [file, fs.readFileSync(file)]));

  const result = runStatus(status, {
    STATUS_CACHE_RESPONSE: STATUS_PRIVATE_KEY_VALUE,
    STATUS_CURL_STDERR: STATUS_TOKEN_VALUE,
    STATUS_DATE_STDERR: STATUS_PRIVATE_KEY_VALUE,
    STATUS_NIX_STDERR: STATUS_TOKEN_VALUE,
    STATUS_READLINK_STDERR: STATUS_PRIVATE_KEY_VALUE,
    STATUS_STAT_STDERR: STATUS_TOKEN_VALUE,
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(statusOutputLines(result), [
    'mode=bootstrap',
    'status=not-ready',
  ]);
  for (const log of [
    status.fixture.statePaths.curlLog,
    status.fixture.statePaths.dateLog,
    status.fixture.statePaths.nixLog,
    status.fixture.statePaths.readlinkLog,
    status.fixture.statePaths.statLog,
  ]) {
    assert.equal(fs.existsSync(log), false, `unexpected bootstrap readiness probe: ${log}`);
  }
  for (const [file, contents] of unchangedFiles) {
    assert.deepEqual(fs.readFileSync(file), contents);
  }
  assert.equal(fs.readlinkSync(pending.root), pending.output);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(STATUS_PRIVATE_KEY_VALUE), false);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(STATUS_TOKEN_VALUE), false);
});

test('core readiness succeeds without requiring Task 4 hook or substituter configuration', t => {
  const status = createStatusFixture(t, { readinessOnly: true });
  const result = runStatus(status, {
    STATUS_EFFECTIVE_HOOK: '/not-yet-owned/task-4-hook',
    STATUS_EFFECTIVE_SUBSTITUTERS: STATUS_UPSTREAM_SUBSTITUTERS.join(' '),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(statusOutputLines(result), [
    'mode=ready',
    'tls-health=healthy',
    'cache-health=healthy',
    'configured-live-key-match=true',
    'status=ready',
  ]);
  assert.deepEqual(readJsonLines(status.fixture.statePaths.curlLog), [[
    '--disable', '--cacert', status.fixture.statePaths.ca,
    '--silent', '--show-error', '--write-out', '\n%{http_code}',
    '--', STATUS_CACHE_URL,
  ]]);
  assert.equal(fs.existsSync(status.fixture.statePaths.nixLog), false);
  assert.equal(fs.existsSync(status.fixture.statePaths.pending), false);
});

test('core readiness blocks TLS, cache visibility, and signing identity failures', async t => {
  const cases = [
    {
      name: 'TLS failure',
      env: { STATUS_CURL_FAIL: '1' },
      expected: ['tls-health=unhealthy', 'cache-health=unhealthy', 'configured-live-key-match=unavailable'],
    },
    {
      name: 'cache absence',
      env: { STATUS_HTTP_STATUS: '404', STATUS_CACHE_RESPONSE: '{"error":"NoSuchCache"}' },
      expected: ['tls-health=healthy', 'cache-health=unhealthy', 'configured-live-key-match=unavailable'],
    },
    {
      name: 'private cache',
      env: { STATUS_CACHE_RESPONSE: JSON.stringify(validCacheState({ is_public: false })) },
      expected: ['tls-health=healthy', 'cache-health=unhealthy', 'configured-live-key-match=unavailable'],
    },
    {
      name: 'live key mismatch',
      env: { STATUS_CACHE_RESPONSE: JSON.stringify(validCacheState({ public_key: OTHER_CACHE_PUBLIC_KEY })) },
      expected: ['tls-health=healthy', 'cache-health=healthy', 'configured-live-key-match=false'],
    },
    {
      name: 'noncanonical live key',
      env: { STATUS_CACHE_RESPONSE: JSON.stringify(validCacheState({ public_key: NONCANONICAL_CACHE_PUBLIC_KEY })) },
      expected: ['tls-health=healthy', 'cache-health=unhealthy', 'configured-live-key-match=unavailable'],
    },
    {
      name: 'configured key mismatch',
      options: { configuredCachePublicKey: OTHER_CACHE_PUBLIC_KEY },
      expected: ['tls-health=healthy', 'cache-health=healthy', 'configured-live-key-match=false'],
    },
    {
      name: 'noncanonical configured key',
      options: { configuredCachePublicKey: NONCANONICAL_CACHE_PUBLIC_KEY },
      expected: ['tls-health=healthy', 'cache-health=healthy', 'configured-live-key-match=unavailable'],
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, child => {
      const status = createStatusFixture(child, {
        readinessOnly: true,
        ...fixtureCase.options,
      });
      const mutationSentinel = Buffer.from('must-not-change\n');
      fs.writeFileSync(status.fixture.statePaths.cacheState, mutationSentinel);

      const result = runStatus(status, {
        STATUS_CURL_STDERR: STATUS_TOKEN_VALUE,
        ...fixtureCase.env,
      });

      assert.notEqual(result.status, 0);
      assert.equal(result.stderr, '');
      assert.ok(statusOutputLines(result).includes('mode=ready'));
      for (const line of fixtureCase.expected) {
        assert.ok(statusOutputLines(result).includes(line), `${fixtureCase.name}: missing ${line}`);
      }
      assert.ok(statusOutputLines(result).includes('status=not-ready'));
      assert.deepEqual(fs.readFileSync(status.fixture.statePaths.cacheState), mutationSentinel);
      assert.equal(fs.existsSync(status.fixture.statePaths.nixLog), false);
      assert.equal(fs.existsSync(status.fixture.statePaths.pending), false);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(STATUS_TOKEN_VALUE), false);
    });
  }
});

test('status reports healthy endpoint, identity, effective config, and pending age', t => {
  const status = createStatusFixture(t);
  const first = createPendingRoot(status.fixture, HASH_A, 'first-status-output');
  const second = createPendingRoot(status.fixture, HASH_B, 'second-status-output');

  const result = runStatus(status, {
    STATUS_STAT_MTIMES: JSON.stringify({
      [first.root]: 900,
      [second.root]: 820,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(statusOutputLines(result), [
    'tls-health=healthy',
    'cache-health=healthy',
    'configured-live-key-match=true',
    `effective-post-build-hook=${status.fixture.statePaths.expectedHook}`,
    'post-build-hook-match=true',
    ...status.expectedSubstituters.split(' ').map(value => `effective-substituter=${value.includes('?') ? `${value.split('?')[0]}?<redacted>` : value}`),
    'substituters-match=true',
    'queue-count=2',
    'oldest-pending-age-seconds=180',
    'broken-root=none',
    'status=healthy',
  ]);
  assert.deepEqual(readJsonLines(status.fixture.statePaths.curlLog), [[
    '--disable', '--cacert', status.fixture.statePaths.ca,
    '--silent', '--show-error', '--write-out', '\n%{http_code}',
    '--', STATUS_CACHE_URL,
  ]]);
  assert.deepEqual(readJsonLines(status.fixture.statePaths.nixLog), [
    ['config', 'show', 'post-build-hook'],
    ['config', 'show', 'substituters'],
  ]);
  assert.deepEqual(readJsonLines(status.fixture.statePaths.dateLog), [['+%s']]);
  assert.deepEqual(readJsonLines(status.fixture.statePaths.statLog), [
    ['--format=%Y', '--', first.root],
    ['--format=%Y', '--', second.root],
  ]);
  assertStatusReadOnly(status, [HASH_A, HASH_B]);
});

test('status disables ambient curl configuration before probing the cache', t => {
  const status = createStatusFixture(t);
  const curlConfig = [
    'insecure',
    `user = "operator:${STATUS_TOKEN_VALUE}"`,
    'request = "DELETE"',
    `output = "${status.fixture.statePaths.ambientOutput}"`,
    `trace-ascii = "${status.fixture.statePaths.ambientTrace}"`,
    '',
  ].join('\n');
  fs.writeFileSync(status.fixture.statePaths.curlConfig, curlConfig);
  const unchangedFiles = new Map([
    status.fixture.statePaths.ca,
    status.fixture.statePaths.cacheState,
    status.fixture.statePaths.curlConfig,
    status.fixture.statePaths.privateKey,
    status.fixture.statePaths.token,
  ].map(file => [file, fs.readFileSync(file)]));

  const result = runStatus(status);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(readJsonLines(status.fixture.statePaths.curlLog), [[
    '--disable', '--cacert', status.fixture.statePaths.ca,
    '--silent', '--show-error', '--write-out', '\n%{http_code}',
    '--', STATUS_CACHE_URL,
  ]]);
  assert.equal(fs.existsSync(status.fixture.statePaths.ambientOutput), false);
  assert.equal(fs.existsSync(status.fixture.statePaths.ambientTrace), false);
  for (const [file, contents] of unchangedFiles) {
    assert.deepEqual(fs.readFileSync(file), contents);
  }
  assert.equal(fs.existsSync(status.fixture.statePaths.pending), false);
});

test('status defines an absent queue as empty with no pending age', t => {
  const status = createStatusFixture(t);

  const result = runStatus(status);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(statusOutputLines(result).includes('queue-count=0'));
  assert.ok(statusOutputLines(result).includes('oldest-pending-age-seconds=none'));
  assert.ok(statusOutputLines(result).includes('broken-root=none'));
  assert.equal(fs.existsSync(status.fixture.statePaths.pending), false);
});

test('status distinguishes TLS transport failure from an unhealthy cache response', async t => {
  const cases = [
    {
      name: 'TLS transport failure',
      env: { STATUS_CURL_FAIL: '1' },
      expected: ['tls-health=unhealthy', 'cache-health=unhealthy'],
    },
    {
      name: 'HTTP cache failure after successful TLS',
      env: { STATUS_HTTP_STATUS: '503' },
      expected: ['tls-health=healthy', 'cache-health=unhealthy'],
    },
    {
      name: 'non-public cache state',
      env: { STATUS_CACHE_RESPONSE: JSON.stringify(validCacheState({ is_public: false })) },
      expected: ['tls-health=healthy', 'cache-health=unhealthy'],
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, child => {
      const status = createStatusFixture(child);

      const result = runStatus(status, fixtureCase.env);

      assert.notEqual(result.status, 0);
      for (const line of fixtureCase.expected) {
        assert.ok(statusOutputLines(result).includes(line));
      }
      assert.ok(statusOutputLines(result).includes('configured-live-key-match=unavailable'));
      assert.ok(statusOutputLines(result).includes('status=unhealthy'));
      assert.ok(statusOutputLines(result).includes('post-build-hook-match=true'));
      assert.ok(statusOutputLines(result).includes('queue-count=0'));
    });
  }
});

test('status rejects mismatched and noncanonical live cache identities', async t => {
  const cases = [
    ['mismatch', `darwin:${'A'.repeat(43)}=`, 'configured-live-key-match=false'],
    ['noncanonical live key', NONCANONICAL_CACHE_PUBLIC_KEY, 'configured-live-key-match=unavailable'],
  ];

  for (const [name, liveKey, expectedLine] of cases) {
    await t.test(name, child => {
      const status = createStatusFixture(child);

      const result = runStatus(status, {
        STATUS_CACHE_RESPONSE: JSON.stringify(validCacheState({ public_key: liveKey })),
      });

      assert.notEqual(result.status, 0);
      assert.ok(statusOutputLines(result).includes(expectedLine));
      assert.ok(statusOutputLines(result).includes('status=unhealthy'));
    });
  }
});

test('status detects effective hook and substituter drift without dumping full Nix config', async t => {
  const cases = [
    {
      name: 'hook drift',
      env: { STATUS_EFFECTIVE_HOOK: '/fixture/unexpected-hook' },
      expected: [
        'effective-post-build-hook=/fixture/unexpected-hook',
        'post-build-hook-match=false',
        'substituters-match=true',
      ],
    },
    {
      name: 'local substituter absent',
      env: { STATUS_EFFECTIVE_SUBSTITUTERS: STATUS_UPSTREAM_SUBSTITUTERS.join(' ') },
      expected: [
        'post-build-hook-match=true',
        'substituters-match=false',
      ],
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, child => {
      const status = createStatusFixture(child);

      const result = runStatus(status, fixtureCase.env);

      assert.notEqual(result.status, 0);
      for (const line of fixtureCase.expected) {
        assert.ok(statusOutputLines(result).includes(line));
      }
      assert.deepEqual(readJsonLines(status.fixture.statePaths.nixLog), [
        ['config', 'show', 'post-build-hook'],
        ['config', 'show', 'substituters'],
      ]);
      assert.ok(statusOutputLines(result).includes('status=unhealthy'));
    });
  }
});

test('status reports every invalid root in lexical order and ages only publishable entries', t => {
  const status = createStatusFixture(t);
  fs.mkdirSync(status.fixture.statePaths.pending, { recursive: true });
  const notSymlink = path.join(status.fixture.statePaths.pending, HASH_A);
  fs.writeFileSync(notSymlink, 'invalid queue entry');
  const broken = createPendingRoot(status.fixture, HASH_B, 'broken-status-output', { broken: true });
  const valid = createPendingRoot(status.fixture, HASH_C, 'valid-status-output');
  const mismatched = createPendingRoot(status.fixture, HASH_D, 'mismatched-status-output');
  fs.rmSync(mismatched.root);
  fs.symlinkSync(valid.output, mismatched.root);

  const result = runStatus(status, {
    STATUS_STAT_MTIMES: JSON.stringify({ [valid.root]: 875 }),
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(statusOutputLines(result).filter(line => line.startsWith('broken-root=')), [
    `broken-root=${notSymlink} reason=not-a-symlink`,
    `broken-root=${broken.root} reason=broken-symlink`,
    `broken-root=${mismatched.root} reason=root-name-does-not-match-target`,
  ]);
  assert.ok(statusOutputLines(result).includes('queue-count=1'));
  assert.ok(statusOutputLines(result).includes('oldest-pending-age-seconds=125'));
  assert.ok(statusOutputLines(result).includes('status=unhealthy'));
  assert.equal(fs.readFileSync(notSymlink, 'utf8'), 'invalid queue entry');
  assert.equal(fs.lstatSync(broken.root).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(valid.root).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(mismatched.root).isSymbolicLink(), true);
});

test('status redacts poisoned values from output, executable, temporary files, and logs', t => {
  const status = createStatusFixture(t);
  const credentialedSubstituter = `https://operator:${STATUS_TOKEN_VALUE}@cache.example.test/path?token=${STATUS_TOKEN_VALUE}`;
  const valid = createPendingRoot(status.fixture, HASH_A, 'valid-poison-status-output');
  const broken = createPendingRoot(status.fixture, HASH_B, 'broken-poison-status-output', { broken: true });
  const outsideTarget = path.join(status.fixture.root, 'outside-store-output');
  const malformed = path.join(status.fixture.statePaths.pending, HASH_C);
  fs.mkdirSync(outsideTarget);
  fs.symlinkSync(outsideTarget, malformed);
  const unchangedFiles = new Map([
    status.fixture.statePaths.ca,
    status.fixture.statePaths.cacheState,
    status.fixture.statePaths.privateKey,
    status.fixture.statePaths.token,
  ].map(file => [file, fs.readFileSync(file)]));
  const unchangedRoots = new Map([valid.root, broken.root, malformed].map(
    root => [root, fs.readlinkSync(root)],
  ));

  const result = runStatus(status, {
    STATUS_CACHE_RESPONSE: `{"public_key":"${STATUS_PRIVATE_KEY_VALUE}"`,
    STATUS_CURL_STDERR: STATUS_TOKEN_VALUE,
    STATUS_DATE_STDERR: STATUS_PRIVATE_KEY_VALUE,
    STATUS_EFFECTIVE_SUBSTITUTERS: `${status.expectedSubstituters} ${credentialedSubstituter}`,
    STATUS_NIX_STDERR: STATUS_PRIVATE_KEY_VALUE,
    STATUS_READLINK_STDERR: STATUS_TOKEN_VALUE,
    STATUS_STAT_MTIMES: JSON.stringify({ [valid.root]: 900 }),
    STATUS_STAT_STDERR: STATUS_PRIVATE_KEY_VALUE,
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(statusOutputLines(result).includes('effective-substituter=https://<redacted>@cache.example.test/path?<redacted>'));
  assert.ok(statusOutputLines(result).includes('queue-count=1'));
  assert.ok(statusOutputLines(result).includes('oldest-pending-age-seconds=100'));
  assert.ok(statusOutputLines(result).includes(`broken-root=${broken.root} reason=broken-symlink`));
  assert.ok(statusOutputLines(result).includes(`broken-root=${malformed} reason=target-outside-store`));
  assert.deepEqual(readJsonLines(status.fixture.statePaths.dateLog), [['+%s']]);
  assert.deepEqual(readJsonLines(status.fixture.statePaths.readlinkLog), [
    ['--', valid.root],
    ['--', malformed],
  ]);
  assert.deepEqual(readJsonLines(status.fixture.statePaths.statLog), [
    ['--format=%Y', '--', valid.root],
  ]);
  const observable = [
    result.stdout,
    result.stderr,
    fs.readFileSync(status.executable, 'utf8'),
    ...[
      status.fixture.statePaths.curlLog,
      status.fixture.statePaths.dateLog,
      status.fixture.statePaths.nixLog,
      status.fixture.statePaths.readlinkLog,
      status.fixture.statePaths.statLog,
    ].filter(fs.existsSync).map(file => fs.readFileSync(file, 'utf8')),
  ].join('\n');
  for (const secret of [STATUS_TOKEN_VALUE, STATUS_PRIVATE_KEY_VALUE]) {
    assert.equal(observable.includes(secret), false);
  }
  assert.deepEqual(fs.readdirSync(status.fixture.tmp), []);
  for (const [file, contents] of unchangedFiles) {
    assert.deepEqual(fs.readFileSync(file), contents);
  }
  for (const [root, target] of unchangedRoots) {
    assert.equal(fs.readlinkSync(root), target);
  }
  assertStatusReadOnly(status, [HASH_A, HASH_B, HASH_C]);
  assert.equal(fs.lstatSync(outsideTarget).isDirectory(), true);
});

test('script harness injects executable and state paths inside an isolated fixture', t => {
  const fixture = createScriptFixture({
    executables: {
      publisherProbe: `
        process.stdout.write(JSON.stringify({
          executable: process.argv[1],
          pending: process.env.LOCAL_BINARY_CACHE_PENDING,
          state: process.env.LOCAL_BINARY_CACHE_STATE,
        }));
      `,
    },
    statePaths: {
      pending: 'state/pending',
      state: 'state/publisher',
    },
  });
  t.after(fixture.cleanup);

  const result = runScript(fixture.executables.publisherProbe, [], {
    fixture,
    env: {
      LOCAL_BINARY_CACHE_PENDING: fixture.statePaths.pending,
      LOCAL_BINARY_CACHE_STATE: fixture.statePaths.state,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    executable: fixture.executables.publisherProbe,
    pending: fixture.statePaths.pending,
    state: fixture.statePaths.state,
  });

  for (const injectedPath of [
    ...Object.values(fixture.executables),
    ...Object.values(fixture.statePaths),
  ]) {
    assert.equal(path.isAbsolute(injectedPath), true);
    assert.equal(path.relative(fixture.root, injectedPath).startsWith('..'), false);
    assert.equal(injectedPath.startsWith('/nix/store/'), false);
  }
});

test('bootstrap preflight validates identity and reports metadata without private contents', t => {
  const bootstrap = createBootstrapFixture(t);

  const result = runBootstrap(bootstrap);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(fs.readdirSync(bootstrap.fixture.tmp), []);
  assert.equal(result.stdout, [
    `ca-certificate path=${bootstrap.fixture.statePaths.ca} owner=fixture-public-owner mode=0644`,
    `tls-certificate path=${bootstrap.fixture.statePaths.tlsCertificate} owner=fixture-public-owner mode=0644`,
    `tls-private-key path=${bootstrap.fixture.statePaths.tlsKey} owner=${LOGIN_USER} mode=0400`,
    `jwt-public-key path=${bootstrap.fixture.statePaths.jwtPublic} owner=fixture-public-owner mode=0644`,
    `jwt-private-key path=${bootstrap.fixture.statePaths.jwtPrivate} owner=root mode=0400`,
    '',
  ].join('\n'));

  const privateMaterial = [
    fs.readFileSync(bootstrap.fixture.statePaths.tlsKey, 'utf8'),
    fs.readFileSync(bootstrap.fixture.statePaths.jwtPrivate, 'utf8'),
  ];
  for (const secret of privateMaterial) {
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(fs.readFileSync(bootstrap.executable, 'utf8').includes(secret), false);
  }
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticAdminLog), []);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog), []);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.curlLog), []);
});

test('bootstrap preflight validates runtime private-key symlink targets', t => {
  const bootstrap = createBootstrapFixture(t);
  for (const field of ['tlsKey', 'jwtPrivate']) {
    const runtimePath = bootstrap.fixture.statePaths[field];
    const target = `${runtimePath}.target`;
    fs.renameSync(runtimePath, target);
    fs.symlinkSync(target, runtimePath);
  }

  const result = runBootstrap(bootstrap);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`path=${bootstrap.fixture.statePaths.tlsKey}`));
  assert.ok(result.stdout.includes(`path=${bootstrap.fixture.statePaths.jwtPrivate}`));
});

test('bootstrap preflight rejects missing or inexact TLS SANs', async t => {
  const cases = [
    ['missing SAN', bootstrap => bootstrap.materials.noSanLeaf],
    ['inexact SAN', bootstrap => bootstrap.materials.wrongSanLeaf],
  ];

  for (const [name, selectCertificate] of cases) {
    await t.test(name, child => {
      const bootstrap = createBootstrapFixture(child);
      fs.copyFileSync(selectCertificate(bootstrap), bootstrap.fixture.statePaths.tlsCertificate);

      const result = runBootstrap(bootstrap);

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(bootstrap.fixture.statePaths.tlsCertificate));
      assert.ok(result.stderr.includes(`DNS:${BOOTSTRAP_HOSTNAME}`));
    });
  }
});

test('bootstrap preflight requires serverAuth and CA verification for the TLS leaf', async t => {
  const cases = [
    ['missing serverAuth', bootstrap => bootstrap.materials.noServerAuthLeaf, /serverAuth/],
    ['leaf signed by another CA', bootstrap => bootstrap.materials.wrongCaLeaf, /CA|verify/],
  ];

  for (const [name, selectCertificate, diagnostic] of cases) {
    await t.test(name, child => {
      const bootstrap = createBootstrapFixture(child);
      fs.copyFileSync(selectCertificate(bootstrap), bootstrap.fixture.statePaths.tlsCertificate);

      const result = runBootstrap(bootstrap);

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(bootstrap.fixture.statePaths.tlsCertificate));
      assert.match(result.stderr, diagnostic);
    });
  }
});

test('bootstrap preflight rejects mismatched TLS and RS256 keypairs', async t => {
  const cases = [
    {
      name: 'TLS keypair',
      privatePath: bootstrap => bootstrap.fixture.statePaths.tlsKey,
      publicPath: bootstrap => bootstrap.fixture.statePaths.tlsCertificate,
      replace: bootstrap => bootstrap.materials.otherTlsKey,
    },
    {
      name: 'RS256 keypair',
      privatePath: bootstrap => bootstrap.fixture.statePaths.jwtPrivate,
      publicPath: bootstrap => bootstrap.fixture.statePaths.jwtPublic,
      replace: bootstrap => bootstrap.materials.otherJwtPrivate,
    },
  ];

  for (const keypair of cases) {
    await t.test(keypair.name, child => {
      const bootstrap = createBootstrapFixture(child);
      const privatePath = keypair.privatePath(bootstrap);
      fs.chmodSync(privatePath, 0o600);
      fs.copyFileSync(keypair.replace(bootstrap), privatePath);
      fs.chmodSync(privatePath, 0o400);

      const result = runBootstrap(bootstrap);

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(privatePath));
      assert.ok(result.stderr.includes(keypair.publicPath(bootstrap)));
      assert.match(result.stderr, /do not match/);
    });
  }
});

test('bootstrap preflight rejects a matching TLS key with inconsistent private parameters', t => {
  const bootstrap = createBootstrapFixture(t, { tlsKey: getIdentityMaterials().invalidTlsKey });
  const certificatePublic = runOpenSSL([
    'x509', '-in', bootstrap.fixture.statePaths.tlsCertificate, '-pubkey', '-noout',
  ], bootstrap.fixture.root);
  const privatePublic = runOpenSSL([
    'pkey', '-in', bootstrap.fixture.statePaths.tlsKey, '-pubout',
  ], bootstrap.fixture.root);
  const consistency = childProcess.spawnSync(getOpenSSLExecutable(), [
    'pkey', '-in', bootstrap.fixture.statePaths.tlsKey, '-check', '-noout',
  ], { encoding: 'utf8' });
  assert.equal(certificatePublic, privatePublic);
  assert.notEqual(consistency.status, 0, 'test fixture must fail OpenSSL private-key consistency checking');

  const result = runBootstrap(bootstrap);

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(bootstrap.fixture.statePaths.tlsKey));
  assert.match(result.stderr, /internal consistency/);
  assert.equal(result.stdout.includes(fs.readFileSync(bootstrap.fixture.statePaths.tlsKey, 'utf8')), false);
  assert.equal(result.stderr.includes(fs.readFileSync(bootstrap.fixture.statePaths.tlsKey, 'utf8')), false);
});

test('bootstrap preflight rejects RSA-PSS-restricted JWT keys as non-RS256', t => {
  const materials = getIdentityMaterials();
  const bootstrap = createBootstrapFixture(t, {
    jwtPrivate: materials.jwtPssPrivate,
    jwtPublic: materials.jwtPssPublic,
  });
  const consistency = childProcess.spawnSync(getOpenSSLExecutable(), [
    'pkey', '-in', bootstrap.fixture.statePaths.jwtPrivate, '-check', '-noout',
  ], { encoding: 'utf8' });
  assert.equal(consistency.status, 0, consistency.stderr);

  const result = runBootstrap(bootstrap);

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(bootstrap.fixture.statePaths.jwtPublic));
  assert.ok(result.stderr.includes(bootstrap.fixture.statePaths.jwtPrivate));
  assert.match(result.stderr, /RS256.*PKCS#1 v1\.5/);
  assert.deepEqual(fs.readdirSync(bootstrap.fixture.tmp), []);
  assert.equal(result.stdout.includes(fs.readFileSync(bootstrap.fixture.statePaths.jwtPrivate, 'utf8')), false);
  assert.equal(result.stderr.includes(fs.readFileSync(bootstrap.fixture.statePaths.jwtPrivate, 'utf8')), false);
});

test('bootstrap preflight enforces private-key ownership and exact 0400 modes', async t => {
  const cases = [
    {
      name: 'TLS key mode',
      options: { tlsKeyMode: 0o600 },
      path: bootstrap => bootstrap.fixture.statePaths.tlsKey,
      diagnostic: /0400/,
    },
    {
      name: 'TLS key owner',
      options: { tlsKeyOwner: 'root' },
      path: bootstrap => bootstrap.fixture.statePaths.tlsKey,
      diagnostic: new RegExp(LOGIN_USER),
    },
    {
      name: 'JWT key mode',
      options: { jwtPrivateMode: 0o440 },
      path: bootstrap => bootstrap.fixture.statePaths.jwtPrivate,
      diagnostic: /0400/,
    },
    {
      name: 'JWT key owner',
      options: { jwtPrivateOwner: LOGIN_USER },
      path: bootstrap => bootstrap.fixture.statePaths.jwtPrivate,
      diagnostic: /root/,
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, child => {
      const bootstrap = createBootstrapFixture(child, fixtureCase.options);

      const result = runBootstrap(bootstrap);

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(fixtureCase.path(bootstrap)));
      assert.match(result.stderr, fixtureCase.diagnostic);
    });
  }
});

test('bootstrap preflight rejects absent public artifacts with path-specific diagnostics', async t => {
  const cases = [
    ['CA certificate', 'ca'],
    ['TLS certificate', 'tlsCertificate'],
    ['JWT public key', 'jwtPublic'],
  ];

  for (const [name, field] of cases) {
    await t.test(name, child => {
      const bootstrap = createBootstrapFixture(child, { [field]: null });

      const result = runBootstrap(bootstrap);

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(bootstrap.fixture.statePaths[field]));
      assert.match(result.stderr, /missing|unavailable/);
    });
  }
});

test('bootstrap preflight rejects absent private artifacts with path-specific diagnostics', async t => {
  for (const field of ['tlsKey', 'jwtPrivate']) {
    await t.test(field, child => {
      const bootstrap = createBootstrapFixture(child, { [field]: null });

      const result = runBootstrap(bootstrap);

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(bootstrap.fixture.statePaths[field]));
      assert.match(result.stderr, /missing|unavailable/);
    });
  }
});

test('bootstrap preflight rejects unreadable or malformed artifacts', async t => {
  const cases = [
    { field: 'ca', mode: 0o000, diagnostic: /readable/ },
    { field: 'tlsCertificate', mode: 0o000, diagnostic: /readable/ },
    { field: 'jwtPublic', mode: 0o000, diagnostic: /readable/ },
    { field: 'ca', malformed: true, diagnostic: /CA certificate/ },
    { field: 'tlsCertificate', malformed: true, diagnostic: /TLS certificate/ },
    { field: 'tlsKey', malformed: true, diagnostic: /TLS private key/ },
    { field: 'jwtPublic', malformed: true, diagnostic: /RS256 public key/ },
    { field: 'jwtPrivate', malformed: true, diagnostic: /RS256 private key/ },
  ];

  for (const fixtureCase of cases) {
    await t.test(`${fixtureCase.field} ${fixtureCase.malformed ? 'malformed' : 'unreadable'}`, child => {
      const bootstrap = createBootstrapFixture(child);
      const artifactPath = bootstrap.fixture.statePaths[fixtureCase.field];
      if (fixtureCase.malformed) {
        fs.chmodSync(artifactPath, 0o600);
        fs.writeFileSync(artifactPath, 'unmistakably-test-only-invalid-cryptographic-material\n');
        if (['tlsKey', 'jwtPrivate'].includes(fixtureCase.field)) {
          fs.chmodSync(artifactPath, 0o400);
        }
      } else {
        fs.chmodSync(artifactPath, fixtureCase.mode);
      }

      const result = runBootstrap(bootstrap);

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(artifactPath));
      assert.match(result.stderr, fixtureCase.diagnostic);
    });
  }
});

test('legacy anonymous 404 bootstrap creates and verifies darwin, captures its key, and writes scoped host tokens', t => {
  const bootstrap = createBootstrapFixture(t);

  const result = runBootstrap(bootstrap, ['bootstrap']);

  assert.equal(result.status, 0, result.stderr);
  const atticInvocations = readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog);
  assert.deepEqual(atticInvocations.map(invocation => invocation.args), [[
    'cache', 'create', '--public', '--priority', '30',
    '--upstream-cache-key-name', 'cache.nixos.org-1',
    '--upstream-cache-key-name', 'nix-community.cachix.org-1',
    'local:darwin',
  ]]);
  assert.match(atticInvocations[0].config, /default-server = "local"/);
  assert.match(atticInvocations[0].config, new RegExp(`endpoint = "${CACHE_ENDPOINT}"`));
  assert.match(atticInvocations[0].config, /token-file = "[^"]+"/);

  const curlInvocations = readJsonLines(bootstrap.fixture.statePaths.curlLog);
  assert.equal(curlInvocations.length, 2);
  assert.deepEqual(curlInvocations.map(args => args.at(-1)), [
    `${CACHE_ENDPOINT}/_api/v1/cache-config/${CACHE_NAME}`,
    `${CACHE_ENDPOINT}/_api/v1/cache-config/${CACHE_NAME}`,
  ]);
  assert.equal(curlInvocations.flat().some(arg => /authorization/i.test(arg)), false);

  const adminInvocations = readJsonLines(bootstrap.fixture.statePaths.atticAdminLog);
  assert.deepEqual(adminInvocations.map(invocation => [
    invocation.args[0],
    '<runtime-config>',
    ...invocation.args.slice(2),
  ]), [
    [
      '-f', '<runtime-config>', 'make-token',
      '--sub', 'local-binary-cache-bootstrap',
      '--validity', '5m',
      '--create-cache', CACHE_NAME,
    ],
    [
      '-f', '<runtime-config>', 'make-token',
      '--sub', 'Brandons-MacBook-Pro',
      '--validity', '1y',
      '--push', CACHE_NAME,
    ],
    [
      '-f', '<runtime-config>', 'make-token',
      '--sub', 'ShopifyLaptop',
      '--validity', '1y',
      '--push', CACHE_NAME,
    ],
  ]);
  assert.equal(adminInvocations.every(invocation => invocation.configMode === '0600'), true);
  assert.equal(adminInvocations.every(invocation => invocation.configHasExpectedSecret), true);

  assert.equal(
    fs.readFileSync(bootstrap.fixture.statePaths.cachePublicKeyOutput, 'utf8'),
    `${CACHE_PUBLIC_KEY}\n`,
  );
  assert.equal(
    fs.readFileSync(bootstrap.fixture.statePaths.personalTokenOutput, 'utf8'),
    `${PERSONAL_TOKEN_VALUE}\n`,
  );
  assert.equal(
    fs.readFileSync(bootstrap.fixture.statePaths.shopifyTokenOutput, 'utf8'),
    `${SHOPIFY_TOKEN_VALUE}\n`,
  );
  assert.equal(fs.statSync(bootstrap.fixture.statePaths.personalTokenOutput).mode & 0o777, 0o400);
  assert.equal(fs.statSync(bootstrap.fixture.statePaths.shopifyTokenOutput).mode & 0o777, 0o400);

  const privateKey = fs.readFileSync(bootstrap.fixture.statePaths.jwtPrivate, 'utf8');
  const observable = [
    result.stdout,
    result.stderr,
    JSON.stringify(atticInvocations),
    JSON.stringify(adminInvocations),
    JSON.stringify(curlInvocations),
    fs.readFileSync(bootstrap.executable, 'utf8'),
  ].join('\n');
  for (const secret of [privateKey, PERSONAL_TOKEN_VALUE, SHOPIFY_TOKEN_VALUE]) {
    assert.equal(observable.includes(secret), false);
  }
});

test('bootstrap treats an initial anonymous 401 as an ambiguous create candidate and verifies public state', t => {
  const bootstrap = createBootstrapFixture(t);

  const result = runBootstrap(bootstrap, ['bootstrap'], {
    CURL_STATUS_SEQUENCE: JSON.stringify(['401']),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJsonLines(bootstrap.fixture.statePaths.curlLog).length, 2);
  assert.deepEqual(
    readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog).map(invocation => invocation.args),
    [[
      'cache', 'create', '--public', '--priority', '30',
      '--upstream-cache-key-name', 'cache.nixos.org-1',
      '--upstream-cache-key-name', 'nix-community.cachix.org-1',
      'local:darwin',
    ]],
  );
  assert.deepEqual(
    readJsonLines(bootstrap.fixture.statePaths.atticAdminLog).map(invocation => (
      invocation.args[invocation.args.indexOf('--sub') + 1]
    )),
    ['local-binary-cache-bootstrap', 'Brandons-MacBook-Pro', 'ShopifyLaptop'],
  );
  assert.equal(
    fs.readFileSync(bootstrap.fixture.statePaths.cachePublicKeyOutput, 'utf8'),
    `${CACHE_PUBLIC_KEY}\n`,
  );
  assertBootstrapObservabilityRedacted(bootstrap, result);
});

test('bootstrap 401 create conflict preserves a private cache and leaves all outputs absent', t => {
  const privateState = validCacheState({ is_public: false });
  const bootstrap = createBootstrapFixture(t, {
    cacheState: privateState,
  });
  const originalState = fs.readFileSync(bootstrap.fixture.statePaths.cacheState);

  const result = runBootstrap(bootstrap, ['bootstrap'], {
    ATTIC_CREATE_FAIL_MESSAGE: 'CacheAlreadyExists',
    ATTIC_CREATE_FAIL_STATUS: '17',
    CURL_STATUS_SEQUENCE: JSON.stringify(['401']),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to create public darwin cache/);
  assert.deepEqual(fs.readFileSync(bootstrap.fixture.statePaths.cacheState), originalState);
  const atticInvocations = readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog);
  assert.equal(atticInvocations.length, 1);
  assert.deepEqual(atticInvocations[0].args.slice(0, 2), ['cache', 'create']);
  assert.equal(atticInvocations[0].args.some(arg => /configure|destroy|delete/i.test(arg)), false);
  assert.deepEqual(
    readJsonLines(bootstrap.fixture.statePaths.atticAdminLog).map(invocation => (
      invocation.args[invocation.args.indexOf('--sub') + 1]
    )),
    ['local-binary-cache-bootstrap'],
  );
  assertNoBootstrapOutputs(bootstrap);
  assertBootstrapObservabilityRedacted(bootstrap, result);
});

test('bootstrap 401 create authentication failure leaves all outputs absent', t => {
  const bootstrap = createBootstrapFixture(t);

  const result = runBootstrap(bootstrap, ['bootstrap'], {
    ATTIC_CREATE_FAIL_MESSAGE: 'Unauthorized',
    ATTIC_CREATE_FAIL_STATUS: '18',
    CURL_STATUS_SEQUENCE: JSON.stringify(['401']),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to create public darwin cache/);
  assert.equal(fs.existsSync(bootstrap.fixture.statePaths.cacheState), false);
  assert.equal(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog).length, 1);
  assert.deepEqual(
    readJsonLines(bootstrap.fixture.statePaths.atticAdminLog).map(invocation => (
      invocation.args[invocation.args.indexOf('--sub') + 1]
    )),
    ['local-binary-cache-bootstrap'],
  );
  assertNoBootstrapOutputs(bootstrap);
  assertBootstrapObservabilityRedacted(bootstrap, result);
});

test('ready and configured-identity bootstrap reject anonymous 401 without create', async t => {
  const cases = [
    {
      name: 'ready',
      operation: 'ready',
      options: { configuredCachePublicKeyValue: CACHE_PUBLIC_KEY },
    },
    {
      name: 'configured identity bootstrap',
      operation: 'bootstrap',
      options: { configuredCachePublicKeyValue: CACHE_PUBLIC_KEY },
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, child => {
      const bootstrap = createBootstrapFixture(child, fixtureCase.options);

      const result = runBootstrap(bootstrap, [fixtureCase.operation], {
        CURL_STATUS_SEQUENCE: JSON.stringify(['401']),
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /HTTP 401|ready|configured|identity/i);
      assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog), []);
      assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticAdminLog), []);
      assertNoBootstrapOutputs(bootstrap);
      assertBootstrapObservabilityRedacted(bootstrap, result);
    });
  }
});

test('bootstrap rejects post-create anonymous 401 before token or trust outputs are committed', t => {
  const bootstrap = createBootstrapFixture(t);

  const result = runBootstrap(bootstrap, ['bootstrap'], {
    CURL_STATUS_SEQUENCE: JSON.stringify(['401', '401']),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not anonymously visible after creation \(HTTP 401\)/);
  assert.equal(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog).length, 1);
  assert.deepEqual(
    readJsonLines(bootstrap.fixture.statePaths.atticAdminLog).map(invocation => (
      invocation.args[invocation.args.indexOf('--sub') + 1]
    )),
    ['local-binary-cache-bootstrap'],
  );
  assertNoBootstrapOutputs(bootstrap);
  assertBootstrapObservabilityRedacted(bootstrap, result);
});

test('bootstrap reuses a matching live cache without creating or replacing its identity', t => {
  const bootstrap = createBootstrapFixture(t, {
    cacheState: validCacheState(),
    configuredCachePublicKeyValue: CACHE_PUBLIC_KEY,
  });

  const result = runBootstrap(bootstrap, ['bootstrap']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog), []);
  assert.equal(readJsonLines(bootstrap.fixture.statePaths.curlLog).length, 1);
  assert.deepEqual(
    readJsonLines(bootstrap.fixture.statePaths.atticAdminLog).map(invocation => (
      invocation.args[invocation.args.indexOf('--sub') + 1]
    )),
    ['Brandons-MacBook-Pro', 'ShopifyLaptop'],
  );
  assert.equal(
    fs.readFileSync(bootstrap.fixture.statePaths.cachePublicKeyOutput, 'utf8'),
    `${CACHE_PUBLIC_KEY}\n`,
  );
});

test('ready verifies anonymous cache state and configured key without mutating bootstrap outputs', t => {
  const bootstrap = createBootstrapFixture(t, {
    cacheState: validCacheState(),
    configuredCachePublicKeyFile: CACHE_PUBLIC_KEY,
  });

  const result = runBootstrap(bootstrap, ['ready']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog), []);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticAdminLog), []);
  assert.equal(readJsonLines(bootstrap.fixture.statePaths.curlLog).length, 1);
  for (const output of [
    bootstrap.fixture.statePaths.cachePublicKeyOutput,
    bootstrap.fixture.statePaths.personalTokenOutput,
    bootstrap.fixture.statePaths.shopifyTokenOutput,
  ]) {
    assert.equal(fs.existsSync(output), false);
  }
});

test('cache identity guards refuse missing or mismatched state without creating or issuing tokens', async t => {
  const cases = [
    {
      name: 'ready cache missing',
      operation: 'ready',
      options: { configuredCachePublicKeyValue: CACHE_PUBLIC_KEY },
    },
    {
      name: 'anonymous access denied for a non-public cache',
      operation: 'bootstrap',
      options: {},
      env: { CURL_FORCED_STATUS: '403' },
    },
    {
      name: 'bootstrap cache missing after identity was configured',
      operation: 'bootstrap',
      options: { configuredCachePublicKeyValue: CACHE_PUBLIC_KEY },
    },
    {
      name: 'bootstrap live key mismatch',
      operation: 'bootstrap',
      options: {
        cacheState: validCacheState({ public_key: `darwin:${'A'.repeat(43)}=` }),
        configuredCachePublicKeyValue: CACHE_PUBLIC_KEY,
      },
    },
    {
      name: 'ready live key mismatch',
      operation: 'ready',
      options: {
        cacheState: validCacheState({ public_key: `darwin:${'A'.repeat(43)}=` }),
        configuredCachePublicKeyFile: CACHE_PUBLIC_KEY,
      },
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, child => {
      const bootstrap = createBootstrapFixture(child, fixtureCase.options);

      const result = runBootstrap(bootstrap, [fixtureCase.operation], fixtureCase.env);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cache|identity|key|ready/i);
      assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog), []);
      assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticAdminLog), []);
      for (const output of [
        bootstrap.fixture.statePaths.cachePublicKeyOutput,
        bootstrap.fixture.statePaths.personalTokenOutput,
        bootstrap.fixture.statePaths.shopifyTokenOutput,
      ]) {
        assert.equal(fs.existsSync(output), false);
      }
    });
  }
});

test('bootstrap fails closed when anonymous observed state differs from the cache contract', async t => {
  const cases = [
    ['private cache', validCacheState({ is_public: false })],
    ['wrong priority', validCacheState({ priority: 41 })],
    ['missing upstream filter', validCacheState({ upstream_cache_key_names: [UPSTREAM_CACHE_KEYS[0]] })],
    ['extra upstream filter', validCacheState({
      upstream_cache_key_names: [...UPSTREAM_CACHE_KEYS, 'unapproved.example-1'],
    })],
    ['missing public key', validCacheState({ public_key: '' })],
  ];

  for (const [name, createdState] of cases) {
    await t.test(name, child => {
      const bootstrap = createBootstrapFixture(child);

      const result = runBootstrap(bootstrap, ['bootstrap'], {
        ATTIC_CREATED_STATE: JSON.stringify(createdState),
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cache.*state|public|priority|upstream|key/i);
      assert.equal(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog).length, 1);
      assert.deepEqual(
        readJsonLines(bootstrap.fixture.statePaths.atticAdminLog).map(invocation => (
          invocation.args[invocation.args.indexOf('--sub') + 1]
        )),
        ['local-binary-cache-bootstrap'],
      );
      for (const output of [
        bootstrap.fixture.statePaths.cachePublicKeyOutput,
        bootstrap.fixture.statePaths.personalTokenOutput,
        bootstrap.fixture.statePaths.shopifyTokenOutput,
      ]) {
        assert.equal(fs.existsSync(output), false);
      }
    });
  }
});

test('bootstrap rejects a malformed nonempty live signing key before capture or token issuance', t => {
  const bootstrap = createBootstrapFixture(t, {
    cacheState: validCacheState({ public_key: 'darwin:not-canonical-but-nonempty' }),
  });

  const result = runBootstrap(bootstrap, ['bootstrap']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live cache signing public key.*canonical/i);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog), []);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticAdminLog), []);
  assertNoBootstrapOutputs(bootstrap);
});

test('bootstrap rejects a live signing key with noncanonical Base64 padding before token issuance', t => {
  const bootstrap = createBootstrapFixture(t, {
    cacheState: validCacheState({ public_key: NONCANONICAL_CACHE_PUBLIC_KEY }),
  });

  const result = runBootstrap(bootstrap, ['bootstrap']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live cache signing public key.*canonical/i);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticAdminLog), []);
  assertNoBootstrapOutputs(bootstrap);
});

test('bootstrap rejects a configured signing key with noncanonical Base64 padding before token issuance', t => {
  const bootstrap = createBootstrapFixture(t, {
    cacheState: validCacheState({ public_key: NONCANONICAL_CACHE_PUBLIC_KEY }),
    configuredCachePublicKeyValue: NONCANONICAL_CACHE_PUBLIC_KEY,
  });

  const result = runBootstrap(bootstrap, ['bootstrap']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /configured cache signing public key.*canonical/i);
  assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticAdminLog), []);
  assertNoBootstrapOutputs(bootstrap);
});

test('bootstrap reports each host token issuance failure without partial outputs', async t => {
  const cases = [
    ['Brandons-MacBook-Pro', ['Brandons-MacBook-Pro']],
    ['ShopifyLaptop', ['Brandons-MacBook-Pro', 'ShopifyLaptop']],
  ];

  for (const [subject, expectedSubjects] of cases) {
    await t.test(subject, child => {
      const bootstrap = createBootstrapFixture(child, { cacheState: validCacheState() });

      const result = runBootstrap(bootstrap, ['bootstrap'], {
        ATTIC_ADMIN_FAIL_SUBJECT: subject,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`failed to issue token for subject ${subject}`));
      assert.deepEqual(
        readJsonLines(bootstrap.fixture.statePaths.atticAdminLog).map(invocation => (
          invocation.args[invocation.args.indexOf('--sub') + 1]
        )),
        expectedSubjects,
      );
      assertNoBootstrapOutputs(bootstrap);
      for (const secret of [PERSONAL_TOKEN_VALUE, SHOPIFY_TOKEN_VALUE]) {
        assert.equal(result.stdout.includes(secret), false);
        assert.equal(result.stderr.includes(secret), false);
      }
    });
  }
});

test('bootstrap rejects empty token output for either host without partial outputs', async t => {
  for (const subject of ['Brandons-MacBook-Pro', 'ShopifyLaptop']) {
    await t.test(subject, child => {
      const bootstrap = createBootstrapFixture(child, { cacheState: validCacheState() });

      const result = runBootstrap(bootstrap, ['bootstrap'], {
        ATTIC_ADMIN_EMPTY_SUBJECT: subject,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`empty token for subject ${subject}`));
      assertNoBootstrapOutputs(bootstrap);
    });
  }
});

test('bootstrap rejects identical host credentials without exposing or writing them', t => {
  const bootstrap = createBootstrapFixture(t, { cacheState: validCacheState() });

  const result = runBootstrap(bootstrap, ['bootstrap'], {
    ATTIC_ADMIN_IDENTICAL_HOST_TOKENS: '1',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /identical credentials for distinct host subjects/);
  assert.deepEqual(
    readJsonLines(bootstrap.fixture.statePaths.atticAdminLog).map(invocation => (
      invocation.args[invocation.args.indexOf('--sub') + 1]
    )),
    ['Brandons-MacBook-Pro', 'ShopifyLaptop'],
  );
  assertNoBootstrapOutputs(bootstrap);
  const observable = [
    result.stdout,
    result.stderr,
    fs.readFileSync(bootstrap.executable, 'utf8'),
    fs.readFileSync(bootstrap.fixture.statePaths.atticAdminLog, 'utf8'),
  ].join('\n');
  assert.equal(observable.includes(IDENTICAL_TOKEN_VALUE), false);
});

test('bootstrap refuses existing output files before cache or token mutation', async t => {
  const cases = [
    ['cache key', 'cachePublicKeyOutput', 0o644],
    ['personal token', 'personalTokenOutput', 0o400],
    ['Shopify token', 'shopifyTokenOutput', 0o400],
  ];

  for (const [name, field, mode] of cases) {
    await t.test(name, child => {
      const bootstrap = createBootstrapFixture(child);
      fs.writeFileSync(bootstrap.fixture.statePaths[field], 'existing-output-sentinel\n', { mode });

      const result = runBootstrap(bootstrap, ['bootstrap']);

      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(bootstrap.fixture.statePaths[field]));
      assert.equal(fs.readFileSync(bootstrap.fixture.statePaths[field], 'utf8'), 'existing-output-sentinel\n');
      assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticBootstrapLog), []);
      assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.atticAdminLog), []);
      assert.deepEqual(readJsonLines(bootstrap.fixture.statePaths.curlLog), []);
    });
  }
});

test('enqueue hook records every output under its deterministic store hash', t => {
  const { executable, fixture } = createEnqueueFixture(t);
  const first = `${fixture.statePaths.store}/${HASH_A}-first-output`;
  const second = `${fixture.statePaths.store}/${HASH_B}-second-output`;

  const result = runScript(executable, [], {
    fixture,
    env: enqueueEnvironment(fixture, `${first} ${second}`),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readInvocations(fixture), [
    ['--add-root', path.join(fixture.statePaths.pending, HASH_A), '--realise', first],
    ['--add-root', path.join(fixture.statePaths.pending, HASH_B), '--realise', second],
  ]);
  assert.equal(fs.readlinkSync(path.join(fixture.statePaths.pending, HASH_A)), first);
  assert.equal(fs.readlinkSync(path.join(fixture.statePaths.pending, HASH_B)), second);
});

test('enqueue hook coalesces repeated outputs onto one atomic root', t => {
  const { executable, fixture } = createEnqueueFixture(t);
  const output = `${fixture.statePaths.store}/${HASH_A}-duplicate-output`;

  const first = runScript(executable, [], {
    fixture,
    env: enqueueEnvironment(fixture, `${output} ${output}`),
  });
  const second = runScript(executable, [], {
    fixture,
    env: enqueueEnvironment(fixture, output),
  });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readInvocations(fixture), [
    ['--add-root', path.join(fixture.statePaths.pending, HASH_A), '--realise', output],
    ['--add-root', path.join(fixture.statePaths.pending, HASH_A), '--realise', output],
  ]);
  assert.deepEqual(fs.readdirSync(fixture.statePaths.pending), [HASH_A]);
  assert.equal(fs.readlinkSync(path.join(fixture.statePaths.pending, HASH_A)), output);
});

test('enqueue hook rejects invalid output lists before recording any root', async t => {
  const { executable, fixture } = createEnqueueFixture(t);
  const valid = `${fixture.statePaths.store}/${HASH_A}-valid-output`;
  const invalidCases = {
    'missing OUT_PATHS': undefined,
    'empty OUT_PATHS': '',
    'relative output': `${HASH_A}-relative`,
    'path outside the store': `${fixture.root}/${HASH_A}-outside`,
    'store directory itself': fixture.statePaths.store,
    'short store hash': `${fixture.statePaths.store}/abc-short`,
    'invalid store hash alphabet': `${fixture.statePaths.store}/${'e'.repeat(32)}-bad-alphabet`,
    'missing store name': `${fixture.statePaths.store}/${HASH_A}-`,
    'hidden store name': `${fixture.statePaths.store}/${HASH_A}-.hidden`,
    'nested path': `${fixture.statePaths.store}/${HASH_A}-name/child`,
    'dot component': `${fixture.statePaths.store}/./${HASH_A}-name`,
    'parent component': `${fixture.statePaths.store}/../store/${HASH_A}-name`,
    'empty component': `${fixture.statePaths.store}//${HASH_A}-name`,
    'case-variant store alias': `${fixture.statePaths.store.toUpperCase()}/${HASH_A}-name`,
    'newline-separated output': `${valid}\n${fixture.statePaths.store}/${HASH_B}-second`,
    'valid output followed by invalid output': `${valid} not-a-store-path`,
  };

  for (const [name, outPaths] of Object.entries(invalidCases)) {
    await t.test(name, () => {
      const result = runScript(executable, [], {
        fixture,
        env: enqueueEnvironment(fixture, outPaths),
      });

      assert.notEqual(result.status, 0, `unexpected success for ${name}`);
      assert.match(result.stderr, /OUT_PATHS|invalid output/);
      assert.equal(fs.existsSync(fixture.statePaths.pending), false, `queue state created for ${name}`);
      assert.deepEqual(readInvocations(fixture), [], `nix-store invoked for ${name}`);
    });
  }
});

test('enqueue hook reports a path-specific root creation failure', t => {
  const { executable, fixture } = createEnqueueFixture(t);
  const output = `${fixture.statePaths.store}/${HASH_A}-failing-output`;
  const root = path.join(fixture.statePaths.pending, HASH_A);

  const result = runScript(executable, [], {
    fixture,
    env: enqueueEnvironment(fixture, output, { NIX_STORE_FAIL_FOR: output }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(output.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.stderr, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(readInvocations(fixture), [
    ['--add-root', root, '--realise', output],
  ]);
  assert.equal(fs.existsSync(root), false);
});

test('post-build wrapper invokes the real enqueue once before declared hooks with unchanged environment', t => {
  const { fixture, rendered } = createPostBuildWrapperFixture(t);
  const output = `${NIX_STORE_DIRECTORY}/${HASH_A}-wrapper-output`;
  const drvPath = `${NIX_STORE_DIRECTORY}/${HASH_B}-wrapper.drv`;
  const result = runScript(rendered.wrapperExecutable, [], {
    fixture,
    env: {
      DRV_PATH: drvPath,
      HOOK_LOG: fixture.statePaths.hookLog,
      OUT_PATHS: output,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(fixture.statePaths.hookLog, 'utf8').trimEnd().split('\n').map(
    line => line.split('\t'),
  ), [
    ['enqueue', drvPath, output],
    ['first', drvPath, output],
    ['second', drvPath, output],
  ]);
  assert.equal(
    rendered.wrapperText.split(`${rendered.enqueuePackage}/bin/local-binary-cache-enqueue`).length - 1,
    1,
  );
  assert.ok(rendered.wrapperText.indexOf('/bin/local-binary-cache-enqueue')
    < rendered.wrapperText.indexOf(fixture.executables.firstHook));
  assert.ok(rendered.wrapperText.indexOf(fixture.executables.firstHook)
    < rendered.wrapperText.indexOf(fixture.executables.secondHook));
});

test('post-build wrapper makes enqueue failure fatal before chained hooks', t => {
  const { fixture, rendered } = createPostBuildWrapperFixture(t);
  const output = `${NIX_STORE_DIRECTORY}/${HASH_A}-enqueue-failure-output`;
  const result = runScript(rendered.wrapperExecutable, [], {
    fixture,
    env: {
      DRV_PATH: `${NIX_STORE_DIRECTORY}/${HASH_B}-enqueue-failure.drv`,
      ENQUEUE_FAIL_STATUS: '23',
      HOOK_LOG: fixture.statePaths.hookLog,
      OUT_PATHS: output,
    },
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(
    fs.readFileSync(fixture.statePaths.hookLog, 'utf8').trimEnd().split('\n').map(line => line.split('\t')),
    [['enqueue', `${NIX_STORE_DIRECTORY}/${HASH_B}-enqueue-failure.drv`, output]],
  );
});

test('post-build wrapper propagates chained-hook failure without invoking later hooks', t => {
  const { fixture, rendered } = createPostBuildWrapperFixture(t);
  const output = `${NIX_STORE_DIRECTORY}/${HASH_A}-chain-failure-output`;
  const drvPath = `${NIX_STORE_DIRECTORY}/${HASH_B}-chain-failure.drv`;
  const result = runScript(rendered.wrapperExecutable, [], {
    fixture,
    env: {
      DRV_PATH: drvPath,
      FIRST_HOOK_FAIL_STATUS: '31',
      HOOK_LOG: fixture.statePaths.hookLog,
      OUT_PATHS: output,
    },
  });

  assert.equal(result.status, 31);
  assert.deepEqual(fs.readFileSync(fixture.statePaths.hookLog, 'utf8').trimEnd().split('\n').map(
    line => line.split('\t'),
  ), [
    ['enqueue', drvPath, output],
    ['first', drvPath, output],
  ]);
});

test('publisher pushes valid roots in lexical order and removes each successful root', t => {
  const { executable, fixture } = createPublisherFixture(t);
  const second = createPendingRoot(fixture, HASH_B, 'second-output');
  const first = createPendingRoot(fixture, HASH_A, 'first-output');

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args), [
    ['push', '-j', '1', `local:${CACHE_NAME}`, first.output],
    ['push', '-j', '1', `local:${CACHE_NAME}`, second.output],
  ]);
  assert.equal(fs.existsSync(first.root), false);
  assert.equal(fs.existsSync(second.root), false);

  const invocations = readAtticInvocations(fixture);
  assert.equal(invocations[0].config, [
    '[servers.local]',
    `endpoint = "${CACHE_ENDPOINT}"`,
    `token-file = "${fixture.statePaths.token}"`,
    '',
  ].join('\n'));
  assert.equal([
    result.stdout,
    result.stderr,
    JSON.stringify(invocations),
    fs.readFileSync(executable, 'utf8'),
  ].join('\n').includes(TOKEN_VALUE), false);
});

test('publisher removes a root when Attic confirms it is already present', t => {
  const { executable, fixture } = createPublisherFixture(t);
  const pending = createPendingRoot(fixture, HASH_A, 'already-present');

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture, { ATTIC_ALREADY_PRESENT_FOR: pending.output }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /already present/);
  assert.equal(fs.existsSync(pending.root), false);
});

test('publisher stops at a failed root, retains the remaining queue, and retries next run', t => {
  const { executable, fixture } = createPublisherFixture(t);
  const first = createPendingRoot(fixture, HASH_A, 'first-success');
  const failed = createPendingRoot(fixture, HASH_B, 'retry-output');
  const later = createPendingRoot(fixture, HASH_C, 'later-output');
  const env = publisherEnvironment(fixture, { ATTIC_FAIL_ONCE_FOR: failed.output });

  const failedRun = runScript(executable, [], { fixture, env });

  assert.notEqual(failedRun.status, 0);
  assert.ok(failedRun.stderr.includes(failed.output));
  assert.ok(failedRun.stderr.includes(failed.root));
  assert.equal(fs.existsSync(first.root), false);
  assert.equal(fs.lstatSync(failed.root).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(later.root).isSymbolicLink(), true);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [
    first.output,
    failed.output,
  ]);

  const retryRun = runScript(executable, [], { fixture, env });

  assert.equal(retryRun.status, 0, retryRun.stderr);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [
    first.output,
    failed.output,
    failed.output,
    later.output,
  ]);
  assert.equal(fs.existsSync(failed.root), false);
  assert.equal(fs.existsSync(later.root), false);
});

test('publisher logs and retains invalid or broken entries while processing later valid roots', t => {
  const { executable, fixture } = createPublisherFixture(t);
  fs.mkdirSync(fixture.statePaths.pending, { recursive: true });
  const invalid = path.join(fixture.statePaths.pending, HASH_A);
  fs.writeFileSync(invalid, 'not a symlink');
  const broken = createPendingRoot(fixture, HASH_B, 'broken-output', { broken: true });
  const valid = createPendingRoot(fixture, HASH_C, 'valid-output');
  const mismatched = createPendingRoot(fixture, HASH_D, 'wrong-hash');
  fs.rmSync(mismatched.root);
  fs.symlinkSync(valid.output, mismatched.root);

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(invalid));
  assert.ok(result.stderr.includes(broken.root));
  assert.ok(result.stderr.includes(mismatched.root));
  assert.equal(fs.existsSync(invalid), true);
  assert.equal(fs.lstatSync(broken.root).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(mismatched.root).isSymbolicLink(), true);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [valid.output]);
  assert.equal(fs.existsSync(valid.root), false);
});

test('publisher exits successfully without work while a live publisher holds the lock', async t => {
  const { executable, fixture } = createPublisherFixture(t);
  const pending = createPendingRoot(fixture, HASH_A, 'locked-output');
  const holder = spawnPublisher(executable, fixture, holdingEnvironment(fixture, pending.output));
  t.after(() => {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      process.kill(-holder.child.pid, 'SIGKILL');
    }
  });
  await waitForPath(fixture.statePaths.ready, holder.child);

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [pending.output]);
  assert.equal(fs.lstatSync(pending.root).isSymbolicLink(), true);

  fs.writeFileSync(fixture.statePaths.release, 'release');
  const holderResult = await holder.completed;
  assert.equal(holderResult.status, 0, holderResult.stderr);
  assert.equal(fs.existsSync(pending.root), false);
});

test('publisher recovers a stale lock and retries after an unclean death', async t => {
  const { executable, fixture } = createPublisherFixture(t);
  const pending = createPendingRoot(fixture, HASH_A, 'stale-retry');
  const killed = spawnPublisher(executable, fixture, holdingEnvironment(fixture, pending.output));
  await waitForPath(fixture.statePaths.ready, killed.child);

  process.kill(-killed.child.pid, 'SIGKILL');
  const killedResult = await killed.completed;
  assert.equal(killedResult.signal, 'SIGKILL');
  assert.equal(fs.existsSync(path.join(fixture.statePaths.publisher, 'publish.lock')), true);
  assert.equal(fs.lstatSync(pending.root).isSymbolicLink(), true);

  const retry = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [
    pending.output,
    pending.output,
  ]);
  assert.equal(fs.existsSync(pending.root), false);
});

test('publisher terminates nonzero without unlinking or later work after SIGTERM', async t => {
  const { executable, fixture } = createPublisherFixture(t);
  const interrupted = createPendingRoot(fixture, HASH_A, 'interrupted-output');
  const later = createPendingRoot(fixture, HASH_B, 'later-output');
  const running = spawnPublisher(executable, fixture, holdingEnvironment(fixture, interrupted.output));
  t.after(() => {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      process.kill(-running.child.pid, 'SIGKILL');
    }
  });
  await waitForPath(fixture.statePaths.ready, running.child);

  running.child.kill('SIGTERM');
  fs.writeFileSync(fixture.statePaths.release, 'release');
  const result = await running.completed;

  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(fixture.statePaths.publisher, 'publish.lock')), false);
  assert.equal(fs.lstatSync(interrupted.root).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(later.root).isSymbolicLink(), true);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [
    interrupted.output,
  ]);
});

test('publisher reports a missing runtime token path without mutating the queue', t => {
  const { executable, fixture } = createPublisherFixture(t, { withToken: false });
  const pending = createPendingRoot(fixture, HASH_A, 'missing-token');

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(fixture.statePaths.token));
  assert.deepEqual(readAtticInvocations(fixture), []);
  assert.equal(fs.lstatSync(pending.root).isSymbolicLink(), true);
});
