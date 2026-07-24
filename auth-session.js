(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LineAuthSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const AUTHENTICATED_ATTENDANCE_SUBMIT_PATH =
    "/line/attendance/submit-authenticated";
  const AUTHENTICATED_MEMBER_SUBMIT_PATH =
    "/line/members/submit-authenticated";
  const MEMBER_SEGMENTS = new Set(["子どもの部", "大人の部"]);
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

  function resolveWorkerBaseUrl_(dependencies) {
    const raw = typeof dependencies?.workerBaseUrl === "string"
      ? dependencies.workerBaseUrl.trim()
      : "";
    try {
      const parsed = new URL(raw);
      if (
        !raw ||
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        parsed.origin !== raw
      ) {
        throw new Error("invalid");
      }
      return parsed.origin;
    } catch (_) {
      throw makeError(
        AUTH_STATES.RESPONSE_ERROR,
        "invalid_worker_base_url",
        0,
      );
    }
  }

  async function authenticatedFetch_(path, options, idToken, dependencies) {
    const token = validateIdToken(idToken);
    const deps = dependencies || {};
    const workerBaseUrl = resolveWorkerBaseUrl_(deps);
    const target = new URL(String(path || ""), `${workerBaseUrl}/`);
    if (target.origin !== workerBaseUrl || !target.pathname.startsWith("/")) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_worker_target", 0);
    }

    const opts = options || {};
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
      if (Number.isInteger(opts.expectedStatus) && response.status !== opts.expectedStatus) {
        throw makeError(
          AUTH_STATES.RESPONSE_ERROR,
          "unexpected_success_status",
          response.status,
        );
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
    ["データなし", "未回答"],
  ]);
  const ATTENDANCE_DRAFT_OPTIONS = Object.freeze([
    Object.freeze({ label: "出席", attend: "参加" }),
    Object.freeze({ label: "欠席", attend: "欠席" }),
    Object.freeze({ label: "未定", attend: "未定" }),
  ]);
  const ATTENDANCE_DRAFT_VALUES = new Set(
    ATTENDANCE_DRAFT_OPTIONS.map((option) => option.attend),
  );
  const MAX_DRAFT_ITEMS_PER_EVENT = 10;
  const MAX_ATTENDANCE_COMMENT_LENGTH = 100;
  const REQUEST_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const EVENT_WRITE_REASONS = new Set([
    "open",
    "inactive",
    "attendance_not_required",
    "not_published",
    "deadline_passed",
    "invalid_event_configuration",
  ]);
  const PERFORMER_WRITE_REASONS = new Set([
    ...EVENT_WRITE_REASONS,
    "viewer_only",
    "segment_missing",
    "target_group_mismatch",
  ]);
  const EVENT_WRITE_LABELS = new Map([
    ["open", "回答受付中"],
    ["inactive", "受付対象外"],
    ["attendance_not_required", "回答不要"],
    ["not_published", "現在は回答を受け付けていません（回答受付外）"],
    ["deadline_passed", "回答期限終了"],
    ["invalid_event_configuration", "受付状態を確認できません"],
  ]);
  const PERFORMER_WRITE_LABELS = new Map([
    ["open", "回答可能"],
    ["inactive", "受付対象外"],
    ["attendance_not_required", "回答不要"],
    ["not_published", "回答受付外"],
    ["deadline_passed", "回答期限終了"],
    ["invalid_event_configuration", "回答可否を確認できません"],
    ["viewer_only", "閲覧のみ"],
    ["segment_missing", "メンバー区分未設定"],
    ["target_group_mismatch", "この予定の対象外"],
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

  function validateAttendanceWrite_(value, memberNames) {
    if (!isPlainObject(value) || typeof value.eventAllowed !== "boolean") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_write", 200);
    }
    if (
      typeof value.eventReason !== "string" ||
      !EVENT_WRITE_REASONS.has(value.eventReason) ||
      !Array.isArray(value.performers)
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_write", 200);
    }
    if (
      (value.eventAllowed && value.eventReason !== "open") ||
      (!value.eventAllowed && value.eventReason === "open")
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_write", 200);
    }

    const expectedNames = new Set(memberNames);
    const seenNames = new Set();
    const performers = value.performers.map(function (performer) {
      if (!isPlainObject(performer) || typeof performer.allowed !== "boolean") {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_write", 200);
      }
      const performerName = readResponseString(performer, "performerName", {
        required: true,
        maxLength: 200,
        code: "invalid_attendance_write",
      });
      if (
        seenNames.has(performerName) ||
        !expectedNames.has(performerName) ||
        typeof performer.reason !== "string" ||
        !PERFORMER_WRITE_REASONS.has(performer.reason) ||
        (performer.allowed && performer.reason !== "open") ||
        (!performer.allowed && performer.reason === "open") ||
        (!value.eventAllowed && (
          performer.allowed || performer.reason !== value.eventReason
        ))
      ) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_write", 200);
      }
      seenNames.add(performerName);
      return {
        performerName,
        allowed: performer.allowed,
        reason: performer.reason,
      };
    });

    if (
      seenNames.size !== expectedNames.size ||
      [...expectedNames].some((performerName) => !seenNames.has(performerName))
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_write", 200);
    }

    return {
      eventAllowed: value.eventAllowed,
      eventReason: value.eventReason,
      performers,
    };
  }

  function extractHomeSummary(body) {
    if (body.ok !== true || typeof body.registered !== "boolean") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_home_summary", 200);
    }
    if (
      !isPlainObject(body.admin)
      || Object.keys(body.admin).length !== 1
      || typeof body.admin.authorized !== "boolean"
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_admin_access", 200);
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
    const memberProfileValue = isPlainObject(body.member) ? body.member : {};
    const inputName = readResponseString(memberProfileValue, "inputName", {
      nullable: true,
      maxLength: 200,
      code: "invalid_home_summary",
    });
    if (
      typeof memberProfileValue.notify !== "boolean"
      || typeof memberProfileValue.viewerOnly !== "boolean"
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_home_summary", 200);
    }
    if (!body.registered && (
      members.length > 0
      || inputName
      || memberProfileValue.notify
      || memberProfileValue.viewerOnly
    )) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_home_summary", 200);
    }
    if (body.registered && (
      !inputName
      || memberProfileValue.viewerOnly !== (members.length === 0)
    )) {
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
        maxLength: 128,
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
      const attendanceWrite = body.registered
        ? validateAttendanceWrite_(event.attendanceWrite, performerNames)
        : null;
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
        attendanceWrite,
      };
    });

    return {
      registered: body.registered,
      adminAccess: {
        authorized: body.admin.authorized,
      },
      members: normalizedMembers,
      memberProfile: {
        inputName,
        notify: memberProfileValue.notify,
        viewerOnly: memberProfileValue.viewerOnly,
        performers: normalizedMembers.map(function (member) {
          return { ...member };
        }),
      },
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
    if (!isPlainObject(body.comments)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
    }

    const memberNames = new Set((home && home.members || []).map(function (member) {
      return member.performerName;
    }));
    const normalizedMap = {};
    let attendanceCount = 0;
    for (const [eventKey, rows] of Object.entries(body.map)) {
      if (!eventKey || eventKey.length > 128) {
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
    const normalizedComments = {};
    let commentCount = 0;
    for (const [eventKey, value] of Object.entries(body.comments)) {
      if (!eventKey || eventKey.length > 128 || !isPlainObject(value)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
      }
      const comment = readResponseString(value, "comment", {
        nullable: true,
        maxLength: MAX_ATTENDANCE_COMMENT_LENGTH,
        code: "invalid_attendance_response",
      });
      readResponseString(value, "updatedAt", {
        nullable: true,
        maxLength: 64,
        code: "invalid_attendance_response",
      });
      normalizedComments[eventKey] = comment;
      commentCount += 1;
    }
    if (!body.registered && (attendanceCount > 0 || commentCount > 0)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_response", 200);
    }
    return {
      registered: body.registered,
      attendanceCount,
      map: normalizedMap,
      comments: normalizedComments,
    };
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
      const writeByPerformer = new Map(event.attendanceWrite.performers.map(function (performer) {
        return [performer.performerName, performer];
      }));
      return {
        eventKey: event.eventKey,
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
        eventAllowed: event.attendanceWrite.eventAllowed,
        eventWriteReason: event.attendanceWrite.eventReason,
        eventWriteLabel: EVENT_WRITE_LABELS.get(event.attendanceWrite.eventReason),
        initialComment: attendance.comments[event.eventKey] || "",
        performers: home.members.map(function (member) {
          const attend = attendanceByPerformer.get(member.performerName) || "未回答";
          const label = ATTENDANCE_LABELS.get(attend);
          const writeCapability = writeByPerformer.get(member.performerName);
          const writeLabel = writeCapability && PERFORMER_WRITE_LABELS.get(writeCapability.reason);
          if (!label || !writeCapability || !writeLabel) {
            throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_attendance_status", 200);
          }
          return {
            performerName: member.performerName,
            initialAttend: attend,
            attendanceLabel: label,
            attendanceWriteAllowed: writeCapability.allowed,
            attendanceWriteReason: writeCapability.reason,
            attendanceWriteLabel: writeLabel,
          };
        }),
      };
    });
    return {
      events,
      members: home.members.map((member) => ({ performerName: member.performerName })),
      memberProfile: {
        inputName: home.memberProfile.inputName,
        notify: home.memberProfile.notify,
        viewerOnly: home.memberProfile.viewerOnly,
        performers: home.memberProfile.performers.map(function (member) {
          return { ...member };
        }),
      },
      memberCount: home.memberCount,
      eventCount: events.length,
      attendanceCount: attendance.attendanceCount,
      eventAllowedCount: events.filter((event) => event.eventAllowed).length,
      performerAllowedEventCount: events.filter((event) =>
        event.performers.some((performer) => performer.attendanceWriteAllowed)
      ).length,
    };
  }

  const PRODUCTION_HOME_ATTENDANCE_CLASSES = new Map([
    ["参加", "stat-ok"],
    ["欠席", "stat-ng"],
    ["未定", "stat-pd"],
    ["未回答", "stat-na"],
    ["データなし", "stat-na"],
  ]);
  const PRODUCTION_HOME_SEGMENT_CLASSES = new Map([
    ["大人", "seg-adult"],
    ["子ども", "seg-child"],
    ["両方", "seg-both"],
  ]);

  function buildProductionHomeViewModel_(readOnlyViewModel) {
    if (!isPlainObject(readOnlyViewModel) || !Array.isArray(readOnlyViewModel.events)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_production_home_view", 0);
    }

    const events = readOnlyViewModel.events.map(function (event) {
      if (
        !isPlainObject(event) ||
        typeof event.eventAllowed !== "boolean" ||
        typeof event.eventWriteReason !== "string" ||
        !EVENT_WRITE_REASONS.has(event.eventWriteReason) ||
        event.eventWriteLabel !== EVENT_WRITE_LABELS.get(event.eventWriteReason) ||
        event.eventAllowed !== (event.eventWriteReason === "open") ||
        !Array.isArray(event.performers)
      ) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_production_home_event", 0);
      }

      const targetGroupLabel = readResponseString(event, "targetGroupLabel", {
        nullable: true,
        maxLength: 20,
        code: "invalid_production_home_event",
      });
      if (targetGroupLabel && !PRODUCTION_HOME_SEGMENT_CLASSES.has(targetGroupLabel)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_production_home_event", 0);
      }

      const performers = event.performers.map(function (performer) {
        if (
          !isPlainObject(performer) ||
          typeof performer.attendanceWriteAllowed !== "boolean" ||
          typeof performer.attendanceWriteReason !== "string" ||
          !PERFORMER_WRITE_REASONS.has(performer.attendanceWriteReason) ||
          performer.attendanceWriteLabel !==
            PERFORMER_WRITE_LABELS.get(performer.attendanceWriteReason) ||
          performer.attendanceWriteAllowed !==
            (performer.attendanceWriteReason === "open") ||
          !ATTENDANCE_LABELS.has(performer.initialAttend) ||
          performer.attendanceLabel !== ATTENDANCE_LABELS.get(performer.initialAttend)
        ) {
          throw makeError(
            AUTH_STATES.RESPONSE_ERROR,
            "invalid_production_home_performer",
            0,
          );
        }
        return {
          performerName: readResponseString(performer, "performerName", {
            required: true,
            maxLength: 200,
            code: "invalid_production_home_performer",
          }),
          attendanceLabel: performer.attendanceLabel,
          attendanceClass: PRODUCTION_HOME_ATTENDANCE_CLASSES.get(
            performer.initialAttend,
          ),
          attendanceWriteAllowed: performer.attendanceWriteAllowed,
          attendanceWriteLabel: performer.attendanceWriteLabel,
        };
      });

      return {
        eventKey: readResponseString(event, "eventKey", {
          required: true,
          maxLength: 128,
          code: "invalid_production_home_event",
        }),
        title: readResponseString(event, "title", {
          required: true,
          maxLength: 200,
          code: "invalid_production_home_event",
        }),
        dateLabel: readResponseString(event, "dateLabel", {
          required: true,
          maxLength: 40,
          code: "invalid_production_home_event",
        }),
        timeLabel: readResponseString(event, "timeLabel", {
          nullable: true,
          maxLength: 5,
          code: "invalid_production_home_event",
        }),
        place: readResponseString(event, "place", {
          nullable: true,
          maxLength: 300,
          code: "invalid_production_home_event",
        }),
        targetGroupLabel,
        targetGroupClass: targetGroupLabel
          ? PRODUCTION_HOME_SEGMENT_CLASSES.get(targetGroupLabel)
          : "",
        deadlineLabel: readResponseString(event, "deadlineLabel", {
          nullable: true,
          maxLength: 40,
          code: "invalid_production_home_event",
        }),
        attendanceWriteAllowed: event.eventAllowed,
        attendanceWriteLabel: event.eventWriteLabel,
        performers,
      };
    });

    return {
      events,
      eventCount: events.length,
      memberCount: Number.isInteger(readOnlyViewModel.memberCount)
        ? readOnlyViewModel.memberCount
        : 0,
    };
  }

  function renderProductionHome_(container, productionHomeViewModel, documentImpl) {
    if (
      !container ||
      !documentImpl ||
      typeof documentImpl.createElement !== "function" ||
      !isPlainObject(productionHomeViewModel) ||
      !Array.isArray(productionHomeViewModel.events)
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "production_home_ui_unavailable", 0);
    }

    container.textContent = "";
    container.setAttribute("role", "list");
    if (productionHomeViewModel.events.length === 0) {
      const empty = documentImpl.createElement("p");
      empty.className = "listEmpty";
      empty.textContent = "現在表示できる予定はありません。";
      container.appendChild(empty);
      return 0;
    }

    const list = documentImpl.createElement("div");
    list.className = "evList authenticatedHomeEventList";
    productionHomeViewModel.events.forEach(function (event) {
      const card = documentImpl.createElement("article");
      card.className = "eventRow authenticatedHomeEventRow";
      card.setAttribute("role", "listitem");

      const head = documentImpl.createElement("div");
      head.className = "eventHead";
      const headLeft = documentImpl.createElement("div");
      headLeft.className = "eventHead-left";
      if (event.targetGroupLabel) {
        const segment = documentImpl.createElement("span");
        segment.className = `seg-badge ${event.targetGroupClass}`;
        segment.textContent = event.targetGroupLabel;
        headLeft.appendChild(segment);
      }
      const headRight = documentImpl.createElement("div");
      headRight.className = "eventHead-right";
      const eventCapability = documentImpl.createElement("span");
      eventCapability.className = event.attendanceWriteAllowed
        ? "tag open"
        : "tag closed";
      eventCapability.textContent = event.attendanceWriteLabel;
      headRight.appendChild(eventCapability);
      head.appendChild(headLeft);
      head.appendChild(headRight);
      card.appendChild(head);

      const title = documentImpl.createElement("h3");
      title.className = "authenticatedHomeEventName";
      title.textContent = event.title;
      card.appendChild(title);

      const schedule = documentImpl.createElement("div");
      schedule.className = "eventTitle";
      const date = documentImpl.createElement("span");
      date.className = "title-date";
      date.textContent = [event.dateLabel, event.timeLabel].filter(Boolean).join(" ");
      schedule.appendChild(date);
      if (event.place) {
        const place = documentImpl.createElement("span");
        place.className = "title-place";
        place.textContent = `@ ${event.place}`;
        schedule.appendChild(place);
      }
      card.appendChild(schedule);

      if (event.deadlineLabel) {
        const deadline = documentImpl.createElement("div");
        deadline.className = "eventSub";
        deadline.textContent = `回答期限：${event.deadlineLabel}`;
        card.appendChild(deadline);
      }

      const performers = documentImpl.createElement("ul");
      performers.className = "authenticatedHomeAttendanceList";
      event.performers.forEach(function (performer) {
        const item = documentImpl.createElement("li");
        item.className = "authenticatedHomeAttendanceItem";
        const name = documentImpl.createElement("span");
        name.className = "authenticatedHomePerformerName";
        name.textContent = performer.performerName;
        const attendance = documentImpl.createElement("span");
        attendance.className = `pill sm ${performer.attendanceClass}`;
        attendance.textContent = performer.attendanceLabel;
        const capability = documentImpl.createElement("span");
        capability.className = "authenticatedHomeWriteCapability";
        capability.textContent = performer.attendanceWriteLabel;
        item.appendChild(name);
        item.appendChild(attendance);
        item.appendChild(capability);
        performers.appendChild(item);
      });
      card.appendChild(performers);
      list.appendChild(card);
    });
    container.appendChild(list);
    return productionHomeViewModel.events.length;
  }

  function draftKey_(eventIndex, performerIndex) {
    return `${eventIndex}:${performerIndex}`;
  }

  function eventDraftKey_(eventIndex) {
    return `event:${eventIndex}`;
  }

  function createAttendanceRequestId_() {
    const requestId = root?.crypto?.randomUUID?.();
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "request_id_unavailable", 0);
    }
    return requestId;
  }

  function createAttendanceDraftState_(validatedEvents) {
    if (!Array.isArray(validatedEvents)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
    }
    const draftState = new Map();
    validatedEvents.forEach(function (event, eventIndex) {
      if (!isPlainObject(event) || typeof event.eventKey !== "string" || !event.eventKey) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
      }
      if (!Array.isArray(event.performers)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
      }
      if (
        typeof event.initialComment !== "string"
        || event.initialComment.length > MAX_ATTENDANCE_COMMENT_LENGTH
      ) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
      }
      const seenPerformers = new Set();
      event.performers.forEach(function (performer, performerIndex) {
        if (
          typeof performer.performerName !== "string" ||
          !performer.performerName ||
          seenPerformers.has(performer.performerName)
        ) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
        }
        seenPerformers.add(performer.performerName);
        if (!performer.attendanceWriteAllowed) return;
        if (
          !event.eventAllowed ||
          event.eventWriteReason !== "open" ||
          performer.attendanceWriteReason !== "open" ||
          !ATTENDANCE_LABELS.has(performer.initialAttend)
        ) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
        }
        draftState.set(draftKey_(eventIndex, performerIndex), {
          eventKey: event.eventKey,
          performerName: performer.performerName,
          initialAttend: performer.initialAttend,
          selectedAttend: performer.initialAttend,
          changed: false,
        });
      });
      const commentEditable =
        event.eventAllowed === true
        && event.eventWriteReason === "open"
        && event.performers.some(function (performer) {
          return performer.attendanceWriteAllowed === true
            && performer.attendanceWriteReason === "open";
        });
      draftState.set(eventDraftKey_(eventIndex), {
        eventKey: event.eventKey,
        initialComment: event.initialComment,
        selectedComment: event.initialComment,
        commentChanged: false,
        commentEditable,
        requestId: createAttendanceRequestId_(),
      });
    });
    return draftState;
  }

  function setAttendanceDraftSelection_(draftState, key, selectedAttend) {
    if (!(draftState instanceof Map) || !draftState.has(key)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
    }
    if (!ATTENDANCE_DRAFT_VALUES.has(selectedAttend)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_selection", 0);
    }
    const current = draftState.get(key);
    const next = {
      ...current,
      selectedAttend,
      changed: selectedAttend !== current.initialAttend,
    };
    draftState.set(key, next);
    return { ...next };
  }

  function resetAttendanceDraftSelection_(draftState, key) {
    if (!(draftState instanceof Map) || !draftState.has(key)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
    }
    const current = draftState.get(key);
    const next = {
      ...current,
      selectedAttend: current.initialAttend,
      changed: false,
    };
    draftState.set(key, next);
    return { ...next };
  }

  function setAttendanceCommentDraft_(draftState, eventIndex, selectedComment) {
    const key = eventDraftKey_(eventIndex);
    if (
      !(draftState instanceof Map)
      || !draftState.has(key)
      || typeof selectedComment !== "string"
      || selectedComment.length > MAX_ATTENDANCE_COMMENT_LENGTH
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_comment_draft", 0);
    }
    const current = draftState.get(key);
    if (!current.commentEditable) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_comment_draft", 0);
    }
    const next = {
      ...current,
      selectedComment,
      commentChanged: selectedComment.trim() !== current.initialComment,
    };
    draftState.set(key, next);
    return { ...next };
  }

  function resetAttendanceCommentDraft_(draftState, eventIndex) {
    const key = eventDraftKey_(eventIndex);
    if (!(draftState instanceof Map) || !draftState.has(key)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_comment_draft", 0);
    }
    const current = draftState.get(key);
    const next = {
      ...current,
      selectedComment: current.initialComment,
      commentChanged: false,
    };
    draftState.set(key, next);
    return { ...next };
  }

  function buildAuthenticatedAttendanceDraftPayloads_(validatedEvents, draftState) {
    if (!Array.isArray(validatedEvents) || !(draftState instanceof Map)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
    }
    const payloads = [];
    validatedEvents.forEach(function (event, eventIndex) {
      if (
        !isPlainObject(event) ||
        typeof event.eventKey !== "string" ||
        !event.eventKey ||
        !Array.isArray(event.performers)
      ) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
      }
      const items = [];
      const seenPerformers = new Set();
      event.performers.forEach(function (performer, performerIndex) {
        if (
          typeof performer.performerName !== "string" ||
          !performer.performerName ||
          seenPerformers.has(performer.performerName)
        ) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
        }
        seenPerformers.add(performer.performerName);
        if (!performer.attendanceWriteAllowed) return;
        if (
          !event.eventAllowed ||
          event.eventWriteReason !== "open" ||
          performer.attendanceWriteReason !== "open"
        ) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_source", 0);
        }
        const key = draftKey_(eventIndex, performerIndex);
        const draft = draftState.get(key);
        if (
          !draft ||
          draft.eventKey !== event.eventKey ||
          draft.performerName !== performer.performerName ||
          !ATTENDANCE_LABELS.has(draft.initialAttend) ||
          draft.changed !== (draft.selectedAttend !== draft.initialAttend)
        ) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
        }
        if (!draft.changed) return;
        if (
          !ATTENDANCE_DRAFT_VALUES.has(draft.selectedAttend)
        ) {
          throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
        }
        items.push({
          performerName: performer.performerName,
          attend: draft.selectedAttend,
        });
      });
      if (items.length > MAX_DRAFT_ITEMS_PER_EVENT) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "draft_items_limit_exceeded", 0);
      }
      const eventDraft = draftState.get(eventDraftKey_(eventIndex));
      if (
        !eventDraft
        || eventDraft.eventKey !== event.eventKey
        || typeof eventDraft.initialComment !== "string"
        || typeof eventDraft.selectedComment !== "string"
        || eventDraft.selectedComment.length > MAX_ATTENDANCE_COMMENT_LENGTH
        || eventDraft.commentChanged
          !== (eventDraft.selectedComment.trim() !== eventDraft.initialComment)
        || typeof eventDraft.commentEditable !== "boolean"
        || !REQUEST_ID_PATTERN.test(eventDraft.requestId)
      ) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
      }
      if (eventDraft.commentChanged && !eventDraft.commentEditable) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
      }
      if (items.length > 0 || eventDraft.commentChanged) {
        payloads.push({
          requestId: eventDraft.requestId,
          eventKey: event.eventKey,
          mode: "merge",
          items,
          commentTouched: eventDraft.commentChanged,
          ...(eventDraft.commentChanged
            ? { comment: eventDraft.selectedComment.trim() }
            : {}),
        });
      }
    });
    return payloads;
  }

  function summarizeAttendanceDraft_(validatedEvents, draftState) {
    const payloads = buildAuthenticatedAttendanceDraftPayloads_(validatedEvents, draftState);
    return {
      changedEventCount: payloads.length,
      changedPerformerCount: payloads.reduce((count, payload) => count + payload.items.length, 0),
    };
  }

  function buildAuthenticatedAttendanceEventPayload_(validatedEvents, draftState, eventIndex) {
    if (!Number.isInteger(eventIndex) || eventIndex < 0 || eventIndex >= validatedEvents.length) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_event", 0);
    }
    const event = validatedEvents[eventIndex];
    const payloads = buildAuthenticatedAttendanceDraftPayloads_(validatedEvents, draftState);
    const matching = payloads.filter((payload) => payload.eventKey === event.eventKey);
    if (matching.length > 1) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
    }
    return matching[0] || null;
  }

  function applyConfirmedAttendanceDraft_(validatedEvents, draftState, eventIndex, items) {
    if (
      !Number.isInteger(eventIndex) ||
      eventIndex < 0 ||
      eventIndex >= validatedEvents.length ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_confirmation", 0);
    }
    const event = validatedEvents[eventIndex];
    const confirmed = new Map();
    for (const item of items) {
      if (
        !isPlainObject(item) ||
        typeof item.performerName !== "string" ||
        !ATTENDANCE_DRAFT_VALUES.has(item.attend) ||
        confirmed.has(item.performerName)
      ) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_confirmation", 0);
      }
      confirmed.set(item.performerName, item.attend);
    }

    const updates = [];
    event.performers.forEach(function (performer, performerIndex) {
      if (!confirmed.has(performer.performerName)) return;
      const key = draftKey_(eventIndex, performerIndex);
      const current = draftState.get(key);
      const attend = confirmed.get(performer.performerName);
      if (!current || current.eventKey !== event.eventKey) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_confirmation", 0);
      }
      draftState.set(key, {
        ...current,
        initialAttend: attend,
        selectedAttend: attend,
        changed: false,
      });
      updates.push({ key, attend, attendanceLabel: ATTENDANCE_LABELS.get(attend) });
      confirmed.delete(performer.performerName);
    });
    if (confirmed.size > 0 || updates.length !== items.length) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_confirmation", 0);
    }
    return updates;
  }

  function applyConfirmedAttendanceCommentDraft_(
    validatedEvents,
    draftState,
    eventIndex,
    confirmedComment,
  ) {
    if (
      !Number.isInteger(eventIndex)
      || eventIndex < 0
      || eventIndex >= validatedEvents.length
      || typeof confirmedComment !== "string"
      || confirmedComment.length > MAX_ATTENDANCE_COMMENT_LENGTH
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_confirmation", 0);
    }
    const event = validatedEvents[eventIndex];
    const key = eventDraftKey_(eventIndex);
    const current = draftState.get(key);
    if (!current || current.eventKey !== event.eventKey) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_confirmation", 0);
    }
    const next = {
      ...current,
      initialComment: confirmedComment,
      selectedComment: confirmedComment,
      commentChanged: false,
    };
    draftState.set(key, next);
    return { ...next };
  }

  function rotateAttendanceDraftRequestId_(draftState, eventIndex) {
    const key = eventDraftKey_(eventIndex);
    if (!(draftState instanceof Map) || !draftState.has(key)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_draft_state", 0);
    }
    const current = draftState.get(key);
    draftState.set(key, {
      ...current,
      requestId: createAttendanceRequestId_(),
    });
  }

  function validateAuthenticatedAttendancePayload_(payload) {
    if (!isPlainObject(payload)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_submit_payload", 0);
    }
    const topLevelKeys = Object.keys(payload);
    const hasComment = Object.prototype.hasOwnProperty.call(payload, "comment");
    if (
      !topLevelKeys.every((key) =>
        ["requestId", "eventKey", "mode", "items", "commentTouched", "comment"]
          .includes(key)
      ) ||
      topLevelKeys.length !== (hasComment ? 6 : 5) ||
      typeof payload.requestId !== "string" ||
      !REQUEST_ID_PATTERN.test(payload.requestId) ||
      typeof payload.eventKey !== "string" ||
      !payload.eventKey ||
      payload.eventKey.length > 128 ||
      payload.mode !== "merge" ||
      !Array.isArray(payload.items) ||
      payload.items.length > MAX_DRAFT_ITEMS_PER_EVENT ||
      typeof payload.commentTouched !== "boolean" ||
      payload.commentTouched !== hasComment
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_submit_payload", 0);
    }
    const comment = hasComment && typeof payload.comment === "string"
      ? payload.comment.trim()
      : "";
    if (
      (hasComment && (
        typeof payload.comment !== "string"
        || comment.length > MAX_ATTENDANCE_COMMENT_LENGTH
      ))
      || (payload.items.length === 0 && !payload.commentTouched)
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_submit_payload", 0);
    }
    const seenPerformers = new Set();
    const items = payload.items.map(function (item) {
      if (!isPlainObject(item)) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_submit_payload", 0);
      }
      const keys = Object.keys(item);
      if (
        keys.length !== 2 ||
        !keys.every((key) => ["performerName", "attend"].includes(key)) ||
        typeof item.performerName !== "string" ||
        !item.performerName ||
        item.performerName.length > 200 ||
        !ATTENDANCE_DRAFT_VALUES.has(item.attend) ||
        seenPerformers.has(item.performerName)
      ) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_submit_payload", 0);
      }
      seenPerformers.add(item.performerName);
      return { performerName: item.performerName, attend: item.attend };
    });
    return {
      requestId: payload.requestId,
      eventKey: payload.eventKey,
      mode: "merge",
      items,
      commentTouched: payload.commentTouched,
      ...(payload.commentTouched ? { comment } : {}),
    };
  }

  function getCurrentLiffIdToken_(liff) {
    if (!liff || typeof liff.getIDToken !== "function") {
      throw makeError(AUTH_STATES.UNAUTHENTICATED, "id_token_unavailable", 0);
    }
    let idToken = "";
    try {
      idToken = liff.getIDToken();
    } catch (_) {
      idToken = "";
    }
    return validateIdToken(idToken);
  }

  function validateAttendanceSubmitSuccess_(body, payload) {
    if (
      !isPlainObject(body) ||
      body.ok !== true ||
      body.status !== "ok" ||
      body.requestId !== payload.requestId ||
      !Number.isInteger(body.updatedCount) ||
      body.updatedCount !== payload.items.length ||
      typeof body.commentUpdated !== "boolean" ||
      body.commentUpdated !== payload.commentTouched
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_submit_response", 200);
    }
    return {
      updatedCount: body.updatedCount,
      commentUpdated: body.commentUpdated,
    };
  }

  function confirmSubmittedAttendance_(attendance, payload) {
    if (
      !attendance
      || attendance.registered !== true
      || !isPlainObject(attendance.map)
      || !isPlainObject(attendance.comments)
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "attendance_confirmation_failed", 200);
    }
    let rows = attendance.map[payload.eventKey];
    if (payload.items.length > 0 && !Array.isArray(rows)) {
      throw makeError(
        AUTH_STATES.RESPONSE_ERROR,
        "attendance_confirmation_failed",
        200,
      );
    }
    if (!Array.isArray(rows)) rows = [];
    const confirmed = new Map(rows.map((row) => [row.performerName, row.attend]));
    if (payload.items.some((item) => confirmed.get(item.performerName) !== item.attend)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "attendance_confirmation_failed", 200);
    }
    if (
      payload.commentTouched
      && attendance.comments[payload.eventKey] !== payload.comment
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "attendance_confirmation_failed", 200);
    }
    return {
      items: payload.items.map((item) => ({ ...item })),
      comment: payload.commentTouched ? payload.comment : null,
    };
  }

  async function submitAuthenticatedAttendancePayload_(payload, options) {
    const opts = options || {};
    const validatedPayload = validateAuthenticatedAttendancePayload_(payload);
    const home = { members: Array.isArray(opts.members) ? opts.members : [] };
    let idToken = "";
    try {
      idToken = getCurrentLiffIdToken_(opts.liff);
      const submitBody = await authenticatedFetch_(
        AUTHENTICATED_ATTENDANCE_SUBMIT_PATH,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validatedPayload),
          expectedStatus: 200,
        },
        idToken,
        opts.dependencies,
      );
      const success = validateAttendanceSubmitSuccess_(submitBody, validatedPayload);
      const attendance = await fetchAttendanceSummary_(idToken, home, opts.dependencies);
      const confirmed = confirmSubmittedAttendance_(attendance, validatedPayload);
      return {
        updatedCount: success.updatedCount,
        commentUpdated: success.commentUpdated,
        confirmedItems: confirmed.items,
        confirmedComment: confirmed.comment,
      };
    } finally {
      idToken = "";
    }
  }

  function normalizeMemberName_(value, maxLength, code) {
    if (typeof value !== "string") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, code, 0);
    }
    const normalized = value
      .replace(/\u3000/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || normalized.length > maxLength) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, code, 0);
    }
    return normalized;
  }

  function createMemberRequestId_(dependencies) {
    const createRequestId = dependencies && dependencies.createRequestId;
    const requestId = typeof createRequestId === "function"
      ? createRequestId()
      : root.crypto && typeof root.crypto.randomUUID === "function"
        ? root.crypto.randomUUID()
        : "";
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "request_id_unavailable", 0);
    }
    return requestId;
  }

  function buildAuthenticatedMemberPayload_(input, dependencies) {
    if (!isPlainObject(input)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_member_input", 0);
    }
    const keys = Object.keys(input);
    if (
      !keys.every((key) => ["mode", "inputName", "notify", "performers"].includes(key))
      || keys.length !== 4
      || !["create", "replace"].includes(input.mode)
      || typeof input.notify !== "boolean"
      || !Array.isArray(input.performers)
      || input.performers.length > 10
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_member_input", 0);
    }
    const inputName = normalizeMemberName_(
      input.inputName,
      200,
      "invalid_input_name",
    );
    const seen = new Set();
    const performers = input.performers.map(function (performer) {
      if (
        !isPlainObject(performer)
        || Object.keys(performer).length !== 2
        || !Object.keys(performer).every((key) =>
          ["performerName", "segment"].includes(key)
        )
      ) {
        throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_performer", 0);
      }
      const performerName = normalizeMemberName_(
        performer.performerName,
        200,
        "invalid_performer",
      );
      if (
        seen.has(performerName)
        || typeof performer.segment !== "string"
        || !MEMBER_SEGMENTS.has(performer.segment)
      ) {
        throw makeError(
          AUTH_STATES.RESPONSE_ERROR,
          seen.has(performerName) ? "duplicate_performer" : "invalid_segment",
          0,
        );
      }
      seen.add(performerName);
      return { performerName, segment: performer.segment };
    });
    return {
      requestId: createMemberRequestId_(dependencies),
      mode: input.mode,
      inputName,
      notify: input.notify,
      performers,
    };
  }

  function validateMemberSubmitSuccess_(body, payload) {
    if (
      !isPlainObject(body)
      || body.ok !== true
      || body.status !== "ok"
      || body.requestId !== payload.requestId
      || body.mode !== payload.mode
      || body.memberCount !== payload.performers.length
      || body.viewerOnly !== (payload.performers.length === 0)
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_member_submit_response", 200);
    }
  }

  function confirmSubmittedMember_(home, payload) {
    if (
      !home
      || home.registered !== true
      || !home.memberProfile
      || home.memberProfile.inputName !== payload.inputName
      || home.memberProfile.notify !== payload.notify
      || home.memberProfile.viewerOnly !== (payload.performers.length === 0)
      || home.members.length !== payload.performers.length
    ) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "member_confirmation_failed", 200);
    }
    const confirmed = new Map(home.members.map(function (member) {
      return [member.performerName, member.segment];
    }));
    if (payload.performers.some(function (performer) {
      return confirmed.get(performer.performerName) !== performer.segment;
    })) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "member_confirmation_failed", 200);
    }
    return home.memberProfile;
  }

  async function submitAuthenticatedMemberProfile_(input, options) {
    const opts = options || {};
    const payload = buildAuthenticatedMemberPayload_(input, opts.dependencies);
    let idToken = "";
    try {
      idToken = getCurrentLiffIdToken_(opts.liff);
      const body = await authenticatedFetch_(
        AUTHENTICATED_MEMBER_SUBMIT_PATH,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          expectedStatus: 200,
        },
        idToken,
        opts.dependencies,
      );
      validateMemberSubmitSuccess_(body, payload);
      const home = await fetchHomeSummary_(idToken, opts.dependencies);
      return {
        profile: confirmSubmittedMember_(home, payload),
        registered: true,
      };
    } finally {
      idToken = "";
    }
  }

  function classifyMemberSubmitError_(error) {
    const status = error instanceof AuthSessionError ? error.status : 0;
    const code = error instanceof AuthSessionError ? error.code : "";
    if (
      error instanceof AuthSessionError
      && error.type === AUTH_STATES.UNAUTHENTICATED
    ) return "unauthenticated";
    if (status === 403 && code === "staging_member_write_disabled") {
      return "write_disabled";
    }
    if (status === 409 && code === "already_registered") return "already_registered";
    if (status === 409 && code === "member_not_registered") return "not_registered";
    if (status === 409 && code === "idempotency_conflict") return "conflict";
    if (
      error instanceof AuthSessionError
      && error.type === AUTH_STATES.NETWORK_ERROR
    ) return "result_unknown";
    if (code === "member_confirmation_failed") return "confirmation_failed";
    return "failed";
  }

  function classifyAttendanceSubmitError_(error) {
    const status = error instanceof AuthSessionError ? error.status : 0;
    const code = error instanceof AuthSessionError ? error.code : "";
    if (
      error instanceof AuthSessionError &&
      error.type === AUTH_STATES.UNAUTHENTICATED
    ) return "unauthenticated";
    if (
      ["authentication_not_configured", "authentication_temporarily_unavailable",
        "authentication_upstream_error"].includes(code)
    ) return "authentication_unavailable";
    if (status === 403 && code === "staging_attendance_write_disabled") {
      return "write_disabled";
    }
    if (status === 403) return "not_allowed";
    if (status === 404) return "event_not_found";
    if (status === 409 && code === "comment_requires_attendance") {
      return "comment_needs_attendance";
    }
    if (status === 409 && code === "idempotency_conflict") return "response_error";
    if (status === 409) return "event_not_available";
    if ([400, 413, 415].includes(status)) return "response_error";
    if (status === 503 && code === "attendance_write_failed") return "save_unavailable";
    if (
      error instanceof AuthSessionError &&
      error.type === AUTH_STATES.NETWORK_ERROR
    ) return "network_uncertain";
    return "response_error";
  }

  function getAttendanceSubmitMessage_(state) {
    const messages = {
      saving: "保存しています…",
      saved: "変更を保存しました。",
      write_disabled: "現在、テスト環境の保存機能は停止しています。選択内容は保存されていません。",
      unauthenticated: "LINE本人認証を確認できませんでした。画面を開き直してください。",
      authentication_unavailable: "本人認証サービスを一時的に利用できません。",
      not_allowed: "現在の状態では、この回答を保存できません。画面を再読み込みしてください。",
      event_not_found: "予定を確認できません。画面を再読み込みしてください。",
      event_not_available: "受付状態が変更されたため保存できません。画面を再読み込みしてください。",
      comment_needs_attendance: "初回は出欠も選択して、コメントと一緒に保存してください。",
      save_unavailable: "一時的に保存できませんでした。時間をおいてもう一度お試しください。",
      network_uncertain: "保存結果を確認できませんでした。自動再送信は行っていません。画面を開き直して現在の回答をご確認ください。",
      response_error: "サーバーから予期しない応答がありました。",
    };
    return messages[state] || "";
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

  function renderReadOnlySchedules_(container, viewModel, documentImpl, options) {
    if (!container || !documentImpl || typeof documentImpl.createElement !== "function") {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "read_only_ui_unavailable", 0);
    }
    const model = viewModel || {};
    const opts = options || {};
    const draftPreviewEnabled = opts.enableDraftPreview === true;
    const submitUiEnabled = draftPreviewEnabled && opts.enableSubmitUi === true;
    const onDraftSummary = typeof opts.onDraftSummary === "function"
      ? opts.onDraftSummary
      : function () {};
    const onFatalError = typeof opts.onFatalError === "function"
      ? opts.onFatalError
      : function () {};
    if (!Array.isArray(model.events)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_read_only_view", 0);
    }
    if (submitUiEnabled && !Array.isArray(model.members)) {
      throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_submit_members", 0);
    }
    container.textContent = "";
    container.setAttribute("role", "list");
    const draftState = draftPreviewEnabled
      ? createAttendanceDraftState_(model.events)
      : null;
    const draftControls = new Map();
    const commentControls = new Map();
    const submitControls = new Map();
    let submitInFlight = false;
    let activeSubmitEventIndex = -1;
    const notifyDraftSummary = function () {
      if (!draftPreviewEnabled) return;
      onDraftSummary(summarizeAttendanceDraft_(model.events, draftState));
    };
    const refreshDraftControls = function () {
      if (!draftPreviewEnabled) return;
      draftControls.forEach(function (control, key) {
        control.select.disabled = submitInFlight;
      });
      commentControls.forEach(function (control) {
        control.input.disabled = submitInFlight;
      });
      submitControls.forEach(function (control, eventIndex) {
        let payload = null;
        try {
          payload = buildAuthenticatedAttendanceEventPayload_(
            model.events,
            draftState,
            eventIndex,
          );
        } catch (_) {
          control.button.hidden = true;
          onFatalError();
          return;
        }
        const hasChanges = !!payload;
        control.unsaved.hidden = !hasChanges;
        control.reset.hidden = !hasChanges;
        control.reset.disabled = submitInFlight;
        control.button.hidden = !submitUiEnabled || !hasChanges;
        control.button.disabled = submitInFlight;
        control.button.textContent = submitInFlight && activeSubmitEventIndex === eventIndex
          ? "保存しています…"
          : "この予定の変更を保存";
      });
      notifyDraftSummary();
    };
    notifyDraftSummary();
    if (model.events.length === 0) {
      const empty = documentImpl.createElement("p");
      empty.className = "readOnlyScheduleEmpty";
      empty.textContent = "現在、回答対象の予定はありません。";
      container.appendChild(empty);
      return 0;
    }

    model.events.forEach(function (event, eventIndex) {
      const card = documentImpl.createElement("article");
      const segmentClass = PRODUCTION_HOME_SEGMENT_CLASSES.get(event.targetGroupLabel) || "";
      const baseCardClass = [
        "fEvent",
        "productionAttendanceEvent",
        segmentClass ? `productionAttendanceEvent-${segmentClass}` : "",
      ].filter(Boolean).join(" ");
      card.className = baseCardClass;
      card.setAttribute("role", "listitem");

      const panelId = `attendance-event-panel-${eventIndex}`;
      const toggle = documentImpl.createElement("button");
      toggle.type = "button";
      toggle.className = "fHead productionAttendanceAccordionButton";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", panelId);

      const row1 = documentImpl.createElement("span");
      row1.className = "fRow1";
      const date = documentImpl.createElement("span");
      date.className = "t-date";
      date.textContent = [event.dateLabel, event.timeLabel].filter(Boolean).join(" ");
      row1.appendChild(date);
      if (event.targetGroupLabel) {
        const segment = documentImpl.createElement("span");
        segment.className = `seg-badge ${segmentClass}`;
        segment.textContent = event.targetGroupLabel;
        row1.appendChild(segment);
      }
      const unsaved = documentImpl.createElement("span");
      unsaved.className = "badge-unsaved";
      unsaved.textContent = "未保存";
      unsaved.hidden = true;
      row1.appendChild(unsaved);
      toggle.appendChild(row1);

      const row2 = documentImpl.createElement("span");
      row2.className = "fRow2";
      const title = documentImpl.createElement("span");
      title.className = "t-title";
      title.textContent = event.title;
      row2.appendChild(title);
      if (event.place) {
        const place = documentImpl.createElement("span");
        place.className = "t-place";
        place.textContent = `@ ${event.place}`;
        row2.appendChild(place);
      }
      toggle.appendChild(row2);

      const statusRow = documentImpl.createElement("span");
      statusRow.className = "fStatusRow";
      const statusPills = new Map();
      event.performers.forEach(function (performer, performerIndex) {
        const pill = documentImpl.createElement("span");
        pill.className = `pill sm ${
          PRODUCTION_HOME_ATTENDANCE_CLASSES.get(performer.initialAttend) || "stat-na"
        }`;
        pill.textContent = `${performer.performerName}：${performer.attendanceLabel}`;
        statusRow.appendChild(pill);
        statusPills.set(draftKey_(eventIndex, performerIndex), pill);
      });
      toggle.appendChild(statusRow);

      const sub = documentImpl.createElement("span");
      sub.className = "fSub productionAttendanceSub";
      const deadlineText = event.deadlineLabel
        ? `回答期限：${event.deadlineLabel}`
        : "回答期限：—";
      sub.textContent = `${deadlineText}／${event.eventWriteLabel}`;
      toggle.appendChild(sub);
      card.appendChild(toggle);

      const body = documentImpl.createElement("div");
      body.id = panelId;
      body.className = "fBody productionAttendanceBody";
      body.hidden = true;
      toggle.addEventListener("click", function () {
        const expanded = body.hidden;
        body.hidden = !expanded;
        card.className = expanded ? `${baseCardClass} open` : baseCardClass;
        toggle.setAttribute("aria-expanded", String(expanded));
      });

      if (event.place) {
        const placeDetail = documentImpl.createElement("p");
        placeDetail.className = "fPlaceDetail";
        placeDetail.textContent = `＠ ${event.place}`;
        body.appendChild(placeDetail);
      }

      event.performers.forEach(function (performer, performerIndex) {
        const row = documentImpl.createElement("div");
        row.className = "row-att productionAttendanceRow";
        const editable =
          draftPreviewEnabled &&
          event.eventAllowed &&
          event.eventWriteReason === "open" &&
          performer.attendanceWriteAllowed &&
          performer.attendanceWriteReason === "open";
        const name = documentImpl.createElement(editable ? "label" : "span");
        name.className = "nameLabel";
        name.textContent = performer.performerName;
        row.appendChild(name);
        const attendance = documentImpl.createElement("span");
        attendance.className = "productionAttendanceCurrent";
        attendance.textContent = performer.attendanceLabel;
        const capability = documentImpl.createElement("span");
        capability.className = performer.attendanceWriteAllowed
          ? "productionAttendanceCapability productionAttendanceCapabilityOpen"
          : "productionAttendanceCapability productionAttendanceCapabilityClosed";
        capability.textContent = performer.attendanceWriteLabel;

        if (editable) {
          const key = draftKey_(eventIndex, performerIndex);
          const selectId = `attendance-select-${eventIndex}-${performerIndex}`;
          name.setAttribute("for", selectId);
          const select = documentImpl.createElement("select");
          select.id = selectId;
          select.className = "attSel selectBtn productionAttendanceSelect";
          const placeholder = documentImpl.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "（選択してください）";
          placeholder.disabled = true;
          select.appendChild(placeholder);
          ATTENDANCE_DRAFT_OPTIONS.forEach(function (option) {
            const choice = documentImpl.createElement("option");
            choice.value = option.attend;
            choice.textContent = option.label;
            select.appendChild(choice);
          });
          select.value = ATTENDANCE_DRAFT_VALUES.has(performer.initialAttend)
            ? performer.initialAttend
            : "";
          select.addEventListener("change", function () {
            try {
              setAttendanceDraftSelection_(draftState, key, select.value);
              const submitControl = submitControls.get(eventIndex);
              if (submitControl) submitControl.status.textContent = "";
              refreshDraftControls();
            } catch (_) {
              onFatalError();
            }
          });
          row.appendChild(select);
          row.appendChild(capability);
          draftControls.set(key, {
            select,
            attendance,
            statusPill: statusPills.get(key),
            performerName: performer.performerName,
          });
        } else {
          const readOnly = documentImpl.createElement("span");
          readOnly.className = "productionAttendanceReadOnly";
          readOnly.appendChild(attendance);
          readOnly.appendChild(capability);
          row.appendChild(readOnly);
        }
        body.appendChild(row);
      });

      const eventCommentEditable =
        draftPreviewEnabled
        && event.eventAllowed
        && event.eventWriteReason === "open"
        && event.performers.some((performer) =>
          performer.attendanceWriteAllowed && performer.attendanceWriteReason === "open"
        );
      const commentDivider = documentImpl.createElement("div");
      commentDivider.className = "line";
      body.appendChild(commentDivider);
      if (eventCommentEditable) {
        const commentLabel = documentImpl.createElement("label");
        const commentId = `attendance-comment-${eventIndex}`;
        commentLabel.setAttribute("for", commentId);
        commentLabel.textContent = "コメント（任意・100文字まで）";
        body.appendChild(commentLabel);
        const commentInput = documentImpl.createElement("input");
        commentInput.type = "text";
        commentInput.id = commentId;
        commentInput.maxLength = MAX_ATTENDANCE_COMMENT_LENGTH;
        commentInput.className = "evComment productionAttendanceCommentInput";
        commentInput.value = event.initialComment;
        commentInput.addEventListener("input", function () {
          try {
            setAttendanceCommentDraft_(
              draftState,
              eventIndex,
              commentInput.value,
            );
            const submitControl = submitControls.get(eventIndex);
            if (submitControl) submitControl.status.textContent = "";
            refreshDraftControls();
          } catch (_) {
            onFatalError();
          }
        });
        body.appendChild(commentInput);
        commentControls.set(eventIndex, { input: commentInput });
      } else {
        const commentReadOnly = documentImpl.createElement("p");
        commentReadOnly.className = "commentReadOnly";
        commentReadOnly.textContent = event.initialComment
          ? `コメント：${event.initialComment}`
          : "コメント：（コメントなし）";
        body.appendChild(commentReadOnly);
      }

      if (
        draftPreviewEnabled &&
        event.eventAllowed &&
        event.eventWriteReason === "open" &&
        event.performers.some((performer) =>
          performer.attendanceWriteAllowed && performer.attendanceWriteReason === "open"
        )
      ) {
        const submitStatus = documentImpl.createElement("p");
        submitStatus.className = "attendanceSubmitStatus";
        submitStatus.setAttribute("role", "status");
        submitStatus.setAttribute("aria-live", "polite");
        submitStatus.tabIndex = -1;
        body.appendChild(submitStatus);

        const actionRow = documentImpl.createElement("div");
        actionRow.className = "productionAttendanceActions";
        const resetButton = documentImpl.createElement("button");
        resetButton.type = "button";
        resetButton.className = "btn btn-ghost productionAttendanceReset";
        resetButton.textContent = "この予定の変更を取り消す";
        resetButton.hidden = true;
        resetButton.addEventListener("click", function () {
          try {
            event.performers.forEach(function (performer, performerIndex) {
              const key = draftKey_(eventIndex, performerIndex);
              if (!draftControls.has(key)) return;
              const restored = resetAttendanceDraftSelection_(draftState, key);
              const control = draftControls.get(key);
              control.select.value = ATTENDANCE_DRAFT_VALUES.has(restored.initialAttend)
                ? restored.initialAttend
                : "";
            });
            const restoredComment = resetAttendanceCommentDraft_(
              draftState,
              eventIndex,
            );
            const commentControl = commentControls.get(eventIndex);
            if (commentControl) {
              commentControl.input.value = restoredComment.initialComment;
            }
            submitStatus.textContent = "";
            refreshDraftControls();
          } catch (_) {
            onFatalError();
          }
        });
        actionRow.appendChild(resetButton);

        const submitButton = documentImpl.createElement("button");
        submitButton.type = "button";
        submitButton.id = `attendance-submit-${eventIndex}`;
        submitButton.className = "attendanceSubmitButton";
        submitButton.textContent = "この予定の変更を保存";
        submitButton.hidden = true;
        submitButton.addEventListener("click", async function () {
          if (submitInFlight) return;
          let payload;
          try {
            payload = buildAuthenticatedAttendanceEventPayload_(
              model.events,
              draftState,
              eventIndex,
            );
            if (!payload) return;
            payload = validateAuthenticatedAttendancePayload_(payload);
          } catch (_) {
            submitStatus.textContent = getAttendanceSubmitMessage_("response_error");
            onFatalError();
            return;
          }

          submitInFlight = true;
          activeSubmitEventIndex = eventIndex;
          submitStatus.textContent = getAttendanceSubmitMessage_("saving");
          refreshDraftControls();
          try {
            const result = await submitAuthenticatedAttendancePayload_(payload, {
              liff: opts.liff,
              members: model.members,
              dependencies: opts.submitDependencies,
            });
            const updates = result.confirmedItems.length > 0
              ? applyConfirmedAttendanceDraft_(
                model.events,
                draftState,
                eventIndex,
                result.confirmedItems,
              )
              : [];
            updates.forEach(function (update) {
              const control = draftControls.get(update.key);
              if (!control) {
                throw makeError(AUTH_STATES.RESPONSE_ERROR, "invalid_confirmation", 0);
              }
              control.attendance.textContent = update.attendanceLabel;
              control.statusPill.className = `pill sm ${
                PRODUCTION_HOME_ATTENDANCE_CLASSES.get(update.attend) || "stat-na"
              }`;
              control.statusPill.textContent =
                `${control.performerName}：${update.attendanceLabel}`;
            });
            if (result.commentUpdated) {
              const confirmedComment = applyConfirmedAttendanceCommentDraft_(
                model.events,
                draftState,
                eventIndex,
                result.confirmedComment,
              );
              event.initialComment = confirmedComment.initialComment;
              const commentControl = commentControls.get(eventIndex);
              if (commentControl) {
                commentControl.input.value = confirmedComment.initialComment;
              }
            }
            rotateAttendanceDraftRequestId_(draftState, eventIndex);
            submitStatus.textContent = getAttendanceSubmitMessage_("saved");
          } catch (error) {
            submitStatus.textContent = getAttendanceSubmitMessage_(
              classifyAttendanceSubmitError_(error),
            );
          } finally {
            submitInFlight = false;
            activeSubmitEventIndex = -1;
            refreshDraftControls();
          }
        });
        actionRow.appendChild(submitButton);
        body.appendChild(actionRow);
        submitControls.set(eventIndex, {
          button: submitButton,
          reset: resetButton,
          status: submitStatus,
          unsaved,
        });
      }
      card.appendChild(body);
      container.appendChild(card);
    });
    refreshDraftControls();
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
          message: "テスト環境には、まだあなたのメンバー情報が登録されていません。\n初回登録は現在利用できません。",
        };
      case AUTH_STATES.REGISTERED_READ_ONLY:
        return {
          title: "テスト環境・本人認証済み",
          message: [
            "LINE本人認証に成功しました。",
            "回答可能な予定では、出席・欠席・未定を選び、予定ごとに保存できます。",
            "保存機能はテスト用ゲートにより停止している場合があります。画面の保存結果を確認してください。",
            `本人に紐づくメンバー件数: ${Number(counts.memberCount) || 0}`,
            `表示予定件数: ${Number(counts.eventCount) || 0}`,
            `出欠データ件数: ${Number(counts.attendanceCount) || 0}`,
            `回答受付中の予定: ${Number(counts.eventAllowedCount) || 0}件`,
            `あなたが回答可能な予定: ${Number(counts.performerAllowedEventCount) || 0}件`,
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
          adminAccess: home.adminAccess,
          memberProfile: home.memberProfile,
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
          adminAccess: home.adminAccess,
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
        adminAccess: home.adminAccess,
        memberProfile: viewModel.memberProfile,
        summary: {
          memberCount: viewModel.memberCount,
          eventCount: viewModel.eventCount,
          attendanceCount: viewModel.attendanceCount,
          eventAllowedCount: viewModel.eventAllowedCount,
          performerAllowedEventCount: viewModel.performerAllowedEventCount,
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
    AUTHENTICATED_ATTENDANCE_SUBMIT_PATH,
    AUTHENTICATED_MEMBER_SUBMIT_PATH,
    AuthSessionError,
    applyConfirmedAttendanceDraft_,
    applyConfirmedAttendanceCommentDraft_,
    authenticatedFetch_,
    buildAuthenticatedAttendanceEventPayload_,
    buildAuthenticatedAttendanceDraftPayloads_,
    buildAuthenticatedMemberPayload_,
    buildProductionHomeViewModel_,
    buildReadOnlyScheduleViewModel_,
    classifyAttendanceSubmitError_,
    classifyMemberSubmitError_,
    createAttendanceDraftState_,
    fetchAttendanceSummary_,
    fetchHomeSummary_,
    formatYmdJapanese,
    getAuthUiCopy,
    getAttendanceSubmitMessage_,
    getReadOnlyUiCopy,
    renderProductionHome_,
    renderReadOnlySchedules_,
    resetAttendanceCommentDraft_,
    resetAttendanceDraftSelection_,
    setAttendanceCommentDraft_,
    setAttendanceDraftSelection_,
    summarizeAttendanceDraft_,
    submitAuthenticatedAttendancePayload_,
    submitAuthenticatedMemberProfile_,
    startStagingAuthenticatedReadOnly,
    startStagingLineAuthCheck,
    verifyLineSession_,
  };
});
