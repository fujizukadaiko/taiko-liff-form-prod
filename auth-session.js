(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LineAuthSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const STAGING_WORKER_BASE_URL =
    "https://taiko-worker-plain-staging.fujizukadaiko.workers.dev";
  const DEFAULT_TIMEOUT_MS = 10000;

  const AUTH_STATES = Object.freeze({
    LOADING: "loading",
    AUTHENTICATED: "authenticated",
    REGISTERED_READ_ONLY: "registered_read_only",
    UNREGISTERED: "unregistered",
    UNAUTHENTICATED: "unauthenticated",
    DATABASE_ERROR: "database_error",
    TEMPORARY_ERROR: "temporary_error",
    NETWORK_ERROR: "network_error",
    RESPONSE_ERROR: "response_error",
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
    if (status === 503 && workerCode === "database_unavailable") {
      return makeError(AUTH_STATES.DATABASE_ERROR, workerCode, status);
    }
    if (status === 502 || status === 503) {
      return makeError(
        AUTH_STATES.TEMPORARY_ERROR,
        workerCode || "service_temporarily_unavailable",
        status,
      );
    }
    return makeError(
      AUTH_STATES.RESPONSE_ERROR,
      workerCode || "unexpected_http_response",
      status,
    );
  }

  function validateIdToken(idToken) {
    const token = typeof idToken === "string" ? idToken : "";
    if (!token || token.trim() !== token) {
      throw makeError(AUTH_STATES.UNAUTHENTICATED, "id_token_unavailable", 0);
    }
    return token;
  }

  function buildRequestHeaders(inputHeaders, idToken) {
    const headers = {};
    if (inputHeaders && typeof inputHeaders === "object") {
      const entries = typeof inputHeaders.entries === "function"
        ? [...inputHeaders.entries()]
        : Object.entries(inputHeaders);
      for (const [name, value] of entries) {
        if (String(name).toLowerCase() === "authorization") continue;
        headers[name] = value;
      }
    }
    headers.Authorization = `Bearer ${idToken}`;
    return headers;
  }

  async function authenticatedFetch_(path, options, idToken, dependencies) {
    const token = validateIdToken(idToken);
    const target = new URL(String(path || ""), STAGING_WORKER_BASE_URL);
    if (target.origin !== STAGING_WORKER_BASE_URL || !target.pathname.startsWith("/")) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_worker_target", 0);
    }

    const opts = options || {};
    const deps = dependencies || {};
    const fetchImpl = deps.fetchImpl || root.fetch;
    const AbortControllerImpl = deps.AbortControllerImpl || root.AbortController;
    const setTimeoutImpl = deps.setTimeoutImpl || root.setTimeout;
    const clearTimeoutImpl = deps.clearTimeoutImpl || root.clearTimeout;
    const timeoutMs = Number.isFinite(deps.timeoutMs)
      ? Math.max(1, Number(deps.timeoutMs))
      : DEFAULT_TIMEOUT_MS;

    if (
      typeof fetchImpl !== "function" ||
      typeof AbortControllerImpl !== "function" ||
      typeof setTimeoutImpl !== "function" ||
      typeof clearTimeoutImpl !== "function"
    ) {
      throw makeError(AUTH_STATES.NETWORK_ERROR, "network_error", 0);
    }

    const controller = new AbortControllerImpl();
    const timerId = setTimeoutImpl(function () {
      controller.abort();
    }, timeoutMs);

    try {
      let response;
      try {
        response = await fetchImpl(target.toString(), {
          method: opts.method || "GET",
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
          headers: buildRequestHeaders(opts.headers, token),
          body: opts.body,
          signal: controller.signal,
        });
      } catch (_) {
        throw makeError(
          AUTH_STATES.NETWORK_ERROR,
          controller.signal && controller.signal.aborted ? "timeout" : "network_error",
          0,
        );
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("application/json")) {
        throw makeError(
          AUTH_STATES.RESPONSE_ERROR,
          "invalid_content_type",
          response.status,
        );
      }

      let body;
      try {
        body = await response.json();
      } catch (_) {
        throw makeError(
          AUTH_STATES.RESPONSE_ERROR,
          "invalid_json_response",
          response.status,
        );
      }

      if (!response.ok) {
        const workerCode = body && typeof body === "object" && !Array.isArray(body)
          ? safeWorkerErrorCode(body.error)
          : "";
        throw classifyHttpError(response.status, workerCode);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw makeError(
          AUTH_STATES.RESPONSE_ERROR,
          "invalid_response_shape",
          response.status,
        );
      }
      return body;
    } finally {
      clearTimeoutImpl(timerId);
    }
  }

  async function verifyLineSession_(idToken, dependencies) {
    const body = await authenticatedFetch_(
      "/auth/session",
      { method: "GET" },
      idToken,
      dependencies,
    );
    if (body.ok !== true || body.authenticated !== true) {
      throw makeError(
        AUTH_STATES.UNAUTHENTICATED,
        "authentication_failed",
        200,
      );
    }
    return { ok: true, authenticated: true };
  }

  function extractHomeSummary(body) {
    if (body.ok !== true || typeof body.registered !== "boolean") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_home_summary", 200);
    }

    const members = Array.isArray(body.members)
      ? body.members
      : body.member && Array.isArray(body.member.performers)
        ? body.member.performers
        : null;
    const events = body.events === undefined && !body.registered ? [] : body.events;
    if (!members || !Array.isArray(events)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_home_summary", 200);
    }
    if (!body.registered && members.length > 0) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_home_summary", 200);
    }
    if (body.registered && members.length === 0) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_home_summary", 200);
    }

    return {
      registered: body.registered,
      memberCount: members.length,
      eventCount: events.length,
    };
  }

  async function fetchHomeSummary_(idToken, dependencies) {
    const body = await authenticatedFetch_(
      "/line/home-summary",
      { method: "GET" },
      idToken,
      dependencies,
    );
    return extractHomeSummary(body);
  }

  function extractAttendanceSummary(body) {
    const successful = body.ok === true || body.status === "ok";
    if (!successful || typeof body.registered !== "boolean") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
    }
    if (!body.map || typeof body.map !== "object" || Array.isArray(body.map)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
    }

    let attendanceCount = 0;
    for (const rows of Object.values(body.map)) {
      if (!Array.isArray(rows)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
      }
      attendanceCount += rows.length;
    }
    if (!body.registered && attendanceCount > 0) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
    }
    return { registered: body.registered, attendanceCount };
  }

  async function fetchAttendanceSummary_(idToken, dependencies) {
    const body = await authenticatedFetch_(
      "/line/attendance/all",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      idToken,
      dependencies,
    );
    return extractAttendanceSummary(body);
  }

  function getAuthUiCopy(status, reason) {
    if (status === AUTH_STATES.AUTHENTICATED) {
      return {
        title: "LINE本人認証に成功しました",
        message: "現在、テスト環境の次の準備を進めています",
      };
    }
    if (status === AUTH_STATES.UNAUTHENTICATED && reason === "worker_unauthorized") {
      return {
        title: "LINE本人認証に失敗しました。画面を閉じて、LINEから開き直してください。",
        message: "",
      };
    }
    if (status === AUTH_STATES.TEMPORARY_ERROR) {
      return {
        title: "認証サービスへ一時的に接続できません。少し時間をおいて再度お試しください。",
        message: "",
      };
    }
    if (status === AUTH_STATES.NETWORK_ERROR) {
      return {
        title: "認証サーバーへ接続できませんでした。通信環境を確認して再度お試しください。",
        message: "",
      };
    }
    return {
      title: status === AUTH_STATES.UNAUTHENTICATED
        ? "LINEの認証情報を取得できませんでした。LINEアプリ内から開き直してください。"
        : "LINE本人認証を確認しています…",
      message: "",
    };
  }

  function getReadOnlyUiCopy(status, summary) {
    const counts = summary || {};
    switch (status) {
      case AUTH_STATES.UNREGISTERED:
        return {
          title: "LINE本人認証に成功しました",
          message: "テスト環境には、まだあなたのメンバー情報が登録されていません。\n現在は安全な読み取り確認段階です。",
        };
      case AUTH_STATES.REGISTERED_READ_ONLY:
        return {
          title: "LINE本人認証に成功しました",
          message: [
            "テスト環境のメンバー情報を取得できました。",
            "現在は読み取り専用です。登録・変更操作はまだ利用できません。",
            `メンバー件数: ${Number(counts.memberCount) || 0}`,
            `予定件数: ${Number(counts.eventCount) || 0}`,
            `出欠データ件数: ${Number(counts.attendanceCount) || 0}`,
          ].join("\n"),
        };
      case AUTH_STATES.UNAUTHENTICATED:
        return {
          title: "LINE本人認証に失敗しました。画面を閉じて、LINEから開き直してください。",
          message: "",
        };
      case AUTH_STATES.DATABASE_ERROR:
        return {
          title: "テスト環境のデータベースへ接続できませんでした。少し時間をおいて再度お試しください。",
          message: "",
        };
      case AUTH_STATES.TEMPORARY_ERROR:
        return {
          title: "認証サービスへ一時的に接続できません。少し時間をおいて再度お試しください。",
          message: "",
        };
      case AUTH_STATES.NETWORK_ERROR:
        return {
          title: "サーバーへ接続できませんでした。通信環境を確認して再度お試しください。",
          message: "",
        };
      case AUTH_STATES.RESPONSE_ERROR:
        return {
          title: "サーバーから予期しない応答がありました。",
          message: "",
        };
      default:
        return {
          title: "本人情報を安全に確認しています…",
          message: "",
        };
    }
  }

  async function initializeLiffAndGetIdToken_(liff, liffId) {
    if (!liff || typeof liff.init !== "function") {
      throw makeError(AUTH_STATES.UNAUTHENTICATED, "liff_unavailable", 0);
    }
    try {
      await liff.init({ liffId });
    } catch (_) {
      throw makeError(AUTH_STATES.UNAUTHENTICATED, "liff_unavailable", 0);
    }
    if (!liff.isLoggedIn()) {
      try {
        liff.login();
      } catch (_) {
        // 共通の認証失敗へ進む。
      }
      throw makeError(AUTH_STATES.UNAUTHENTICATED, "liff_unavailable", 0);
    }

    let idToken = "";
    try {
      idToken = liff.getIDToken();
    } catch (_) {
      idToken = "";
    }
    return validateIdToken(idToken);
  }

  async function startStagingLineAuthCheck(options) {
    const opts = options || {};
    const notify = typeof opts.onState === "function" ? opts.onState : function () {};
    notify({ status: AUTH_STATES.LOADING });

    let idToken = "";
    try {
      idToken = await initializeLiffAndGetIdToken_(opts.liff, opts.liffId);
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
          ? (error.code === "liff_unavailable" || error.code === "id_token_unavailable"
              ? "liff_unavailable"
              : "worker_unauthorized")
          : "service_error",
      };
      notify(result);
      return result;
    } finally {
      idToken = "";
    }
  }

  async function startStagingAuthenticatedReadOnly(options) {
    const opts = options || {};
    const notify = typeof opts.onState === "function" ? opts.onState : function () {};
    notify({ status: AUTH_STATES.LOADING });

    let idToken = "";
    try {
      idToken = await initializeLiffAndGetIdToken_(opts.liff, opts.liffId);
      const home = await fetchHomeSummary_(idToken, opts.dependencies);
      if (!home.registered) {
        const result = {
          status: AUTH_STATES.UNREGISTERED,
          summary: {
            memberCount: home.memberCount,
            eventCount: home.eventCount,
            attendanceCount: 0,
          },
        };
        notify(result);
        return result;
      }

      const attendance = await fetchAttendanceSummary_(idToken, opts.dependencies);
      if (!attendance.registered) {
        const result = {
          status: AUTH_STATES.UNREGISTERED,
          summary: {
            memberCount: 0,
            eventCount: home.eventCount,
            attendanceCount: 0,
          },
        };
        notify(result);
        return result;
      }

      const result = {
        status: AUTH_STATES.REGISTERED_READ_ONLY,
        summary: {
          memberCount: home.memberCount,
          eventCount: home.eventCount,
          attendanceCount: attendance.attendanceCount,
        },
      };
      notify(result);
      return result;
    } catch (error) {
      const status = error instanceof AuthSessionError
        ? error.type
        : AUTH_STATES.NETWORK_ERROR;
      const result = { status };
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
    authenticatedFetch_,
    fetchAttendanceSummary_,
    fetchHomeSummary_,
    getAuthUiCopy,
    getReadOnlyUiCopy,
    startStagingAuthenticatedReadOnly,
    startStagingLineAuthCheck,
    verifyLineSession_,
  };
});
