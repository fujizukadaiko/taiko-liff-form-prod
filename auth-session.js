(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LineAuthSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const STAGING_WORKER_BASE_URL =
    "https://taiko-worker-plain-staging.fujizukadaiko.workers.dev";
  const AUTH_SESSION_URL = `${STAGING_WORKER_BASE_URL}/auth/session`;
  const DEFAULT_TIMEOUT_MS = 10000;

  const AUTH_STATES = Object.freeze({
    LOADING: "loading",
    AUTHENTICATED: "authenticated",
    UNAUTHENTICATED: "unauthenticated",
    TEMPORARY_ERROR: "temporary_error",
    NETWORK_ERROR: "network_error",
    UNREGISTERED: "unregistered",
  });

  class AuthSessionError extends Error {
    constructor(type, code, status) {
      super(code);
      this.name = "AuthSessionError";
      this.type = type;
      this.code = code;
      this.status = Number.isInteger(status) ? status : 0;
    }
  }

  function makeError(type, code, status) {
    return new AuthSessionError(type, code, status);
  }

  function safeWorkerErrorCode(value) {
    const code = String(value || "");
    return /^[a-z0-9_]{1,64}$/.test(code) ? code : "";
  }

  function classifyHttpError(status, workerCode) {
    if (status === 401) {
      return makeError(
        AUTH_STATES.UNAUTHENTICATED,
        workerCode || "invalid_line_token",
        status,
      );
    }
    if (status === 502 || status === 503) {
      return makeError(
        AUTH_STATES.TEMPORARY_ERROR,
        workerCode || "authentication_temporarily_unavailable",
        status,
      );
    }
    return makeError(
      AUTH_STATES.TEMPORARY_ERROR,
      workerCode || "authentication_response_error",
      status,
    );
  }

  async function verifyLineSession_(idToken, dependencies) {
    const token = typeof idToken === "string" ? idToken : "";
    if (!token || token.trim() !== token) {
      throw makeError(AUTH_STATES.UNAUTHENTICATED, "id_token_unavailable", 0);
    }

    const deps = dependencies || {};
    const fetchImpl = deps.fetchImpl || root.fetch;
    const AbortControllerImpl = deps.AbortControllerImpl || root.AbortController;
    const setTimeoutImpl = deps.setTimeoutImpl || root.setTimeout;
    const clearTimeoutImpl = deps.clearTimeoutImpl || root.clearTimeout;
    const timeoutMs = Number.isFinite(deps.timeoutMs)
      ? Math.max(1, Number(deps.timeoutMs))
      : DEFAULT_TIMEOUT_MS;

    if (typeof fetchImpl !== "function" || typeof AbortControllerImpl !== "function") {
      throw makeError(AUTH_STATES.NETWORK_ERROR, "authentication_network_error", 0);
    }

    const controller = new AbortControllerImpl();
    const timerId = setTimeoutImpl(function () {
      controller.abort();
    }, timeoutMs);

    let response;
    try {
      response = await fetchImpl(AUTH_SESSION_URL, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
    } catch (_) {
      throw makeError(
        AUTH_STATES.NETWORK_ERROR,
        controller.signal && controller.signal.aborted
          ? "authentication_timeout"
          : "authentication_network_error",
        0,
      );
    } finally {
      clearTimeoutImpl(timerId);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const isJson = contentType.includes("application/json");
    let body = null;
    if (isJson) {
      try {
        body = await response.json();
      } catch (_) {
        throw makeError(
          AUTH_STATES.TEMPORARY_ERROR,
          "authentication_invalid_response",
          response.status,
        );
      }
    }

    if (!response.ok) {
      const workerCode = body && typeof body === "object"
        ? safeWorkerErrorCode(body.error)
        : "";
      throw classifyHttpError(response.status, workerCode);
    }

    if (!isJson || !body || typeof body !== "object") {
      throw makeError(
        AUTH_STATES.TEMPORARY_ERROR,
        "authentication_invalid_response",
        response.status,
      );
    }
    if (body.ok !== true || body.authenticated !== true) {
      throw makeError(
        AUTH_STATES.UNAUTHENTICATED,
        "authentication_failed",
        response.status,
      );
    }

    return { ok: true, authenticated: true };
  }

  function getAuthUiCopy(status, reason) {
    switch (status) {
      case AUTH_STATES.AUTHENTICATED:
        return {
          title: "LINE本人認証に成功しました",
          message: "現在、テスト環境の次の準備を進めています",
        };
      case AUTH_STATES.UNAUTHENTICATED:
        if (reason === "worker_unauthorized") {
          return {
            title: "LINE本人認証に失敗しました。画面を閉じて、LINEから開き直してください。",
            message: "",
          };
        }
        return {
          title: "LINEの認証情報を取得できませんでした。LINEアプリ内から開き直してください。",
          message: "",
        };
      case AUTH_STATES.TEMPORARY_ERROR:
        return {
          title: "認証サービスへ一時的に接続できません。少し時間をおいて再度お試しください。",
          message: "",
        };
      case AUTH_STATES.NETWORK_ERROR:
        return {
          title: "認証サーバーへ接続できませんでした。通信環境を確認して再度お試しください。",
          message: "",
        };
      default:
        return {
          title: "LINE本人認証を確認しています…",
          message: "",
        };
    }
  }

  async function startStagingLineAuthCheck(options) {
    const opts = options || {};
    const liff = opts.liff;
    const notify = typeof opts.onState === "function" ? opts.onState : function () {};

    notify({ status: AUTH_STATES.LOADING });
    if (!liff || typeof liff.init !== "function") {
      const result = {
        status: AUTH_STATES.UNAUTHENTICATED,
        reason: "liff_unavailable",
      };
      notify(result);
      return result;
    }

    try {
      await liff.init({ liffId: opts.liffId });
    } catch (_) {
      const result = {
        status: AUTH_STATES.UNAUTHENTICATED,
        reason: "liff_unavailable",
      };
      notify(result);
      return result;
    }

    if (!liff.isLoggedIn()) {
      try {
        liff.login();
      } catch (_) {
        // 下の共通エラー表示へ進む。
      }
      const result = {
        status: AUTH_STATES.UNAUTHENTICATED,
        reason: "liff_unavailable",
      };
      notify(result);
      return result;
    }

    let idToken = "";
    try {
      idToken = liff.getIDToken();
    } catch (_) {
      idToken = "";
    }
    if (typeof idToken !== "string" || !idToken.trim()) {
      idToken = "";
      const result = {
        status: AUTH_STATES.UNAUTHENTICATED,
        reason: "liff_unavailable",
      };
      notify(result);
      return result;
    }

    try {
      await verifyLineSession_(idToken, opts.dependencies);
      const result = { status: AUTH_STATES.AUTHENTICATED };
      notify(result);
      return result;
    } catch (error) {
      const status = error instanceof AuthSessionError
        ? error.type
        : AUTH_STATES.NETWORK_ERROR;
      const result = {
        status,
        reason: status === AUTH_STATES.UNAUTHENTICATED
          ? "worker_unauthorized"
          : "service_error",
      };
      notify(result);
      return result;
    } finally {
      idToken = "";
    }
  }

  return {
    AUTH_STATES,
    STAGING_WORKER_BASE_URL,
    AuthSessionError,
    getAuthUiCopy,
    startStagingLineAuthCheck,
    verifyLineSession_,
  };
});
