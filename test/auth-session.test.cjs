"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const auth = require("../auth-session.js");

const TOKEN = "header.payload.signature";

function jsonResponse(body, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? contentType : null;
      },
    },
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function makeLiff(overrides = {}) {
  return {
    async init() {},
    isLoggedIn() { return true; },
    login() {},
    getIDToken() { return TOKEN; },
    ...overrides,
  };
}

function fetchDependencies(fetchImpl, extra = {}) {
  return {
    fetchImpl,
    AbortControllerImpl: AbortController,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    timeoutMs: 100,
    ...extra,
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.attributes = {};
    this.childNodes = [];
    this._text = "";
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this.childNodes = [];
  }

  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent).join("");
  }

  appendChild(child) {
    this.childNodes.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[String(name)] = String(value);
  }
}

function fakeDocument() {
  return { createElement(tagName) { return new FakeElement(tagName); } };
}

function collectTags(root) {
  return [root.tagName, ...root.childNodes.flatMap(collectTags)];
}

function registeredHome() {
  return {
    ok: true,
    registered: true,
    member: {
      performers: [
        { performerName: "本人1", segment: "大人の部" },
        { performerName: "本人2", segment: "子どもの部" },
      ],
    },
    events: [
      {
        eventKey: "event-1",
        date: "20260726",
        title: "予定1",
        targetGroup: "both",
        time: "17:15",
        place: "会場1",
        deadlineDate: "20260725",
        status: "active",
        note: "",
        attendanceWrite: {
          eventAllowed: true,
          eventReason: "open",
          performers: [
            { performerName: "本人1", allowed: true, reason: "open" },
            { performerName: "本人2", allowed: true, reason: "open" },
          ],
        },
      },
      {
        eventKey: "event-2",
        date: "20260727",
        title: "予定2",
        targetGroup: "adult",
        time: "",
        place: "",
        deadlineDate: null,
        status: "active",
        note: "",
        attendanceWrite: {
          eventAllowed: true,
          eventReason: "open",
          performers: [
            { performerName: "本人1", allowed: true, reason: "open" },
            {
              performerName: "本人2",
              allowed: false,
              reason: "target_group_mismatch",
            },
          ],
        },
      },
    ],
  };
}

function registeredAttendance() {
  return {
    status: "ok",
    ok: true,
    registered: true,
    map: {
      "event-1": [{ performerName: "本人1", attend: "参加" }],
      "event-2": [
        { performerName: "本人1", attend: "欠席" },
        { performerName: "本人2", attend: "参加" },
      ],
    },
  };
}

test("LIFF init完了後にだけIDトークンと本人データを取得する", async () => {
  const calls = [];
  let releaseInit;
  const initGate = new Promise((resolve) => { releaseInit = resolve; });
  const liff = makeLiff({
    async init() {
      calls.push("init:start");
      await initGate;
      calls.push("init:end");
    },
    isLoggedIn() {
      calls.push("isLoggedIn");
      return true;
    },
    getIDToken() {
      calls.push("getIDToken");
      return TOKEN;
    },
  });
  const promise = auth.startStagingAuthenticatedReadOnly({
    liff,
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async (url) => {
      calls.push(new URL(url).pathname);
      return calls.includes("/line/attendance/all")
        ? jsonResponse(registeredAttendance())
        : jsonResponse(registeredHome());
    }),
  });

  await Promise.resolve();
  assert.deepEqual(calls, ["init:start"]);
  releaseInit();
  const result = await promise;
  assert.equal(result.status, auth.AUTH_STATES.REGISTERED_READ_ONLY);
  assert.deepEqual(calls, [
    "init:start",
    "init:end",
    "isLoggedIn",
    "getIDToken",
    "/line/home-summary",
    "/line/attendance/all",
  ]);
});

test("未ログインならloginを呼び、Token取得とfetchを行わない", async () => {
  let loginCount = 0;
  let tokenCount = 0;
  let fetchCount = 0;
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff({
      isLoggedIn() { return false; },
      login() { loginCount += 1; },
      getIDToken() { tokenCount += 1; return TOKEN; },
    }),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return jsonResponse(registeredHome());
    }),
  });
  assert.equal(result.status, auth.AUTH_STATES.UNAUTHENTICATED);
  assert.equal(loginCount, 1);
  assert.equal(tokenCount, 0);
  assert.equal(fetchCount, 0);
});

test("IDトークンがnullならfetchしない", async () => {
  let fetchCount = 0;
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff({ getIDToken() { return null; } }),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return jsonResponse(registeredHome());
    }),
  });
  assert.equal(result.status, auth.AUTH_STATES.UNAUTHENTICATED);
  assert.equal(fetchCount, 0);
});

test("登録済み本人の読み取りはstaging Workerへ安全な正式requestだけを送る", async () => {
  const requests = [];
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? jsonResponse(registeredHome())
        : jsonResponse(registeredAttendance());
    }),
  });

  assert.equal(result.status, auth.AUTH_STATES.REGISTERED_READ_ONLY);
  assert.deepEqual(result.summary, {
    memberCount: 2,
    eventCount: 2,
    attendanceCount: 3,
    eventAllowedCount: 2,
    performerAllowedEventCount: 2,
  });
  assert.equal(requests.length, 2);

  const home = requests[0];
  assert.equal(home.url, `${auth.STAGING_WORKER_BASE_URL}/line/home-summary`);
  assert.equal(home.options.method, "GET");
  assert.equal(home.options.body, undefined);
  assert.equal(new URL(home.url).search, "");

  const attendance = requests[1];
  assert.equal(attendance.url, `${auth.STAGING_WORKER_BASE_URL}/line/attendance/all`);
  assert.equal(attendance.options.method, "POST");
  assert.equal(attendance.options.headers["Content-Type"], "application/json");
  assert.equal(attendance.options.body, "{}");

  for (const request of requests) {
    assert.equal(request.options.mode, "cors");
    assert.equal(request.options.cache, "no-store");
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
    const serialized = `${request.url}\n${String(request.options.body || "")}`;
    assert.doesNotMatch(serialized, /lineId|line_id|lineUserId|memberId|memberIds/);
  }
});

test("本人向け予定を全件保持し、日付・時刻順の読み取り専用モデルへ変換する", async () => {
  const home = registeredHome();
  home.events = [
    { ...home.events[0], eventKey: "event-5", date: "20260730", title: "予定5", time: "09:00" },
    { ...home.events[0], eventKey: "event-3", date: "20260727", title: "予定3", time: "18:00" },
    { ...home.events[0], eventKey: "event-1", date: "20260726", title: "予定1", time: "17:15" },
    { ...home.events[0], eventKey: "event-4", date: "20260727", title: "予定4", time: "10:00" },
    { ...home.events[0], eventKey: "event-2", date: "20260726", title: "予定2", time: "19:00" },
  ];
  let requestCount = 0;
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse(home)
        : jsonResponse({ status: "ok", ok: true, registered: true, map: {} });
    }),
  });

  assert.equal(result.status, auth.AUTH_STATES.REGISTERED_READ_ONLY);
  assert.equal(result.viewModel.events.length, 5);
  assert.deepEqual(
    result.viewModel.events.map((event) => event.title),
    ["予定1", "予定2", "予定4", "予定3", "予定5"],
  );
  assert.equal(result.viewModel.events[0].dateLabel, "2026年7月26日（日）");
  assert.equal(result.viewModel.events[0].timeLabel, "17:15");
  assert.equal(result.viewModel.events[0].place, "会場1");
  assert.equal(result.viewModel.events[0].targetGroupLabel, "両方");
  for (const event of result.viewModel.events) {
    assert.deepEqual(
      event.performers.map((performer) => performer.attendanceLabel),
      ["未回答", "未回答"],
    );
  }
  const container = new FakeElement("div");
  assert.equal(auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument()), 5);
  assert.equal(collectTags(container).filter((tag) => tag === "ARTICLE").length, 5);
});

test("出欠statusを正式な日本語表示へ変換し、本人メンバーだけを保持する", async () => {
  let requestCount = 0;
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse(registeredHome())
        : jsonResponse(registeredAttendance());
    }),
  });
  assert.deepEqual(
    result.viewModel.events[0].performers,
    [
      {
        performerName: "本人1",
        attendanceLabel: "出席",
        attendanceWriteAllowed: true,
        attendanceWriteLabel: "回答可能",
      },
      {
        performerName: "本人2",
        attendanceLabel: "未回答",
        attendanceWriteAllowed: true,
        attendanceWriteLabel: "回答可能",
      },
    ],
  );
  assert.deepEqual(
    result.viewModel.events[1].performers,
    [
      {
        performerName: "本人1",
        attendanceLabel: "欠席",
        attendanceWriteAllowed: true,
        attendanceWriteLabel: "回答可能",
      },
      {
        performerName: "本人2",
        attendanceLabel: "出席",
        attendanceWriteAllowed: false,
        attendanceWriteLabel: "この予定の対象外",
      },
    ],
  );
  assert.equal(JSON.stringify(result.viewModel).includes("lineId"), false);
  assert.equal(JSON.stringify(result.viewModel).includes("memberId"), false);
});

test("予定0件は正常な読み取り専用空状態として扱う", async () => {
  const home = registeredHome();
  home.events = [];
  let requestCount = 0;
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse(home)
        : jsonResponse({ status: "ok", ok: true, registered: true, map: {} });
    }),
  });
  assert.equal(result.status, auth.AUTH_STATES.REGISTERED_READ_ONLY);
  assert.equal(result.summary.eventCount, 0);
  assert.deepEqual(result.viewModel.events, []);
});

test("重複・不正予定と未知の出欠statusをresponse_errorにする", async (t) => {
  const homeCases = [
    function duplicateEvent() {
      const home = registeredHome();
      home.events.push({ ...home.events[0] });
      return home;
    },
    function invalidDate() {
      const home = registeredHome();
      home.events[0].date = "20260230";
      return home;
    },
    function invalidTime() {
      const home = registeredHome();
      home.events[0].time = "25:00";
      return home;
    },
    function invalidSegment() {
      const home = registeredHome();
      home.events[0].targetGroup = "unknown";
      return home;
    },
  ];
  for (const makeHome of homeCases) {
    await t.test(makeHome.name, async () => {
      let fetchCount = 0;
      const result = await auth.startStagingAuthenticatedReadOnly({
        liff: makeLiff(),
        liffId: "test-liff-id",
        dependencies: fetchDependencies(async () => {
          fetchCount += 1;
          return jsonResponse(makeHome());
        }),
      });
      assert.equal(result.status, auth.AUTH_STATES.RESPONSE_ERROR);
      assert.equal(fetchCount, 1);
    });
  }

  for (const row of [
    { performerName: "本人1", attend: "不明" },
    { performerName: "他人", attend: "参加" },
  ]) {
    await t.test(`attendance:${row.attend}:${row.performerName}`, async () => {
      let fetchCount = 0;
      const result = await auth.startStagingAuthenticatedReadOnly({
        liff: makeLiff(),
        liffId: "test-liff-id",
        dependencies: fetchDependencies(async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? jsonResponse(registeredHome())
            : jsonResponse({
                status: "ok",
                ok: true,
                registered: true,
                map: { "event-1": [row] },
              });
        }),
      });
      assert.equal(result.status, auth.AUTH_STATES.RESPONSE_ERROR);
    });
  }
});

test("attendanceWriteを本人演奏者集合と整合性まで厳密に検証する", async (t) => {
  const cases = [
    ["欠落", (home) => { delete home.events[0].attendanceWrite; }],
    ["eventAllowed型不正", (home) => { home.events[0].attendanceWrite.eventAllowed = "true"; }],
    ["未知eventReason", (home) => { home.events[0].attendanceWrite.eventReason = "unknown"; }],
    ["performers非配列", (home) => { home.events[0].attendanceWrite.performers = {}; }],
    ["performer allowed型不正", (home) => {
      home.events[0].attendanceWrite.performers[0].allowed = 1;
    }],
    ["未知performer reason", (home) => {
      home.events[0].attendanceWrite.performers[0].reason = "unknown";
    }],
    ["performer重複", (home) => {
      home.events[0].attendanceWrite.performers[1].performerName = "本人1";
    }],
    ["本人以外", (home) => {
      home.events[0].attendanceWrite.performers[1].performerName = "他人";
    }],
    ["本人欠落", (home) => { home.events[0].attendanceWrite.performers.pop(); }],
    ["event可否矛盾", (home) => {
      home.events[0].attendanceWrite.eventAllowed = false;
    }],
    ["performer可否矛盾", (home) => {
      home.events[0].attendanceWrite.performers[0].allowed = false;
    }],
    ["event不可時のperformer理由不一致", (home) => {
      home.events[0].attendanceWrite.eventAllowed = false;
      home.events[0].attendanceWrite.eventReason = "deadline_passed";
      home.events[0].attendanceWrite.performers.forEach((performer) => {
        performer.allowed = false;
        performer.reason = "not_published";
      });
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const home = registeredHome();
      mutate(home);
      let fetchCount = 0;
      const result = await auth.startStagingAuthenticatedReadOnly({
        liff: makeLiff(),
        liffId: "test-liff-id",
        dependencies: fetchDependencies(async () => {
          fetchCount += 1;
          return jsonResponse(home);
        }),
      });
      assert.equal(result.status, auth.AUTH_STATES.RESPONSE_ERROR);
      assert.equal(fetchCount, 1);
    });
  }
});

test("予定・演奏者の回答可否ラベルを表示し、受付件数を区別する", async () => {
  const home = registeredHome();
  home.events[0].attendanceWrite = {
    eventAllowed: false,
    eventReason: "deadline_passed",
    performers: [
      { performerName: "本人1", allowed: false, reason: "deadline_passed" },
      { performerName: "本人2", allowed: false, reason: "deadline_passed" },
    ],
  };
  home.events[1].attendanceWrite.performers = [
    { performerName: "本人1", allowed: false, reason: "viewer_only" },
    { performerName: "本人2", allowed: false, reason: "target_group_mismatch" },
  ];
  let fetchCount = 0;
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? jsonResponse(home)
        : jsonResponse(registeredAttendance());
    }),
  });

  assert.equal(result.status, auth.AUTH_STATES.REGISTERED_READ_ONLY);
  assert.equal(result.summary.eventAllowedCount, 1);
  assert.equal(result.summary.performerAllowedEventCount, 0);
  assert.equal(result.viewModel.events.length, 2);
  const container = new FakeElement("div");
  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument());
  assert.match(container.textContent, /回答期限終了/);
  assert.match(container.textContent, /閲覧のみ/);
  assert.match(container.textContent, /この予定の対象外/);
  assert.match(container.textContent, /出席/);
  assert.match(container.textContent, /欠席/);

  const copy = auth.getReadOnlyUiCopy(auth.AUTH_STATES.REGISTERED_READ_ONLY, result.summary);
  assert.match(copy.message, /回答受付中の予定: 1件/);
  assert.match(copy.message, /あなたが回答可能な予定: 0件/);
});

test("すべての回答可否理由を安全な日本語へ変換する", async (t) => {
  const eventLabels = new Map([
    ["open", "回答受付中"],
    ["inactive", "受付対象外"],
    ["attendance_not_required", "回答不要"],
    ["not_published", "回答受付外"],
    ["deadline_passed", "回答期限終了"],
    ["invalid_event_configuration", "受付状態を確認できません"],
  ]);
  for (const [reason, label] of eventLabels) {
    await t.test(`event:${reason}`, async () => {
      const home = registeredHome();
      const allowed = reason === "open";
      home.events[0].attendanceWrite = {
        eventAllowed: allowed,
        eventReason: reason,
        performers: home.member.performers.map((member) => ({
          performerName: member.performerName,
          allowed,
          reason,
        })),
      };
      let fetchCount = 0;
      const result = await auth.startStagingAuthenticatedReadOnly({
        liff: makeLiff(),
        liffId: "test-liff-id",
        dependencies: fetchDependencies(async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? jsonResponse(home)
            : jsonResponse({ status: "ok", ok: true, registered: true, map: {} });
        }),
      });
      const container = new FakeElement("div");
      auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument());
      assert.match(container.textContent, new RegExp(label));
    });
  }

  const performerLabels = new Map([
    ["viewer_only", "閲覧のみ"],
    ["segment_missing", "メンバー区分未設定"],
    ["target_group_mismatch", "この予定の対象外"],
  ]);
  for (const [reason, label] of performerLabels) {
    await t.test(`performer:${reason}`, async () => {
      const home = registeredHome();
      home.events[0].attendanceWrite.performers[0] = {
        performerName: "本人1",
        allowed: false,
        reason,
      };
      let fetchCount = 0;
      const result = await auth.startStagingAuthenticatedReadOnly({
        liff: makeLiff(),
        liffId: "test-liff-id",
        dependencies: fetchDependencies(async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? jsonResponse(home)
            : jsonResponse({ status: "ok", ok: true, registered: true, map: {} });
        }),
      });
      const container = new FakeElement("div");
      auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument());
      assert.match(container.textContent, new RegExp(label));
    });
  }
});

test("予定カードはtextContentだけで安全に描画し、操作要素を生成しない", () => {
  const documentImpl = fakeDocument();
  const container = new FakeElement("div");
  const htmlLikeTitle = '<img src=x onerror="throw new Error(1)">';
  const htmlLikePlace = "<script>throw new Error(2)</script>";
  const htmlLikeName = "<b>本人</b>";
  const count = auth.renderReadOnlySchedules_(container, {
    events: [{
      title: htmlLikeTitle,
      dateLabel: "2026年7月26日（日）",
      timeLabel: "17:15",
      place: htmlLikePlace,
      targetGroupLabel: "両方",
      deadlineLabel: "2026年7月25日（土）",
      status: "active",
      note: "",
      eventAllowed: false,
      eventWriteLabel: '<b onclick="throw new Error(3)">回答不可</b>',
      performers: [{
        performerName: htmlLikeName,
        attendanceLabel: "未回答",
        attendanceWriteAllowed: false,
        attendanceWriteLabel: '<img src=x onerror="throw new Error(4)">',
      }],
    }],
  }, documentImpl);

  assert.equal(count, 1);
  assert.match(container.textContent, /<img src=x/);
  assert.match(container.textContent, /<script>/);
  assert.match(container.textContent, /<b>本人<\/b>/);
  assert.match(container.textContent, /回答不可<\/b>/);
  assert.match(container.textContent, /<img src=x onerror/);
  const tags = collectTags(container);
  for (const forbidden of ["IMG", "SCRIPT", "B", "INPUT", "SELECT", "TEXTAREA", "BUTTON", "FORM"]) {
    assert.equal(tags.includes(forbidden), false, forbidden);
  }
  assert.equal(container.attributes.role, "list");
});

test("予定0件のDOMは正常な空状態だけを表示する", () => {
  const container = new FakeElement("div");
  const count = auth.renderReadOnlySchedules_(container, { events: [] }, fakeDocument());
  assert.equal(count, 0);
  assert.equal(container.textContent, "現在、回答対象の予定はありません。");
});

test("未登録は正常状態で、attendance/allを呼ばない", async () => {
  let fetchCount = 0;
  const states = [];
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    onState(snapshot) { states.push(snapshot.status); },
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return jsonResponse({ ok: true, registered: false, members: [] });
    }),
  });
  assert.equal(result.status, auth.AUTH_STATES.UNREGISTERED);
  assert.equal(fetchCount, 1);
  assert.deepEqual(states, [auth.AUTH_STATES.LOADING, auth.AUTH_STATES.UNREGISTERED]);
});

test("HTTP・通信・応答異常を未登録と区別する", async (t) => {
  const cases = [
    ["401", () => jsonResponse({ ok: false, error: "invalid_line_token" }, 401), auth.AUTH_STATES.UNAUTHENTICATED],
    ["D1 503", () => jsonResponse({ ok: false, error: "database_unavailable" }, 503), auth.AUTH_STATES.DATABASE_ERROR],
    ["認証系503", () => jsonResponse({ ok: false, error: "authentication_not_configured" }, 503), auth.AUTH_STATES.TEMPORARY_ERROR],
    ["不正Content-Type", () => jsonResponse({}, 200, "text/html"), auth.AUTH_STATES.RESPONSE_ERROR],
    ["不正JSON", () => jsonResponse(new SyntaxError("bad json")), auth.AUTH_STATES.RESPONSE_ERROR],
    ["不正home構造", () => jsonResponse({ ok: true, registered: true, events: [] }), auth.AUTH_STATES.RESPONSE_ERROR],
    ["登録済みなのにmemberが空", () => jsonResponse({ ok: true, registered: true, members: [], events: [] }), auth.AUTH_STATES.RESPONSE_ERROR],
  ];
  for (const [name, responseFactory, expected] of cases) {
    await t.test(name, async () => {
      const result = await auth.startStagingAuthenticatedReadOnly({
        liff: makeLiff(),
        liffId: "test-liff-id",
        dependencies: fetchDependencies(async () => responseFactory()),
      });
      assert.equal(result.status, expected);
      assert.notEqual(result.status, auth.AUTH_STATES.UNREGISTERED);
    });
  }

  await t.test("通信例外", async () => {
    const result = await auth.startStagingAuthenticatedReadOnly({
      liff: makeLiff(),
      liffId: "test-liff-id",
      dependencies: fetchDependencies(async () => { throw new TypeError("offline"); }),
    });
    assert.equal(result.status, auth.AUTH_STATES.NETWORK_ERROR);
  });

  await t.test("timeout", async () => {
    const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const result = await auth.startStagingAuthenticatedReadOnly({
      liff: makeLiff(),
      liffId: "test-liff-id",
      dependencies: fetchDependencies(fetchImpl, { timeoutMs: 5 }),
    });
    assert.equal(result.status, auth.AUTH_STATES.NETWORK_ERROR);
  });
});

test("attendanceのHTTP・構造異常を成功扱いしない", async (t) => {
  for (const [name, attendanceResponse, expected] of [
    ["HTTP 503", jsonResponse({ ok: false, error: "database_unavailable" }, 503), auth.AUTH_STATES.DATABASE_ERROR],
    ["mapなし", jsonResponse({ ok: true, registered: true }), auth.AUTH_STATES.RESPONSE_ERROR],
    ["map値が配列でない", jsonResponse({ ok: true, registered: true, map: { event: {} } }), auth.AUTH_STATES.RESPONSE_ERROR],
  ]) {
    await t.test(name, async () => {
      let count = 0;
      const result = await auth.startStagingAuthenticatedReadOnly({
        liff: makeLiff(),
        liffId: "test-liff-id",
        dependencies: fetchDependencies(async () => {
          count += 1;
          return count === 1 ? jsonResponse(registeredHome()) : attendanceResponse;
        }),
      });
      assert.equal(result.status, expected);
    });
  }

  await t.test("registered=falseを未登録として区別", async () => {
    let count = 0;
    const result = await auth.startStagingAuthenticatedReadOnly({
      liff: makeLiff(),
      liffId: "test-liff-id",
      dependencies: fetchDependencies(async () => {
        count += 1;
        return count === 1
          ? jsonResponse(registeredHome())
          : jsonResponse({ status: "ok", ok: true, registered: false, map: {} });
      }),
    });
    assert.equal(result.status, auth.AUTH_STATES.UNREGISTERED);
  });
});

test("/auth/sessionは診断用として安全な共通fetchを再利用する", async () => {
  let captured;
  const result = await auth.verifyLineSession_(TOKEN, fetchDependencies(async (url, options) => {
    captured = { url, options };
    return jsonResponse({ ok: true, authenticated: true });
  }));
  assert.deepEqual(result, { ok: true, authenticated: true });
  assert.equal(captured.url, `${auth.STAGING_WORKER_BASE_URL}/auth/session`);
  assert.equal(captured.options.headers.Authorization, `Bearer ${TOKEN}`);
});

test("UIは全状態を区別し、非機密な件数だけを表示する", () => {
  const copies = {
    loading: auth.getReadOnlyUiCopy(auth.AUTH_STATES.LOADING),
    unregistered: auth.getReadOnlyUiCopy(auth.AUTH_STATES.UNREGISTERED),
    registered: auth.getReadOnlyUiCopy(auth.AUTH_STATES.REGISTERED_READ_ONLY, {
      memberCount: 2,
      eventCount: 3,
      attendanceCount: 4,
      eventAllowedCount: 2,
      performerAllowedEventCount: 1,
    }),
    unauthenticated: auth.getReadOnlyUiCopy(auth.AUTH_STATES.UNAUTHENTICATED),
    database: auth.getReadOnlyUiCopy(auth.AUTH_STATES.DATABASE_ERROR),
    temporary: auth.getReadOnlyUiCopy(auth.AUTH_STATES.TEMPORARY_ERROR),
    network: auth.getReadOnlyUiCopy(auth.AUTH_STATES.NETWORK_ERROR),
    response: auth.getReadOnlyUiCopy(auth.AUTH_STATES.RESPONSE_ERROR),
  };

  assert.match(copies.loading.title, /安全に確認/);
  assert.match(copies.unregistered.message, /まだあなたのメンバー情報が登録されていません/);
  assert.match(copies.registered.title, /読み取り専用/);
  assert.match(copies.registered.message, /表示確認のみ/);
  assert.match(copies.registered.message, /メンバー件数: 2/);
  assert.match(copies.registered.message, /回答受付中の予定: 2件/);
  assert.match(copies.registered.message, /あなたが回答可能な予定: 1件/);
  assert.match(copies.unauthenticated.title, /本人認証に失敗/);
  assert.match(copies.database.title, /データベース/);
  assert.match(copies.temporary.title, /一時的/);
  assert.match(copies.network.title, /サーバーへ接続できません/);
  assert.match(copies.response.title, /予期しない応答/);

  const serialized = JSON.stringify(copies);
  assert.doesNotMatch(serialized, new RegExp(TOKEN.replaceAll(".", "\\.")));
  assert.doesNotMatch(serialized, /lineUserId|\bsub\b|channel.?id/i);
  assert.doesNotMatch(serialized, /本人1|本人2/);
});
