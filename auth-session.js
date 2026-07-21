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

  const EVENT_SEGMENTS = new Map([
    ["adult", "大人"], ["大人", "大人"], ["大人の部", "大人"],
    ["child", "子ども"], ["子ども", "子ども"], ["子供", "子ども"],
    ["子どもの部", "子ども"], ["子供の部", "子ども"],
    ["both", "両方"], ["両方", "両方"],
  ]);
  const ATTENDANCE_LABELS = new Map([
    ["参加", "出席"],
    ["欠席", "欠席"],
    ["未定", "未定"],
    ["未回答", "未回答"],
  ]);
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function readResponseString(record, key, options) {
    const opts = options || {};
    const raw = record[key];
    if (raw == null && opts.nullable) return "";
    if (typeof raw !== "string") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, opts.code || "invalid_response_shape", 200);
    }
    const value = raw.trim();
    if ((opts.required && !value) || value.length > (opts.maxLength || 2000)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, opts.code || "invalid_response_shape", 200);
    }
    return value;
  }

  function parseYmd(value, code) {
    const text = String(value || "");
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    if (!match) throw makeError(AUTH_STATES.RESPONSE_ERROR, code, 200);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, code, 200);
    }
    return { year, month, day, compact: text };
  }

  function weekdayIndex(parts) {
    const monthOffsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let year = parts.year;
    if (parts.month < 3) year -= 1;
    return (
      year + Math.floor(year / 4) - Math.floor(year / 100) +
      Math.floor(year / 400) + monthOffsets[parts.month - 1] + parts.day
    ) % 7;
  }

  function formatYmdJapanese(value, code) {
    const parts = parseYmd(value, code);
    return `${parts.year}年${parts.month}月${parts.day}日（${WEEKDAYS[weekdayIndex(parts)]}）`;
  }

  function validateTime(value) {
    if (!value) return "";
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_event_time", 200);
    }
    return value;
  }

  function normalizeTargetGroup(value) {
    if (!value) return "";
    const label = EVENT_SEGMENTS.get(value);
    if (!label) throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_event_target_group", 200);
    return label;
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

    const performerNames = new Set();
    const normalizedMembers = members.map(function (member) {
      if (!isPlainObject(member)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_home_summary", 200);
      }
      const performerName = readResponseString(member, "performerName", {
        required: true,
        maxLength: 200,
        code: "invalid_home_summary",
      });
      if (performerNames.has(performerName)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "duplicate_member", 200);
      }
      performerNames.add(performerName);
      const segment = readResponseString(member, "segment", {
        nullable: true,
        maxLength: 40,
        code: "invalid_home_summary",
      });
      if (segment) normalizeTargetGroup(segment);
      return { performerName, segment };
    });

    const eventKeys = new Set();
    const normalizedEvents = events.map(function (event) {
      if (!isPlainObject(event)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_event", 200);
      }
      const eventKey = readResponseString(event, "eventKey", {
        required: true,
        maxLength: 160,
        code: "invalid_event_key",
      });
      if (eventKeys.has(eventKey)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "duplicate_event", 200);
      }
      eventKeys.add(eventKey);
      const date = readResponseString(event, "date", {
        required: true,
        maxLength: 8,
        code: "invalid_event_date",
      });
      parseYmd(date, "invalid_event_date");
      const time = validateTime(readResponseString(event, "time", {
        nullable: true,
        maxLength: 5,
        code: "invalid_event_time",
      }));
      const deadlineDate = readResponseString(event, "deadlineDate", {
        nullable: true,
        maxLength: 8,
        code: "invalid_event_deadline",
      });
      if (deadlineDate) parseYmd(deadlineDate, "invalid_event_deadline");
      const targetGroup = readResponseString(event, "targetGroup", {
        nullable: true,
        maxLength: 40,
        code: "invalid_event_target_group",
      });
      return {
        eventKey,
        title: readResponseString(event, "title", {
          required: true,
          maxLength: 200,
          code: "invalid_event_title",
        }),
        date,
        time,
        place: readResponseString(event, "place", {
          nullable: true,
          maxLength: 300,
          code: "invalid_event_place",
        }),
        targetGroup,
        targetGroupLabel: normalizeTargetGroup(targetGroup),
        deadlineDate,
        status: readResponseString(event, "status", {
          nullable: true,
          maxLength: 40,
          code: "invalid_event_status",
        }),
        note: readResponseString(event, "note", {
          nullable: true,
          maxLength: 2000,
          code: "invalid_event_note",
        }),
      };
    });

    return {
      registered: body.registered,
      members: normalizedMembers,
      events: normalizedEvents,
      memberCount: normalizedMembers.length,
      eventCount: normalizedEvents.length,
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

  function extractAttendanceSummary(body, home) {
    const successful = body.ok === true || body.status === "ok";
    if (!successful || typeof body.registered !== "boolean") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
    }
    if (!body.map || typeof body.map !== "object" || Array.isArray(body.map)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
    }

    const memberNames = new Set((home && home.members || []).map(function (member) {
      return member.performerName;
    }));
    const normalizedMap = {};
    let attendanceCount = 0;
    for (const [eventKey, rows] of Object.entries(body.map)) {
      if (!eventKey || eventKey.length > 160) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
      }
      if (!Array.isArray(rows)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
      }
      const seenPerformers = new Set();
      normalizedMap[eventKey] = rows.map(function (row) {
        if (!isPlainObject(row)) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
        }
        const performerName = readResponseString(row, "performerName", {
          required: true,
          maxLength: 200,
          code: "invalid_attendance_response",
        });
        if (!memberNames.has(performerName) || seenPerformers.has(performerName)) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
        }
        seenPerformers.add(performerName);
        const attend = readResponseString(row, "attend", {
          required: true,
          maxLength: 16,
          code: "invalid_attendance_status",
        });
        if (!ATTENDANCE_LABELS.has(attend)) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_status", 200);
        }
        attendanceCount += 1;
        return { performerName, attend };
      });
    }
    if (!body.registered && attendanceCount > 0) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
    }
    return { registered: body.registered, attendanceCount, map: normalizedMap };
  }

  async function fetchAttendanceSummary_(idToken, home, dependencies) {
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
    return extractAttendanceSummary(body, home);
  }

  function buildReadOnlyScheduleViewModel_(home, attendance) {
    const events = home.events.slice().sort(function (a, b) {
      return a.date.localeCompare(b.date)
        || (a.time || "99:99").localeCompare(b.time || "99:99")
        || a.eventKey.localeCompare(b.eventKey);
    }).map(function (event) {
      const attendanceRows = attendance.map[event.eventKey] || [];
      const attendanceByPerformer = new Map(attendanceRows.map(function (row) {
        return [row.performerName, row.attend];
      }));
      return {
        title: event.title,
        dateLabel: formatYmdJapanese(event.date, "invalid_event_date"),
        timeLabel: event.time,
        place: event.place,
        targetGroupLabel: event.targetGroupLabel,
        deadlineLabel: event.deadlineDate
          ? formatYmdJapanese(event.deadlineDate, "invalid_event_deadline")
          : "",
        status: event.status,
        note: event.note,
        performers: home.members.map(function (member) {
          const attend = attendanceByPerformer.get(member.performerName) || "未回答";
          const label = ATTENDANCE_LABELS.get(attend);
          if (!label) {
            throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_status", 200);
          }
          return { performerName: member.performerName, attendanceLabel: label };
        }),
      };
    });
    return {
      events,
      memberCount: home.memberCount,
      eventCount: events.length,
      attendanceCount: attendance.attendanceCount,
    };
  }

  function appendReadOnlyMeta_(documentImpl, parent, label, value) {
    if (!value) return;
    const row = documentImpl.createElement("div");
    row.className = "readOnlyScheduleMetaRow";
    const term = documentImpl.createElement("span");
    term.className = "readOnlyScheduleMetaLabel";
    term.textContent = label;
    const detail = documentImpl.createElement("span");
    detail.textContent = value;
    row.appendChild(term);
    row.appendChild(detail);
    parent.appendChild(row);
  }

  function renderReadOnlySchedules_(container, viewModel, documentImpl) {
    if (!container || !documentImpl || typeof documentImpl.createElement !== "function") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "read_only_ui_unavailable", 0);
    }
    const model = viewModel || {};
    if (!Array.isArray(model.events)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_read_only_view", 0);
    }
    container.textContent = "";
    container.setAttribute("role", "list");
    if (model.events.length === 0) {
      const empty = documentImpl.createElement("p");
      empty.className = "readOnlyScheduleEmpty";
      empty.textContent = "現在、回答対象の予定はありません。";
      container.appendChild(empty);
      return 0;
    }

    model.events.forEach(function (event) {
      const card = documentImpl.createElement("article");
      card.className = "readOnlyScheduleCard";
      card.setAttribute("role", "listitem");

      const title = documentImpl.createElement("h3");
      title.className = "readOnlyScheduleTitle";
      title.textContent = event.title;
      card.appendChild(title);

      const date = documentImpl.createElement("p");
      date.className = "readOnlyScheduleDate";
      date.textContent = event.dateLabel;
      card.appendChild(date);

      const meta = documentImpl.createElement("div");
      meta.className = "readOnlyScheduleMeta";
      appendReadOnlyMeta_(documentImpl, meta, "開始時刻", event.timeLabel);
      appendReadOnlyMeta_(documentImpl, meta, "場所", event.place);
      appendReadOnlyMeta_(documentImpl, meta, "対象", event.targetGroupLabel);
      appendReadOnlyMeta_(documentImpl, meta, "回答期限", event.deadlineLabel);
      appendReadOnlyMeta_(documentImpl, meta, "状態", event.status);
      appendReadOnlyMeta_(documentImpl, meta, "備考", event.note);
      if (meta.childNodes.length > 0) card.appendChild(meta);

      const attendanceTitle = documentImpl.createElement("h4");
      attendanceTitle.className = "readOnlyAttendanceTitle";
      attendanceTitle.textContent = "本人の出欠状況";
      card.appendChild(attendanceTitle);

      const performers = documentImpl.createElement("ul");
      performers.className = "readOnlyAttendanceList";
      for (const performer of event.performers) {
        const item = documentImpl.createElement("li");
        const name = documentImpl.createElement("span");
        name.className = "readOnlyPerformerName";
        name.textContent = performer.performerName;
        const attendance = documentImpl.createElement("span");
        attendance.className = "readOnlyAttendanceStatus";
        attendance.textContent = performer.attendanceLabel;
        item.appendChild(name);
        item.appendChild(attendance);
        performers.appendChild(item);
      }
      card.appendChild(performers);
      container.appendChild(card);
    });
    return model.events.length;
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
          title: "テスト環境・読み取り専用",
          message: [
            "LINE本人認証に成功しました。",
            "現在は表示確認のみです。出欠の登録・変更はまだ利用できません。",
            `本人に紐づくメンバー件数: ${Number(counts.memberCount) || 0}`,
            `表示予定件数: ${Number(counts.eventCount) || 0}`,
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

      const attendance = await fetchAttendanceSummary_(idToken, home, opts.dependencies);
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

      const viewModel = buildReadOnlyScheduleViewModel_(home, attendance);
      const result = {
        status: AUTH_STATES.REGISTERED_READ_ONLY,
        summary: {
          memberCount: viewModel.memberCount,
          eventCount: viewModel.eventCount,
          attendanceCount: viewModel.attendanceCount,
        },
        viewModel,
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
    buildReadOnlyScheduleViewModel_,
    fetchAttendanceSummary_,
    fetchHomeSummary_,
    formatYmdJapanese,
    getAuthUiCopy,
    getReadOnlyUiCopy,
    renderReadOnlySchedules_,
    startStagingAuthenticatedReadOnly,
    startStagingLineAuthCheck,
    verifyLineSession_,
  };
});
