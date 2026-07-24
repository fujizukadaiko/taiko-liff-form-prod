"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const environmentConfig = require("../env-config.js");

function copyConfig(overrides = {}) {
  return {
    ...environmentConfig.STAGING_CONFIG,
    ...overrides,
  };
}

test("staging設定は期待するhostnameでだけ起動を許可する", () => {
  const config = environmentConfig.STAGING_CONFIG;
  const result = environmentConfig.resolveRuntimeConfig({
    hostname: config.expectedPageHostname,
  });

  assert.equal(result.ok, true);
  assert.equal(result.config, config);
  assert.equal(config.environment, "staging");
  assert.equal(config.showEnvironmentBanner, true);
  assert.match(config.expectedPageHostname, /-staging\./);
  assert.match(new URL(config.workerBaseUrl).hostname, /-staging\./);
});

test("hostnameが異なる場合は設定値を返さずfail closedにする", () => {
  const result = environmentConfig.resolveRuntimeConfig({
    hostname: "unexpected.example.test",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "page_hostname_mismatch",
  });
  assert.equal("config" in result, false);
});

test("環境名またはstagingバナーが不正なら設定を拒否する", () => {
  assert.deepEqual(
    environmentConfig.validateEnvironmentConfig(copyConfig({
      environment: "production",
    })),
    { ok: false, error: "environment_mismatch" },
  );
  assert.deepEqual(
    environmentConfig.validateEnvironmentConfig(copyConfig({
      showEnvironmentBanner: false,
    })),
    { ok: false, error: "environment_banner_required" },
  );
});

test("別環境のWorker・Pages接続先を拒否する", () => {
  const workerResult = environmentConfig.validateEnvironmentConfig(copyConfig({
    workerBaseUrl: "https://worker.example.test",
  }));
  const pageResult = environmentConfig.validateEnvironmentConfig(copyConfig({
    expectedPageHostname: "production.example.test",
  }));

  assert.deepEqual(workerResult, {
    ok: false,
    error: "invalid_worker_config",
  });
  assert.deepEqual(pageResult, {
    ok: false,
    error: "invalid_page_host_config",
  });
});

test("GAS・LIFF設定が不正でも実値をエラーへ含めない", () => {
  const gasResult = environmentConfig.validateEnvironmentConfig(copyConfig({
    gasBaseUrl: "https://example.test/not-gas",
  }));
  const liffResult = environmentConfig.validateEnvironmentConfig(copyConfig({
    liffId: "invalid",
  }));

  assert.deepEqual(gasResult, {
    ok: false,
    error: "invalid_gas_config",
  });
  assert.deepEqual(liffResult, {
    ok: false,
    error: "invalid_liff_config",
  });
});
