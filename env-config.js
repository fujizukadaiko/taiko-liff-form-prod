(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TaikoEnvironmentConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STAGING_PAGE_HOSTNAME = "taiko-liff-form-staging.pages.dev";
  const STAGING_WORKER_ORIGIN =
    "https://taiko-worker-plain-staging.fujizukadaiko.workers.dev";

  const STAGING_CONFIG = Object.freeze({
    environment: "staging",
    frontVersion: "Front v6.8.0",
    liffId: "2008020568-2jVl00Rn",
    workerBaseUrl: STAGING_WORKER_ORIGIN,
    gasBaseUrl:
      "https://script.google.com/macros/s/AKfycbzaeqchlDJmkQGMKEYm9pQEOmp-GWgt0jhxRsO3Uq_G9GxaaE3n9p-fYcO6eprlLO5QLQ/exec",
    expectedPageHostname: STAGING_PAGE_HOSTNAME,
    showEnvironmentBanner: true,
  });

  function failure(code) {
    return Object.freeze({
      ok: false,
      error: String(code || "invalid_environment_config"),
    });
  }

  function parseHttpsUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      ) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function validateEnvironmentConfig(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return failure("invalid_environment_config");
    }
    if (config.environment !== "staging") {
      return failure("environment_mismatch");
    }
    if (
      typeof config.frontVersion !== "string" ||
      !config.frontVersion.trim() ||
      config.frontVersion.length > 64
    ) {
      return failure("invalid_front_version");
    }
    if (
      typeof config.liffId !== "string" ||
      !/^\d{6,20}-[A-Za-z0-9]{8,64}$/.test(config.liffId)
    ) {
      return failure("invalid_liff_config");
    }
    if (
      config.expectedPageHostname !== STAGING_PAGE_HOSTNAME ||
      !config.expectedPageHostname.includes("-staging.")
    ) {
      return failure("invalid_page_host_config");
    }
    if (config.showEnvironmentBanner !== true) {
      return failure("environment_banner_required");
    }

    const workerUrl = parseHttpsUrl(config.workerBaseUrl);
    if (
      !workerUrl ||
      workerUrl.origin !== STAGING_WORKER_ORIGIN ||
      workerUrl.pathname !== "/" ||
      workerUrl.search
    ) {
      return failure("invalid_worker_config");
    }

    const gasUrl = parseHttpsUrl(config.gasBaseUrl);
    if (
      !gasUrl ||
      gasUrl.hostname !== "script.google.com" ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(gasUrl.pathname) ||
      gasUrl.search
    ) {
      return failure("invalid_gas_config");
    }

    return Object.freeze({ ok: true, config });
  }

  function resolveRuntimeConfig(locationLike) {
    const validated = validateEnvironmentConfig(STAGING_CONFIG);
    if (!validated.ok) return validated;

    const hostname = String(locationLike && locationLike.hostname || "")
      .trim()
      .toLowerCase();
    if (hostname !== STAGING_CONFIG.expectedPageHostname) {
      return failure("page_hostname_mismatch");
    }
    return validated;
  }

  return Object.freeze({
    STAGING_CONFIG,
    validateEnvironmentConfig,
    resolveRuntimeConfig,
  });
});
