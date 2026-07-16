'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { evalDarwinFixture } = require('./helpers');

test('render harness evaluates an isolated nix-darwin fixture', () => {
  const rendered = evalDarwinFixture(
    `{ ... }: {
      networking.hostName = "local-binary-cache-fixture";
    }`,
    `{
      hostName = config.networking.hostName;
      cacheEnabled = config.services.localBinaryCache.enable;
      hasDarwinActivation = config.system ? activationScripts;
    }`,
  );

  assert.deepEqual(rendered, {
    cacheEnabled: false,
    hasDarwinActivation: true,
    hostName: 'local-binary-cache-fixture',
  });
});
