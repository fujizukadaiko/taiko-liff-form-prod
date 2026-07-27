"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const auth = require("../auth-session.js");

const TOKEN = "header.payload.signature";
const TEST_WORKER_BASE_URL = "https://staging-worker.example.test";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

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
    workerBaseUrl: TEST_WORKER_BASE_URL,
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
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.type = "";
    this.id = "";
    this.name = "";
    this.value = "";
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

  addEventListener(type, listener) {
    const name = String(type);
    if (!this.listeners[name]) this.listeners[name] = [];
    this.listeners[name].push(listener);
  }

  dispatch(type) {
    for (const listener of this.listeners[String(type)] || []) {
      listener({ type: String(type), target: this });
    }
  }

  async dispatchAsync(type) {
    await Promise.all((this.listeners[String(type)] || []).map(
      (listener) => listener({ type: String(type), target: this }),
    ));
  }
}

function fakeDocument() {
  return { createElement(tagName) { return new FakeElement(tagName); } };
}

function collectTags(root) {
  return [root.tagName, ...root.childNodes.flatMap(collectTags)];
}

function collectElements(root) {
  return [root, ...root.childNodes.flatMap(collectElements)];
}

function registeredHome() {
  return {
    ok: true,
    registered: true,
    admin: { authorized: false },
    member: {
      inputName: "入力者",
      notify: true,
      viewerOnly: false,
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
    comments: {
      "event-1": {
        comment: "連絡事項",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
    },
  };
}

function adminSchedulesResponse(overrides = {}) {
  return {
    ok: true,
    status: "ok",
    schedules: [{
      eventKey: "admin-event-1",
      date: "20260730",
      title: "管理予定",
      kind: "練習",
      targetGroup: "both",
      time: "18:00",
      place: "テスト会場",
      callTime: "17:30",
      callPlace: "入口",
      needAttendance: "Y",
      pushFlag: "N",
      deadlineDate: "20260729",
      firstPushAt: "",
      lastRemindAt: "",
      publishFlag: "Y",
      status: "active",
      subject: "通知件名",
      bodyTemplate: "通知本文",
      note: "備考",
      updatedAt: "2026/07/24 12:00:00",
    }],
    hasMore: false,
    ...overrides,
  };
}

function adminAttendanceReportEvent(overrides = {}) {
  return {
    eventKey: "admin-event-1",
    date: "20260730",
    title: "管理予定",
    time: "18:00",
    place: "テスト会場",
    targetGroup: "両方",
    deadlineDate: "20260729",
    accepting: true,
    ...overrides,
  };
}

function adminAttendanceReportEventsResponse(overrides = {}) {
  return {
    ok: true,
    status: "ok",
    mode: "events",
    events: [adminAttendanceReportEvent()],
    hasMore: false,
    ...overrides,
  };
}

function adminAttendanceReportResponse(overrides = {}) {
  return {
    ok: true,
    status: "ok",
    mode: "report",
    event: adminAttendanceReportEvent(),
    rows: [
      {
        displayName: "演奏者1",
        segment: "子ども",
        attend: "参加",
        comment: "テストコメント",
        answeredAt: "2026-07-27T00:00:00.000Z",
      },
      {
        displayName: "演奏者2【大人の部】",
        segment: "大人",
        attend: "未回答",
        comment: "",
        answeredAt: "",
      },
    ],
    counts: {
      participating: 1,
      absent: 0,
      undecided: 0,
      unanswered: 1,
      total: 2,
    },
    ...overrides,
  };
}

function adminCarpoolResponse(overrides = {}) {
  return {
    ok: true,
    status: "ok",
    event: adminAttendanceReportEvent(),
    participantCount: 3,
    candidateCount: 2,
    candidates: [
      {
        displayName: "登録者1",
        participantNames: ["演奏者1", "演奏者2【大人の部】"],
        comment: "車出し可能です",
      },
      {
        displayName: "登録者2",
        participantNames: ["演奏者3"],
        comment: "",
      },
    ],
    ...overrides,
  };
}

function writableAdminSchedule(overrides = {}) {
  return {
    eventKey: "20990102AA",
    date: "20990102",
    title: "管理予定",
    kind: "発表",
    targetGroup: "両方",
    time: "10:00",
    place: "テスト会場",
    callTime: "09:00",
    callPlace: "入口",
    needAttendance: "Y",
    pushFlag: "N",
    deadlineDate: "20981231",
    firstPushAt: "",
    lastRemindAt: "",
    publishFlag: "Yes",
    status: "active",
    subject: "",
    bodyTemplate: "",
    note: "備考",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function adminScheduleInput(overrides = {}) {
  return {
    mode: "create",
    schedule: {
      kind: "発表",
      title: "管理予定",
      date: "20990102",
      targetGroup: "両方",
      time: "10:00",
      place: "テスト会場",
      callTime: "09:00",
      callPlace: "入口",
      needAttendance: "Y",
      pushFlag: "N",
      deadlineDate: "20981231",
      publishFlag: "Yes",
      status: "active",
      note: "備考",
    },
    ...overrides,
  };
}

function attendanceSubmitPayload(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    eventKey: "event-1",
    mode: "merge",
    items: [{ performerName: "本人1", attend: "欠席" }],
    commentTouched: false,
    ...overrides,
  };
}

function attendanceSubmitResponse(payload, overrides = {}) {
  return {
    ok: true,
    status: "ok",
    requestId: payload.requestId,
    updatedCount: payload.items.length,
    commentUpdated: payload.commentTouched,
    ...overrides,
  };
}

async function registeredReadOnlyResult(home = registeredHome(), attendance = registeredAttendance()) {
  let requestCount = 0;
  return auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      requestCount += 1;
      return requestCount === 1 ? jsonResponse(home) : jsonResponse(attendance);
    }),
  });
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
  assert.equal(home.url, `${TEST_WORKER_BASE_URL}/line/home-summary`);
  assert.equal(home.options.method, "GET");
  assert.equal(home.options.body, undefined);
  assert.equal(new URL(home.url).search, "");

  const attendance = requests[1];
  assert.equal(attendance.url, `${TEST_WORKER_BASE_URL}/line/attendance/all`);
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

test("Worker接続先の注入がない場合と別Originへの送信をfail closedにする", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse({ ok: true });
  };

  await assert.rejects(
    auth.authenticatedFetch_("/auth/session", {}, TOKEN, {
      fetchImpl,
    }),
    (error) => error.code === "invalid_worker_base_url",
  );
  await assert.rejects(
    auth.authenticatedFetch_("https://other.example.test/auth/session", {}, TOKEN, {
      ...fetchDependencies(fetchImpl),
    }),
    (error) => error.code === "invalid_worker_target",
  );
  assert.equal(fetchCount, 0);
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
        : jsonResponse({ status: "ok", ok: true, registered: true, map: {}, comments: {} });
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
  assert.equal(auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
  }), 5);
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
        initialAttend: "参加",
        attendanceWriteAllowed: true,
        attendanceWriteReason: "open",
        attendanceWriteLabel: "回答可能",
      },
      {
        performerName: "本人2",
        attendanceLabel: "未回答",
        initialAttend: "未回答",
        attendanceWriteAllowed: true,
        attendanceWriteReason: "open",
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
        initialAttend: "欠席",
        attendanceWriteAllowed: true,
        attendanceWriteReason: "open",
        attendanceWriteLabel: "回答可能",
      },
      {
        performerName: "本人2",
        attendanceLabel: "出席",
        initialAttend: "参加",
        attendanceWriteAllowed: false,
        attendanceWriteReason: "target_group_mismatch",
        attendanceWriteLabel: "この予定の対象外",
      },
    ],
  );
  assert.equal(JSON.stringify(result.viewModel).includes("lineId"), false);
  assert.equal(JSON.stringify(result.viewModel).includes("memberId"), false);
});

test("認証済みデータをproductionホーム表示モデルへ変換し全予定を保持する", async () => {
  const result = await registeredReadOnlyResult();
  const productionHome = auth.buildProductionHomeViewModel_(result.viewModel);

  assert.equal(productionHome.eventCount, 2);
  assert.equal(productionHome.memberCount, 2);
  assert.deepEqual(
    productionHome.events.map((event) => event.eventKey),
    ["event-1", "event-2"],
  );
  assert.deepEqual(
    productionHome.events[0].performers,
    [
      {
        performerName: "本人1",
        attendanceLabel: "出席",
        attendanceClass: "stat-ok",
        attendanceWriteAllowed: true,
        attendanceWriteLabel: "回答可能",
      },
      {
        performerName: "本人2",
        attendanceLabel: "未回答",
        attendanceClass: "stat-na",
        attendanceWriteAllowed: true,
        attendanceWriteLabel: "回答可能",
      },
    ],
  );
  assert.equal(productionHome.events[1].attendanceWriteAllowed, true);
  assert.equal(productionHome.events[1].attendanceWriteLabel, "回答受付中");
  assert.equal(
    productionHome.events[1].performers[1].attendanceWriteLabel,
    "この予定の対象外",
  );
});

test("productionホーム表示モデルはWorker由来の回答可否改ざんを拒否する", async (t) => {
  const result = await registeredReadOnlyResult();
  const cases = [
    ["event可否", (model) => { model.events[0].eventAllowed = false; }],
    ["event理由", (model) => { model.events[0].eventWriteReason = "deadline_passed"; }],
    ["event文言", (model) => { model.events[0].eventWriteLabel = "回答可能"; }],
    ["演奏者可否", (model) => {
      model.events[0].performers[0].attendanceWriteAllowed = false;
    }],
    ["演奏者文言", (model) => {
      model.events[0].performers[0].attendanceWriteLabel = "この予定の対象外";
    }],
    ["出欠文言", (model) => {
      model.events[0].performers[0].attendanceLabel = "未回答";
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const model = structuredClone(result.viewModel);
      mutate(model);
      assert.throws(
        () => auth.buildProductionHomeViewModel_(model),
        (error) => error.type === auth.AUTH_STATES.RESPONSE_ERROR,
      );
    });
  }
});

test("event key上限をWorkerと同じ128文字に統一する", async () => {
  const valid = await registeredReadOnlyResult();
  const validModel = structuredClone(valid.viewModel);
  validModel.events[0].eventKey = "a".repeat(128);
  assert.doesNotThrow(() => auth.buildProductionHomeViewModel_(validModel));

  const invalidModel = structuredClone(valid.viewModel);
  invalidModel.events[0].eventKey = "a".repeat(129);
  assert.throws(
    () => auth.buildProductionHomeViewModel_(invalidModel),
    (error) => error.type === auth.AUTH_STATES.RESPONSE_ERROR,
  );

  const invalidHome = registeredHome();
  invalidHome.events[0].eventKey = "a".repeat(129);
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => jsonResponse(invalidHome)),
  });
  assert.equal(result.status, auth.AUTH_STATES.RESPONSE_ERROR);
});

test("productionホームは既存CSS部品へ安全なDOMだけで描画する", async () => {
  const result = await registeredReadOnlyResult();
  const productionHome = auth.buildProductionHomeViewModel_(result.viewModel);
  const container = new FakeElement("div");

  assert.equal(
    auth.renderProductionHome_(container, productionHome, fakeDocument()),
    2,
  );
  const elements = collectElements(container);
  const tags = collectTags(container);
  assert.equal(tags.filter((tag) => tag === "ARTICLE").length, 2);
  assert.equal(tags.filter((tag) => tag === "H3").length, 2);
  assert.equal(tags.includes("BUTTON"), false);
  assert.equal(tags.includes("INPUT"), false);
  assert.equal(tags.includes("SELECT"), false);
  assert.match(container.textContent, /予定1/);
  assert.match(container.textContent, /本人1出席回答可能/);
  assert.match(container.textContent, /本人2未回答回答可能/);
  assert.match(container.textContent, /回答受付中/);

  const attributes = JSON.stringify(elements.map((element) => element.attributes));
  assert.doesNotMatch(attributes, /event-1|event-2|本人1|本人2/);
});

test("productionホームは予定0件を正常な空表示として扱う", () => {
  const container = new FakeElement("div");
  const model = auth.buildProductionHomeViewModel_({
    events: [],
    memberCount: 1,
  });
  assert.equal(auth.renderProductionHome_(container, model, fakeDocument()), 0);
  assert.match(container.textContent, /現在表示できる予定はありません/);
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
        : jsonResponse({ status: "ok", ok: true, registered: true, map: {}, comments: {} });
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
                comments: {},
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
            : jsonResponse({ status: "ok", ok: true, registered: true, map: {}, comments: {} });
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
            : jsonResponse({ status: "ok", ok: true, registered: true, map: {}, comments: {} });
        }),
      });
      const container = new FakeElement("div");
      auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument());
      assert.match(container.textContent, new RegExp(label));
    });
  }
});

test("回答可能な本人演奏者だけにproduction形式のselect draft UIを生成する", async () => {
  const result = await registeredReadOnlyResult();
  const container = new FakeElement("div");
  const summaries = [];
  assert.equal(auth.renderReadOnlySchedules_(
    container,
    result.viewModel,
    fakeDocument(),
    {
      enableDraftPreview: true,
      onDraftSummary(summary) { summaries.push(summary); },
    },
  ), 2);

  const elements = collectElements(container);
  const selects = elements.filter((element) => element.tagName === "SELECT");
  const options = elements.filter((element) => element.tagName === "OPTION");
  const labels = elements.filter((element) => element.tagName === "LABEL");
  const commentInputs = elements.filter(
    (element) => element.className === "evComment productionAttendanceCommentInput",
  );
  const accordionButtons = elements.filter(
    (element) => element.className === "fHead productionAttendanceAccordionButton",
  );

  // event-1は2人、event-2は対象区分が合う1人だけが各1つのselectを持つ。
  assert.equal(selects.length, 3);
  assert.equal(options.length, 12);
  assert.equal(labels.length, 5);
  assert.equal(commentInputs.length, 2);
  assert.ok(commentInputs.every(
    (input) => input.type === "text" && input.maxLength === 100,
  ));
  assert.equal(accordionButtons.length, 2);
  assert.ok(accordionButtons.every((button) => button.type === "button"));
  assert.deepEqual(summaries[0], { changedEventCount: 0, changedPerformerCount: 0 });

  // 参加と欠席は初期選択、未回答の本人2は未選択。
  assert.deepEqual(selects.map((select) => select.value), ["参加", "", "欠席"]);
  assert.deepEqual(
    new Set(options.map((option) => option.value)),
    new Set(["", "参加", "欠席", "未定"]),
  );

  for (const select of selects) {
    assert.doesNotMatch(select.id, /event-[12]|本人[12]/);
  }
  for (const label of labels) {
    assert.ok(
      [...selects, ...commentInputs].some(
        (control) => control.id === label.attributes.for,
      ),
    );
  }
  for (const element of elements) {
    assert.equal(Object.keys(element.attributes).some((name) => name.startsWith("data-")), false);
  }
  assert.match(container.textContent, /この予定の対象外/);
  assert.match(container.textContent, /出席/);
  assert.match(container.textContent, /欠席/);
});

test("回答不可理由ごとに入力DOMを生成せず現在の出欠を維持する", async () => {
  const reasons = ["viewer_only", "segment_missing", "target_group_mismatch"];
  for (const reason of reasons) {
    const result = await registeredReadOnlyResult();
    const model = JSON.parse(JSON.stringify(result.viewModel));
    model.events[0].performers[0].attendanceWriteAllowed = false;
    model.events[0].performers[0].attendanceWriteReason = reason;
    model.events[0].performers[0].attendanceWriteLabel = reason;
    const container = new FakeElement("div");
    auth.renderReadOnlySchedules_(container, model, fakeDocument(), {
      enableDraftPreview: true,
    });
    const elements = collectElements(container);
    // 元の3回答可能演奏者から1人を除外するため、selectは2つ。
    assert.equal(elements.filter((element) => element.tagName === "SELECT").length, 2, reason);
    assert.match(container.textContent, /出席/);
  }

  const result = await registeredReadOnlyResult();
  const model = JSON.parse(JSON.stringify(result.viewModel));
  model.events[0].eventAllowed = false;
  model.events[0].eventWriteReason = "deadline_passed";
  model.events[0].eventWriteLabel = "回答期限終了";
  model.events[0].performers.forEach((performer) => {
    performer.attendanceWriteAllowed = false;
    performer.attendanceWriteReason = "deadline_passed";
    performer.attendanceWriteLabel = "回答期限終了";
  });
  const container = new FakeElement("div");
  auth.renderReadOnlySchedules_(container, model, fakeDocument(), {
    enableDraftPreview: true,
  });
  assert.equal(
    collectElements(container).filter((element) => element.tagName === "SELECT").length,
    1,
  );
  assert.match(container.textContent, /回答期限終了/);
  assert.match(container.textContent, /出席/);
});

test("現在値を初期選択へ反映し未回答・データなしは未選択にする", async () => {
  const result = await registeredReadOnlyResult();
  const basePerformer = result.viewModel.events[0].performers[0];
  for (const [initialAttend, expected] of [
    ["参加", "参加"],
    ["欠席", "欠席"],
    ["未定", "未定"],
    ["未回答", ""],
    ["データなし", ""],
  ]) {
    const model = {
      events: [{
        ...result.viewModel.events[0],
        performers: [{
          ...basePerformer,
          initialAttend,
          attendanceLabel: initialAttend === "参加" ? "出席" : initialAttend,
        }],
      }],
    };
    const container = new FakeElement("div");
    auth.renderReadOnlySchedules_(container, model, fakeDocument(), {
      enableDraftPreview: true,
    });
    const selects = collectElements(container).filter(
      (element) => element.tagName === "SELECT",
    );
    assert.equal(selects.length, 1, initialAttend);
    assert.equal(selects[0].value, expected, initialAttend);
  }
});

test("draft変更・元回答への復帰・取り消しをメモリ内だけで管理する", async () => {
  const result = await registeredReadOnlyResult();
  const state = auth.createAttendanceDraftState_(result.viewModel.events);
  assert.equal(state.size, 5);
  assert.deepEqual(auth.summarizeAttendanceDraft_(result.viewModel.events, state), {
    changedEventCount: 0,
    changedPerformerCount: 0,
  });

  let changed = auth.setAttendanceDraftSelection_(state, "0:0", "欠席");
  assert.equal(changed.initialAttend, "参加");
  assert.equal(changed.selectedAttend, "欠席");
  assert.equal(changed.changed, true);
  assert.deepEqual(auth.summarizeAttendanceDraft_(result.viewModel.events, state), {
    changedEventCount: 1,
    changedPerformerCount: 1,
  });

  changed = auth.setAttendanceDraftSelection_(state, "0:0", "参加");
  assert.equal(changed.changed, false);
  auth.setAttendanceDraftSelection_(state, "0:1", "未定");
  assert.equal(state.get("0:1").initialAttend, "未回答");
  assert.equal(state.get("0:1").changed, true);
  const restored = auth.resetAttendanceDraftSelection_(state, "0:1");
  assert.equal(restored.selectedAttend, "未回答");
  assert.equal(restored.changed, false);
});

test("select操作と予定単位の変更取り消しが集計と初期選択を更新する", async () => {
  const result = await registeredReadOnlyResult();
  const container = new FakeElement("div");
  const summaries = [];
  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
    onDraftSummary(summary) { summaries.push(summary); },
  });
  const elements = collectElements(container);
  const firstCard = elements.find((element) => element.tagName === "ARTICLE");
  const cardElements = collectElements(firstCard);
  const select = cardElements.find((element) => element.tagName === "SELECT");
  const reset = cardElements.find(
    (element) => element.className === "btn btn-ghost productionAttendanceReset",
  );

  select.value = "欠席";
  select.dispatch("change");
  assert.deepEqual(summaries.at(-1), { changedEventCount: 1, changedPerformerCount: 1 });
  assert.equal(reset.hidden, false);

  reset.dispatch("click");
  assert.deepEqual(summaries.at(-1), { changedEventCount: 0, changedPerformerCount: 0 });
  assert.equal(reset.hidden, true);
  assert.equal(select.value, "参加");
});

test("draft再描画でDOM・listenerを重複させずHTML風の本人名もtextContentで扱う", async () => {
  const result = await registeredReadOnlyResult();
  const model = JSON.parse(JSON.stringify(result.viewModel));
  const htmlLikeName = '<img src=x onerror="throw new Error(1)">';
  model.events.forEach((event) => {
    event.performers = event.performers.filter((_, index) => index === 0);
    event.performers[0].performerName = htmlLikeName;
  });
  const container = new FakeElement("div");
  const documentImpl = fakeDocument();
  const options = { enableDraftPreview: true };
  auth.renderReadOnlySchedules_(container, model, documentImpl, options);
  auth.renderReadOnlySchedules_(container, model, documentImpl, options);

  const elements = collectElements(container);
  assert.equal(elements.filter((element) => element.tagName === "ARTICLE").length, 2);
  assert.equal(elements.filter((element) => element.tagName === "SELECT").length, 2);
  assert.equal(elements.filter((element) => element.tagName === "IMG").length, 0);
  assert.match(container.textContent, /<img src=x/);
  for (const select of elements.filter((element) => element.tagName === "SELECT")) {
    assert.equal((select.listeners.change || []).length, 1);
    assert.doesNotMatch(select.id, /<img|onerror/);
  }
});

test("変更された本人演奏者だけをevent別merge payloadへ変換する", async () => {
  const result = await registeredReadOnlyResult();
  const state = auth.createAttendanceDraftState_(result.viewModel.events);
  auth.setAttendanceDraftSelection_(state, "0:0", "欠席");
  auth.setAttendanceDraftSelection_(state, "0:1", "参加");
  auth.setAttendanceDraftSelection_(state, "1:0", "未定");

  const payloads = auth.buildAuthenticatedAttendanceDraftPayloads_(result.viewModel.events, state);
  assert.equal(payloads.length, 2);
  assert.deepEqual(
    payloads.map(({ requestId, ...payload }) => payload),
    [
      {
        eventKey: "event-1",
        mode: "merge",
        items: [
          { performerName: "本人1", attend: "欠席" },
          { performerName: "本人2", attend: "参加" },
        ],
        commentTouched: false,
      },
      {
        eventKey: "event-2",
        mode: "merge",
        items: [{ performerName: "本人1", attend: "未定" }],
        commentTouched: false,
      },
    ],
  );
  assert.ok(payloads.every((payload) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(payload.requestId)
  ));
  assert.deepEqual(auth.summarizeAttendanceDraft_(result.viewModel.events, state), {
    changedEventCount: 2,
    changedPerformerCount: 3,
  });
  const serialized = JSON.stringify(payloads);
  assert.doesNotMatch(serialized, /lineId|line_id|lineUserId|userId|memberId|token/);
  assert.ok(payloads.every((payload) =>
    payload.commentTouched === false && !Object.hasOwn(payload, "comment")
  ));
  assert.deepEqual(
    new Set(payloads.flatMap((payload) => payload.items.map((item) => item.attend))),
    new Set(["参加", "欠席", "未定"]),
  );

  auth.resetAttendanceDraftSelection_(state, "0:1");
  const afterReset = auth.buildAuthenticatedAttendanceDraftPayloads_(result.viewModel.events, state);
  assert.deepEqual(afterReset[0].items, [{ performerName: "本人1", attend: "欠席" }]);
});

test("コメントdraftは予定単位で保持し、変更時だけ本文を送る", async () => {
  const result = await registeredReadOnlyResult();
  const state = auth.createAttendanceDraftState_(result.viewModel.events);
  const requestId = state.get("event:0").requestId;

  const changed = auth.setAttendanceCommentDraft_(state, 0, "  集合時刻を確認します  ");
  assert.equal(changed.initialComment, "連絡事項");
  assert.equal(changed.commentChanged, true);
  const [payload] = auth.buildAuthenticatedAttendanceDraftPayloads_(
    result.viewModel.events,
    state,
  );
  assert.deepEqual(payload, {
    requestId,
    eventKey: "event-1",
    mode: "merge",
    items: [],
    commentTouched: true,
    comment: "集合時刻を確認します",
  });
  assert.equal(
    auth.buildAuthenticatedAttendanceDraftPayloads_(result.viewModel.events, state)[0].requestId,
    requestId,
    "保存結果不明時に同じ操作を識別できるよう、成功確定前はrequestIdを維持する",
  );
  assert.deepEqual(auth.summarizeAttendanceDraft_(result.viewModel.events, state), {
    changedEventCount: 1,
    changedPerformerCount: 0,
  });

  const restored = auth.resetAttendanceCommentDraft_(state, 0);
  assert.equal(restored.selectedComment, "連絡事項");
  assert.equal(restored.commentChanged, false);
  assert.deepEqual(
    auth.buildAuthenticatedAttendanceDraftPayloads_(result.viewModel.events, state),
    [],
  );
  assert.throws(
    () => auth.setAttendanceCommentDraft_(state, 0, "あ".repeat(101)),
    /invalid_comment_draft/,
  );
});

test("コメントだけの保存も再取得したD1正本と一致してから成功にする", async () => {
  const payload = attendanceSubmitPayload({
    items: [],
    commentTouched: true,
    comment: "集合時刻を確認します",
  });
  let fetchCount = 0;
  const result = await auth.submitAuthenticatedAttendancePayload_(payload, {
    liff: makeLiff(),
    members: [{ performerName: "本人1" }],
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? jsonResponse(attendanceSubmitResponse(payload))
        : jsonResponse({
            ok: true,
            status: "ok",
            registered: true,
            map: {},
            comments: {
              "event-1": {
                comment: "集合時刻を確認します",
                updatedAt: "2026-07-24T00:00:00.000Z",
              },
            },
          });
    }),
  });

  assert.equal(fetchCount, 2);
  assert.deepEqual(result, {
    updatedCount: 0,
    commentUpdated: true,
    confirmedItems: [],
    confirmedComment: "集合時刻を確認します",
  });
});

test("draft payloadは不正値・不整合・1予定11件を安全に拒否する", async () => {
  const result = await registeredReadOnlyResult();
  const state = auth.createAttendanceDraftState_(result.viewModel.events);
  assert.throws(
    () => auth.setAttendanceDraftSelection_(state, "0:0", "未回答"),
    /invalid_draft_selection/,
  );
  state.get("0:0").changed = true;
  assert.throws(
    () => auth.buildAuthenticatedAttendanceDraftPayloads_(result.viewModel.events, state),
    /invalid_draft_state/,
  );

  const performers = Array.from({ length: 11 }, (_, index) => ({
    performerName: `演奏者${index}`,
    initialAttend: "未回答",
    attendanceLabel: "未回答",
    attendanceWriteAllowed: true,
    attendanceWriteReason: "open",
    attendanceWriteLabel: "回答可能",
  }));
  const events = [{
    eventKey: "validated-event",
    eventAllowed: true,
    eventWriteReason: "open",
    initialComment: "",
    performers,
  }];
  const oversized = auth.createAttendanceDraftState_(events);
  for (let index = 0; index < performers.length; index += 1) {
    auth.setAttendanceDraftSelection_(oversized, `0:${index}`, "参加");
  }
  assert.throws(
    () => auth.buildAuthenticatedAttendanceDraftPayloads_(events, oversized),
    /draft_items_limit_exceeded/,
  );

  const duplicateEvents = JSON.parse(JSON.stringify(result.viewModel.events));
  duplicateEvents[0].performers[1].performerName =
    duplicateEvents[0].performers[0].performerName;
  assert.throws(
    () => auth.createAttendanceDraftState_(duplicateEvents),
    /invalid_draft_source/,
  );
});

test("保存時に現在のLIFF IDトークンを取得し認証済みrouteだけへ送る", async () => {
  const requests = [];
  let tokenCalls = 0;
  const payload = attendanceSubmitPayload();
  const result = await auth.submitAuthenticatedAttendancePayload_(payload, {
    liff: makeLiff({
      getIDToken() {
        tokenCalls += 1;
        return "fresh.token.value";
      },
    }),
    members: [{ performerName: "本人1" }, { performerName: "本人2" }],
    dependencies: fetchDependencies(async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? jsonResponse(attendanceSubmitResponse(payload))
        : jsonResponse({
            ok: true,
            status: "ok",
            registered: true,
            map: { "event-1": [{ performerName: "本人1", attend: "欠席" }] },
            comments: {},
          });
    }),
  });

  assert.equal(tokenCalls, 1);
  assert.deepEqual(result, {
    updatedCount: 1,
    commentUpdated: false,
    confirmedItems: [{ performerName: "本人1", attend: "欠席" }],
    confirmedComment: null,
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    `${TEST_WORKER_BASE_URL}/line/attendance/submit-authenticated`,
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer fresh.token.value");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.equal(requests[0].options.mode, "cors");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(Object.hasOwn(requests[0].options.headers, "Origin"), false);
  assert.deepEqual(JSON.parse(requests[0].options.body), payload);
  assert.equal(requests[1].url, `${TEST_WORKER_BASE_URL}/line/attendance/all`);
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.body, "{}");
  assert.equal(requests[1].options.headers.Authorization, "Bearer fresh.token.value");
});

test("保存Token・payload・成功応答が不正なら安全側に停止する", async (t) => {
  const payload = attendanceSubmitPayload();
  await t.test("Tokenなし", async () => {
    let fetchCount = 0;
    await assert.rejects(
      auth.submitAuthenticatedAttendancePayload_(payload, {
        liff: makeLiff({ getIDToken() { return null; } }),
        members: [{ performerName: "本人1" }],
        dependencies: fetchDependencies(async () => {
          fetchCount += 1;
          return jsonResponse({});
        }),
      }),
      (error) => error.type === auth.AUTH_STATES.UNAUTHENTICATED,
    );
    assert.equal(fetchCount, 0);
  });

  await t.test("payload不正", async () => {
    let tokenCount = 0;
    let fetchCount = 0;
    await assert.rejects(
      auth.submitAuthenticatedAttendancePayload_({ ...payload, lineId: "forbidden" }, {
        liff: makeLiff({ getIDToken() { tokenCount += 1; return TOKEN; } }),
        dependencies: fetchDependencies(async () => { fetchCount += 1; }),
      }),
      /invalid_submit_payload/,
    );
    assert.equal(tokenCount, 0);
    assert.equal(fetchCount, 0);
  });

  for (const [name, response] of [
    ["ok不正", attendanceSubmitResponse(payload, { ok: false })],
    ["status不正", attendanceSubmitResponse(payload, { status: "success" })],
    ["requestId不一致", attendanceSubmitResponse(payload, { requestId: REQUEST_ID.replace(/0$/, "1") })],
    ["updatedCount型不正", attendanceSubmitResponse(payload, { updatedCount: "1" })],
    ["updatedCount不一致", attendanceSubmitResponse(payload, { updatedCount: 2 })],
    ["commentUpdated不一致", attendanceSubmitResponse(payload, { commentUpdated: true })],
  ]) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await assert.rejects(
        auth.submitAuthenticatedAttendancePayload_(payload, {
          liff: makeLiff(),
          members: [{ performerName: "本人1" }],
          dependencies: fetchDependencies(async () => {
            fetchCount += 1;
            return jsonResponse(response);
          }),
        }),
        /invalid_submit_response/,
      );
      assert.equal(fetchCount, 1, "不正成功応答後にattendanceを再取得しない");
    });
  }

  await t.test("HTTP 200以外の成功status", async () => {
    let fetchCount = 0;
    await assert.rejects(
      auth.submitAuthenticatedAttendancePayload_(payload, {
        liff: makeLiff(),
        members: [{ performerName: "本人1" }],
        dependencies: fetchDependencies(async () => {
          fetchCount += 1;
          return jsonResponse(attendanceSubmitResponse(payload), 201);
        }),
      }),
      /unexpected_success_status/,
    );
    assert.equal(fetchCount, 1);
  });
});

test("保存後のattendance再取得が一致しなければdraft確定材料にしない", async (t) => {
  const payload = attendanceSubmitPayload();
  for (const [name, attendanceResponse] of [
    ["値不一致", jsonResponse({
      ok: true,
      status: "ok",
      registered: true,
      map: { "event-1": [{ performerName: "本人1", attend: "参加" }] },
      comments: {},
    })],
    ["不正JSON", jsonResponse(new SyntaxError("invalid"))],
    ["不正構造", jsonResponse({ ok: true, status: "ok", registered: true })],
  ]) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await assert.rejects(
        auth.submitAuthenticatedAttendancePayload_(payload, {
          liff: makeLiff(),
          members: [{ performerName: "本人1" }],
          dependencies: fetchDependencies(async () => {
            fetchCount += 1;
            return fetchCount === 1
              ? jsonResponse(attendanceSubmitResponse(payload))
              : attendanceResponse;
          }),
        }),
      );
      assert.equal(fetchCount, 2);
    });
  }
});

test("保存エラーを安全な画面状態へ分類する", () => {
  const cases = [
    [new auth.AuthSessionError(auth.AUTH_STATES.UNAUTHENTICATED, "invalid_line_token", 401), "unauthenticated"],
    [new auth.AuthSessionError(auth.AUTH_STATES.TEMPORARY_ERROR, "authentication_not_configured", 503), "authentication_unavailable"],
    [new auth.AuthSessionError(auth.AUTH_STATES.TEMPORARY_ERROR, "authentication_upstream_error", 502), "authentication_unavailable"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "staging_attendance_write_disabled", 403), "write_disabled"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "performer_not_allowed", 403), "not_allowed"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "event_not_found", 404), "event_not_found"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "attendance_deadline_passed", 409), "event_not_available"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "idempotency_conflict", 409), "response_error"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "comment_requires_attendance", 409), "comment_needs_attendance"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "invalid_request", 400), "response_error"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "payload_too_large", 413), "response_error"],
    [new auth.AuthSessionError(auth.AUTH_STATES.RESPONSE_ERROR, "unsupported_media_type", 415), "response_error"],
    [new auth.AuthSessionError(auth.AUTH_STATES.TEMPORARY_ERROR, "attendance_write_failed", 503), "save_unavailable"],
    [new auth.AuthSessionError(auth.AUTH_STATES.NETWORK_ERROR, "timeout", 0), "network_uncertain"],
  ];
  for (const [error, expected] of cases) {
    const state = auth.classifyAttendanceSubmitError_(error);
    assert.equal(state, expected);
    const message = auth.getAttendanceSubmitMessage_(state);
    assert.ok(message.length > 0);
    assert.doesNotMatch(message, /invalid_line_token|event_not_found|attendance_write_failed/);
  }
});

test("会員payloadは通知とviewer-onlyを分離し氏名・区分・重複を送信前検証する", () => {
  const dependencies = {
    createRequestId() { return REQUEST_ID; },
  };
  assert.deepEqual(
    auth.buildAuthenticatedMemberPayload_({
      mode: "replace",
      inputName: "　入力者　 太郎 ",
      notify: false,
      performers: [{
        performerName: "　演奏者　A ",
        segment: "大人の部",
      }],
    }, dependencies),
    {
      requestId: REQUEST_ID,
      mode: "replace",
      inputName: "入力者 太郎",
      notify: false,
      performers: [{
        performerName: "演奏者 A",
        segment: "大人の部",
      }],
    },
  );
  const viewer = auth.buildAuthenticatedMemberPayload_({
    mode: "create",
    inputName: "入力者",
    notify: true,
    performers: [],
  }, dependencies);
  assert.equal(viewer.notify, true);
  assert.deepEqual(viewer.performers, []);

  for (const invalid of [
    {
      mode: "create",
      inputName: "",
      notify: true,
      performers: [],
    },
    {
      mode: "create",
      inputName: "入力者",
      notify: true,
      performers: [
        { performerName: "同名", segment: "大人の部" },
        { performerName: "同名", segment: "子どもの部" },
      ],
    },
    {
      mode: "create",
      inputName: "入力者",
      notify: true,
      performers: [{ performerName: "名前", segment: "unknown" }],
    },
    {
      mode: "create",
      inputName: "入力者",
      notify: true,
      performers: [],
      lineId: "forbidden",
    },
  ]) {
    assert.throws(
      () => auth.buildAuthenticatedMemberPayload_(invalid, dependencies),
      auth.AuthSessionError,
    );
  }
});

test("会員保存は現在のIDトークンで専用routeへ送りhome再取得一致後だけ成功する", async () => {
  const requests = [];
  const input = {
    mode: "replace",
    inputName: "入力者",
    notify: false,
    performers: [{ performerName: "演奏者A", segment: "大人の部" }],
  };
  const result = await auth.submitAuthenticatedMemberProfile_(input, {
    liff: makeLiff({ getIDToken() { return "fresh.member.token"; } }),
    dependencies: fetchDependencies(async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        return jsonResponse({
          ok: true,
          status: "ok",
          requestId: REQUEST_ID,
          mode: "replace",
          memberCount: 1,
          viewerOnly: false,
        });
      }
      return jsonResponse({
        ok: true,
        registered: true,
        admin: { authorized: false },
        member: {
          inputName: "入力者",
          notify: false,
          viewerOnly: false,
          performers: [{ performerName: "演奏者A", segment: "大人の部" }],
        },
        events: [],
      });
    }, {
      createRequestId() { return REQUEST_ID; },
    }),
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    `${TEST_WORKER_BASE_URL}/line/members/submit-authenticated`,
  );
  assert.equal(requests[1].url, `${TEST_WORKER_BASE_URL}/line/home-summary`);
  assert.equal(requests[0].options.headers.Authorization, "Bearer fresh.member.token");
  const sent = JSON.parse(requests[0].options.body);
  assert.deepEqual(sent, { requestId: REQUEST_ID, ...input });
  assert.equal(JSON.stringify(sent).includes("lineId"), false);
  assert.deepEqual(result.profile, {
    inputName: "入力者",
    notify: false,
    viewerOnly: false,
    performers: [{ performerName: "演奏者A", segment: "大人の部" }],
  });
});

test("会員保存は再取得不一致・通信結果不明を成功扱いせず自動retryしない", async () => {
  const input = {
    mode: "replace",
    inputName: "入力者",
    notify: true,
    performers: [],
  };
  let mismatchFetches = 0;
  await assert.rejects(
    auth.submitAuthenticatedMemberProfile_(input, {
      liff: makeLiff(),
      dependencies: fetchDependencies(async () => {
        mismatchFetches += 1;
        return mismatchFetches === 1
          ? jsonResponse({
              ok: true,
              status: "ok",
              requestId: REQUEST_ID,
              mode: "replace",
              memberCount: 0,
              viewerOnly: true,
            })
          : jsonResponse({
              ok: true,
              registered: true,
              admin: { authorized: false },
              member: {
                inputName: "別の入力者",
                notify: true,
                viewerOnly: true,
                performers: [],
              },
              events: [],
            });
      }, {
        createRequestId() { return REQUEST_ID; },
      }),
    }),
    /member_confirmation_failed/,
  );
  assert.equal(mismatchFetches, 2);

  let networkFetches = 0;
  let networkError;
  try {
    await auth.submitAuthenticatedMemberProfile_(input, {
      liff: makeLiff(),
      dependencies: fetchDependencies(async () => {
        networkFetches += 1;
        throw new TypeError("offline");
      }, {
        createRequestId() { return REQUEST_ID; },
      }),
    });
  } catch (error) {
    networkError = error;
  }
  assert.equal(networkFetches, 1);
  assert.equal(auth.classifyMemberSubmitError_(networkError), "result_unknown");
  assert.equal(
    auth.classifyMemberSubmitError_(
      new auth.AuthSessionError(
        auth.AUTH_STATES.RESPONSE_ERROR,
        "staging_member_write_disabled",
        403,
      ),
    ),
    "write_disabled",
  );
});

test("演奏者0件の登録済みviewer profileを未登録と誤判定しない", async () => {
  let fetchCount = 0;
  const result = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? jsonResponse({
            ok: true,
            registered: true,
            admin: { authorized: false },
            member: {
              inputName: "閲覧者",
              notify: false,
              viewerOnly: true,
              performers: [],
            },
            events: [],
          })
        : jsonResponse({
            ok: true,
            status: "ok",
            registered: true,
            map: {},
            comments: {},
          });
    }),
  });
  assert.equal(result.status, auth.AUTH_STATES.REGISTERED_READ_ONLY);
  assert.equal(result.memberProfile.viewerOnly, true);
  assert.equal(result.summary.memberCount, 0);
});

test("予定単位の保存ボタンは変更がある回答可能予定だけに現れる", async () => {
  const result = await registeredReadOnlyResult();
  const container = new FakeElement("div");
  let fetchCount = 0;
  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
    enableSubmitUi: true,
    liff: makeLiff(),
    submitDependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return jsonResponse({});
    }),
  });
  const cards = collectElements(container).filter((element) => element.tagName === "ARTICLE");
  const submitButtons = collectElements(container).filter(
    (element) => element.className === "attendanceSubmitButton",
  );
  assert.equal(submitButtons.length, 2);
  assert.ok(submitButtons.every((button) => button.type === "button" && button.hidden));
  assert.ok(submitButtons.every((button) => !/event-|本人/.test(button.id)));

  const firstSelect = collectElements(cards[0]).find(
    (element) => element.tagName === "SELECT",
  );
  firstSelect.value = "欠席";
  firstSelect.dispatch("change");
  assert.equal(submitButtons[0].hidden, false);
  assert.equal(submitButtons[1].hidden, true);
  assert.equal(fetchCount, 0, "表示・select変更だけでは通信しない");
  assert.equal(
    collectElements(container).some((element) => /一括保存/.test(element.textContent)),
    false,
  );
});

test("書き込みゲート停止時はdraftを保持しlegacyへfallbackしない", async () => {
  const result = await registeredReadOnlyResult();
  const container = new FakeElement("div");
  const requests = [];
  const summaries = [];
  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
    enableSubmitUi: true,
    liff: makeLiff(),
    onDraftSummary(summary) { summaries.push(summary); },
    submitDependencies: fetchDependencies(async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ ok: false, error: "staging_attendance_write_disabled" }, 403);
    }),
  });
  const firstCard = collectElements(container).find((element) => element.tagName === "ARTICLE");
  const select = collectElements(firstCard).find(
    (element) => element.tagName === "SELECT",
  );
  select.value = "欠席";
  select.dispatch("change");
  const button = collectElements(firstCard).find(
    (element) => element.className === "attendanceSubmitButton",
  );
  await button.dispatchAsync("click");

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/line\/attendance\/submit-authenticated$/);
  assert.equal(select.value, "欠席");
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.deepEqual(summaries.at(-1), { changedEventCount: 1, changedPerformerCount: 1 });
  assert.match(firstCard.textContent, /保存機能は停止しています/);
  assert.doesNotMatch(requests[0].url, /script\.google|\/line\/attendance\/submit$/);
});

test("保存成功後は再取得で確認した予定だけ確定し他予定draftを維持する", async () => {
  const result = await registeredReadOnlyResult();
  const container = new FakeElement("div");
  const requests = [];
  const summaries = [];
  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
    enableSubmitUi: true,
    liff: makeLiff({ getIDToken() { return "click.token.value"; } }),
    onDraftSummary(summary) { summaries.push(summary); },
    submitDependencies: fetchDependencies(async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        const sent = JSON.parse(options.body);
        return jsonResponse(attendanceSubmitResponse(sent));
      }
      return jsonResponse({
            ok: true,
            status: "ok",
            registered: true,
            map: {
              "event-1": [{ performerName: "本人1", attend: "欠席" }],
              "event-2": [
                { performerName: "本人1", attend: "欠席" },
                { performerName: "本人2", attend: "参加" },
              ],
            },
            comments: {
              "event-1": {
                comment: "連絡事項",
                updatedAt: "2026-07-24T00:00:00.000Z",
              },
            },
          });
    }),
  });
  const cards = collectElements(container).filter((element) => element.tagName === "ARTICLE");
  const changeSelect = (card, value) => {
    const select = collectElements(card).find(
      (element) => element.tagName === "SELECT",
    );
    select.value = value;
    select.dispatch("change");
    return select;
  };
  changeSelect(cards[0], "欠席");
  const otherDraft = changeSelect(cards[1], "未定");
  const buttons = cards.map((card) => collectElements(card).find(
    (element) => element.className === "attendanceSubmitButton",
  ));
  await buttons[0].dispatchAsync("click");

  assert.equal(requests.length, 2);
  const sent = JSON.parse(requests[0].options.body);
  assert.match(
    sent.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.deepEqual(
    { ...sent, requestId: REQUEST_ID },
    attendanceSubmitPayload(),
  );
  assert.equal(requests[1].options.body, "{}");
  assert.match(cards[0].textContent, /変更を保存しました/);
  assert.match(cards[0].textContent, /欠席/);
  assert.equal(buttons[0].hidden, true);
  assert.equal(buttons[1].hidden, false);
  assert.equal(otherDraft.value, "未定");
  assert.deepEqual(summaries.at(-1), { changedEventCount: 1, changedPerformerCount: 1 });
});

test("保存中ロックは連打と別予定の同時POSTを防ぎ全draft操作を止める", async () => {
  const result = await registeredReadOnlyResult();
  const container = new FakeElement("div");
  let releaseSubmit;
  const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
  const requests = [];
  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
    enableSubmitUi: true,
    liff: makeLiff(),
    submitDependencies: fetchDependencies(async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        await submitGate;
        const sent = JSON.parse(options.body);
        return jsonResponse(attendanceSubmitResponse(sent));
      }
      return jsonResponse({
        ok: true,
        status: "ok",
        registered: true,
        map: { "event-1": [{ performerName: "本人1", attend: "欠席" }] },
        comments: {
          "event-1": {
            comment: "連絡事項",
            updatedAt: "2026-07-24T00:00:00.000Z",
          },
        },
      });
    }),
  });
  const cards = collectElements(container).filter((element) => element.tagName === "ARTICLE");
  for (const [card, value] of [[cards[0], "欠席"], [cards[1], "未定"]]) {
    const select = collectElements(card).find(
      (element) => element.tagName === "SELECT",
    );
    select.value = value;
    select.dispatch("change");
  }
  const buttons = cards.map((card) => collectElements(card).find(
    (element) => element.className === "attendanceSubmitButton",
  ));
  const first = buttons[0].dispatchAsync("click");
  await Promise.resolve();
  const second = buttons[1].dispatchAsync("click");
  await buttons[0].dispatchAsync("click");
  assert.equal(requests.length, 1);
  const controls = collectElements(container).filter((element) =>
    element.tagName === "SELECT" ||
    element.className === "attendanceSubmitButton" ||
    element.className === "btn btn-ghost productionAttendanceReset"
  );
  assert.ok(controls.every((element) => element.disabled));
  releaseSubmit();
  await Promise.all([first, second]);
  assert.equal(requests.filter((request) => /submit-authenticated$/.test(request.url)).length, 1);
  assert.ok(controls.every((element) => !element.disabled));
});

test("通信失敗・timeoutは自動retryせず保存結果不明としてdraftを残す", async (t) => {
  for (const [name, dependencies] of [
    ["network", fetchDependencies(async () => { throw new TypeError("offline"); })],
    ["timeout", fetchDependencies((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }), { timeoutMs: 5 })],
  ]) {
    await t.test(name, async () => {
      const result = await registeredReadOnlyResult();
      const container = new FakeElement("div");
      let fetchCount = 0;
      const originalFetch = dependencies.fetchImpl;
      dependencies.fetchImpl = async (...args) => {
        fetchCount += 1;
        return originalFetch(...args);
      };
      auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
        enableDraftPreview: true,
        enableSubmitUi: true,
        liff: makeLiff(),
        submitDependencies: dependencies,
      });
      const card = collectElements(container).find((element) => element.tagName === "ARTICLE");
      const select = collectElements(card).find(
        (element) => element.tagName === "SELECT",
      );
      select.value = "欠席";
      select.dispatch("change");
      const button = collectElements(card).find(
        (element) => element.className === "attendanceSubmitButton",
      );
      await button.dispatchAsync("click");
      assert.equal(fetchCount, 1);
      assert.equal(select.value, "欠席");
      assert.equal(button.hidden, false);
      assert.match(card.textContent, /保存結果を確認できませんでした/);
    });
  }
});

test("回答不可予定はtextContentだけで描画し、accordion以外の操作要素を生成しない", () => {
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
      initialComment: "",
      eventAllowed: false,
      eventWriteReason: "deadline_passed",
      eventWriteLabel: '<b onclick="throw new Error(3)">回答不可</b>',
      performers: [{
        performerName: htmlLikeName,
        attendanceLabel: "未回答",
        initialAttend: "未回答",
        attendanceWriteAllowed: false,
        attendanceWriteReason: "deadline_passed",
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
  for (const forbidden of ["IMG", "SCRIPT", "B", "INPUT", "SELECT", "TEXTAREA", "FORM"]) {
    assert.equal(tags.includes(forbidden), false, forbidden);
  }
  const accordion = collectElements(container).filter(
    (element) => element.className === "fHead productionAttendanceAccordionButton",
  );
  assert.equal(accordion.length, 1);
  assert.equal(accordion[0].type, "button");
  assert.equal(container.attributes.role, "list");
});

test("production形式の予定カードは安全な連番で開閉する", async () => {
  const result = await registeredReadOnlyResult();
  const container = new FakeElement("div");
  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
  });
  const firstCard = collectElements(container).find(
    (element) => element.tagName === "ARTICLE",
  );
  const toggle = collectElements(firstCard).find(
    (element) => element.className === "fHead productionAttendanceAccordionButton",
  );
  const body = collectElements(firstCard).find(
    (element) => element.className === "fBody productionAttendanceBody",
  );

  assert.equal(body.hidden, true);
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(toggle.attributes["aria-controls"], body.id);
  assert.doesNotMatch(
    `${body.id}\n${toggle.attributes["aria-controls"]}`,
    /event-[12]|本人/,
  );

  toggle.dispatch("click");
  assert.equal(body.hidden, false);
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.match(firstCard.className, /\bopen\b/);

  toggle.dispatch("click");
  assert.equal(body.hidden, true);
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.doesNotMatch(firstCard.className, /\bopen\b/);
});

test("production出欠フォームと同じくイベント備考を描画しない", async () => {
  const result = await registeredReadOnlyResult();
  result.viewModel.events[0].note = "出欠フォームには表示しない備考";
  const container = new FakeElement("div");

  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
  });

  assert.doesNotMatch(container.textContent, /出欠フォームには表示しない備考/);
  assert.equal(
    collectElements(container).some(
      (element) => element.className === "productionAttendanceNote",
    ),
    false,
  );
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
      return jsonResponse({
        ok: true,
        registered: false,
        admin: { authorized: false },
        member: {
          inputName: "",
          notify: false,
          viewerOnly: false,
          performers: [],
        },
        events: [],
      });
    }),
  });
  assert.equal(result.status, auth.AUTH_STATES.UNREGISTERED);
  assert.equal(fetchCount, 1);
  assert.deepEqual(states, [auth.AUTH_STATES.LOADING, auth.AUTH_STATES.UNREGISTERED]);
});

test("管理者権限は真偽値だけを保持し登録状態と独立して返す", async () => {
  const registeredResult = await registeredReadOnlyResult({
    ...registeredHome(),
    admin: { authorized: true },
  });
  assert.deepEqual(registeredResult.adminAccess, { authorized: true });
  assert.equal(JSON.stringify(registeredResult).includes("lineId"), false);

  let fetchCount = 0;
  const unregisteredResult = await auth.startStagingAuthenticatedReadOnly({
    liff: makeLiff(),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return jsonResponse({
        ok: true,
        registered: false,
        admin: { authorized: true },
        member: {
          inputName: "",
          notify: false,
          viewerOnly: false,
          performers: [],
        },
        events: [],
      });
    }),
  });
  assert.equal(fetchCount, 1);
  assert.equal(unregisteredResult.status, auth.AUTH_STATES.UNREGISTERED);
  assert.deepEqual(unregisteredResult.adminAccess, { authorized: true });
});

test("管理予定一覧は操作時のIDトークンで専用GETだけを呼ぶ", async () => {
  const requests = [];
  const result = await auth.startAuthenticatedAdminSchedules({
    liff: makeLiff(),
    dependencies: fetchDependencies(async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(adminSchedulesResponse());
    }),
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `${TEST_WORKER_BASE_URL}${auth.AUTHENTICATED_ADMIN_SCHEDULES_PATH}`,
  );
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].options.body, undefined);
  assert.deepEqual(result, {
    schedules: adminSchedulesResponse().schedules,
    hasMore: false,
  });
  assert.equal(JSON.stringify(result).includes("lineId"), false);
});

test("管理予定一覧は不正契約・Token欠落・HTTP失敗を成功扱いしない", async (t) => {
  for (const [name, response] of [
    ["余分なtop-level属性", jsonResponse(adminSchedulesResponse({ extra: true }))],
    ["hasMore型不正", jsonResponse(adminSchedulesResponse({ hasMore: "false" }))],
    ["予定重複", jsonResponse(adminSchedulesResponse({
      schedules: [
        adminSchedulesResponse().schedules[0],
        adminSchedulesResponse().schedules[0],
      ],
    }))],
    ["日付不正", jsonResponse(adminSchedulesResponse({
      schedules: [{
        ...adminSchedulesResponse().schedules[0],
        date: "20260231",
      }],
    }))],
    ["管理者拒否", jsonResponse({ ok: false, error: "admin_forbidden" }, 403)],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        auth.startAuthenticatedAdminSchedules({
          liff: makeLiff(),
          dependencies: fetchDependencies(async () => response),
        }),
        (error) => error instanceof auth.AuthSessionError,
      );
    });
  }

  await t.test("Tokenなし", async () => {
    let fetchCount = 0;
    await assert.rejects(
      auth.startAuthenticatedAdminSchedules({
        liff: makeLiff({ getIDToken() { return null; } }),
        dependencies: fetchDependencies(async () => {
          fetchCount += 1;
        }),
      }),
      (error) => error instanceof auth.AuthSessionError
        && error.type === auth.AUTH_STATES.UNAUTHENTICATED,
    );
    assert.equal(fetchCount, 0);
  });
});

test("管理出欠レポートは生IDを送らず認証済みGETだけで一覧と詳細を取得する", async () => {
  const requests = [];
  const dependencies = fetchDependencies(async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? jsonResponse(adminAttendanceReportEventsResponse())
      : jsonResponse(adminAttendanceReportResponse());
  });

  const events = await auth.startAuthenticatedAdminAttendanceReport({
    liff: makeLiff(),
    dependencies,
  });
  const report = await auth.loadAuthenticatedAdminAttendanceReport(
    "admin-event-1",
    {
      liff: makeLiff(),
      dependencies,
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    `${TEST_WORKER_BASE_URL}${auth.AUTHENTICATED_ADMIN_ATTENDANCE_REPORT_PATH}`,
  );
  assert.equal(
    requests[1].url,
    `${TEST_WORKER_BASE_URL}${auth.AUTHENTICATED_ADMIN_ATTENDANCE_REPORT_PATH}`
      + "?eventKey=admin-event-1",
  );
  for (const requestValue of requests) {
    assert.equal(requestValue.options.method, "GET");
    assert.equal(
      requestValue.options.headers.Authorization,
      `Bearer ${TOKEN}`,
    );
    assert.equal(requestValue.options.body, undefined);
    assert.doesNotMatch(
      requestValue.url,
      /lineId|line_id|memberId|token|header\.payload/,
    );
  }
  assert.deepEqual(events, {
    events: [adminAttendanceReportEvent()],
    hasMore: false,
  });
  assert.deepEqual(report, {
    event: adminAttendanceReportEvent(),
    rows: adminAttendanceReportResponse().rows,
    counts: adminAttendanceReportResponse().counts,
  });
  assert.doesNotMatch(
    JSON.stringify({ events, report }),
    /lineId|line_id|birthYear|sortGroup|header\.payload/,
  );
});

test("管理出欠レポートは余分な属性・件数不一致・不正値を拒否する", async (t) => {
  for (const [name, body, detail] of [
    [
      "events余分な属性",
      adminAttendanceReportEventsResponse({ extra: true }),
      false,
    ],
    [
      "event key重複",
      adminAttendanceReportEventsResponse({
        events: [
          adminAttendanceReportEvent(),
          adminAttendanceReportEvent(),
        ],
      }),
      false,
    ],
    [
      "detail event不一致",
      adminAttendanceReportResponse({
        event: adminAttendanceReportEvent({ eventKey: "other-event" }),
      }),
      true,
    ],
    [
      "row余分な属性",
      adminAttendanceReportResponse({
        rows: [{
          ...adminAttendanceReportResponse().rows[0],
          lineId: "forbidden",
        }],
        counts: {
          participating: 1,
          absent: 0,
          undecided: 0,
          unanswered: 0,
          total: 1,
        },
      }),
      true,
    ],
    [
      "件数不一致",
      adminAttendanceReportResponse({
        counts: {
          participating: 2,
          absent: 0,
          undecided: 0,
          unanswered: 0,
          total: 2,
        },
      }),
      true,
    ],
    [
      "出欠不正",
      adminAttendanceReportResponse({
        rows: [{
          ...adminAttendanceReportResponse().rows[0],
          attend: "回答済み",
        }],
        counts: {
          participating: 0,
          absent: 0,
          undecided: 0,
          unanswered: 0,
          total: 1,
        },
      }),
      true,
    ],
  ]) {
    await t.test(name, async () => {
      const operation = detail
        ? auth.loadAuthenticatedAdminAttendanceReport(
          "admin-event-1",
          {
            liff: makeLiff(),
            dependencies: fetchDependencies(async () => jsonResponse(body)),
          },
        )
        : auth.startAuthenticatedAdminAttendanceReport({
          liff: makeLiff(),
          dependencies: fetchDependencies(async () => jsonResponse(body)),
        });
      await assert.rejects(
        operation,
        (error) => error instanceof auth.AuthSessionError
          && error.type === auth.AUTH_STATES.RESPONSE_ERROR,
      );
    });
  }
});

test("管理出欠レポートは不正event key・Token欠落・権限拒否を成功扱いしない", async () => {
  let fetchCount = 0;
  await assert.rejects(
    auth.loadAuthenticatedAdminAttendanceReport(" invalid ", {
      liff: makeLiff(),
      dependencies: fetchDependencies(async () => {
        fetchCount += 1;
      }),
    }),
    (error) => error instanceof auth.AuthSessionError
      && error.code === "invalid_admin_attendance_report_event",
  );
  assert.equal(fetchCount, 0);

  await assert.rejects(
    auth.startAuthenticatedAdminAttendanceReport({
      liff: makeLiff({ getIDToken() { return ""; } }),
      dependencies: fetchDependencies(async () => {
        fetchCount += 1;
      }),
    }),
    (error) => error instanceof auth.AuthSessionError
      && error.type === auth.AUTH_STATES.UNAUTHENTICATED,
  );
  assert.equal(fetchCount, 0);

  await assert.rejects(
    auth.startAuthenticatedAdminAttendanceReport({
      liff: makeLiff(),
      dependencies: fetchDependencies(async () =>
        jsonResponse({ ok: false, error: "admin_forbidden" }, 403)
      ),
    }),
    (error) => error instanceof auth.AuthSessionError
      && error.status === 403,
  );
});

test("管理配車補助は生IDを送らず認証済みGETだけで候補を取得する", async () => {
  const requests = [];
  const dependencies = fetchDependencies(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(adminCarpoolResponse());
  });

  const result = await auth.loadAuthenticatedAdminCarpool(
    "admin-event-1",
    {
      liff: makeLiff(),
      dependencies,
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `${TEST_WORKER_BASE_URL}${auth.AUTHENTICATED_ADMIN_CARPOOL_PATH}`
      + "?eventKey=admin-event-1",
  );
  assert.equal(requests[0].options.method, "GET");
  assert.equal(
    requests[0].options.headers.Authorization,
    `Bearer ${TOKEN}`,
  );
  assert.equal(requests[0].options.body, undefined);
  assert.doesNotMatch(
    requests[0].url,
    /lineId|line_id|memberId|token|header\.payload/,
  );
  assert.deepEqual(result, {
    event: adminAttendanceReportEvent(),
    participantCount: 3,
    candidateCount: 2,
    candidates: adminCarpoolResponse().candidates,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /lineId|line_id|memberId|memberIds|header\.payload/,
  );
});

test("管理配車補助は余分な属性・件数不一致・候補不正を拒否する", async (t) => {
  for (const [name, body] of [
    ["top余分な属性", adminCarpoolResponse({ extra: true })],
    ["候補件数不一致", adminCarpoolResponse({ candidateCount: 1 })],
    ["参加者件数不一致", adminCarpoolResponse({ participantCount: 4 })],
    [
      "候補余分な属性",
      adminCarpoolResponse({
        participantCount: 1,
        candidateCount: 1,
        candidates: [{
          displayName: "登録者1",
          participantNames: ["演奏者1"],
          comment: "",
          lineId: "forbidden",
        }],
      }),
    ],
    [
      "参加者重複",
      adminCarpoolResponse({
        participantCount: 2,
        candidateCount: 1,
        candidates: [{
          displayName: "登録者1",
          participantNames: ["演奏者1", "演奏者1"],
          comment: "",
        }],
      }),
    ],
    [
      "event不一致",
      adminCarpoolResponse({
        event: adminAttendanceReportEvent({ eventKey: "other-event" }),
      }),
    ],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        auth.loadAuthenticatedAdminCarpool("admin-event-1", {
          liff: makeLiff(),
          dependencies: fetchDependencies(async () => jsonResponse(body)),
        }),
        (error) => error instanceof auth.AuthSessionError
          && error.type === auth.AUTH_STATES.RESPONSE_ERROR,
      );
    });
  }
});

test("管理配車補助は不正event key・Token欠落・権限拒否を成功扱いしない", async () => {
  let fetchCount = 0;
  await assert.rejects(
    auth.loadAuthenticatedAdminCarpool(" invalid ", {
      liff: makeLiff(),
      dependencies: fetchDependencies(async () => {
        fetchCount += 1;
      }),
    }),
    (error) => error instanceof auth.AuthSessionError
      && error.code === "invalid_admin_carpool_event",
  );
  assert.equal(fetchCount, 0);

  await assert.rejects(
    auth.loadAuthenticatedAdminCarpool("admin-event-1", {
      liff: makeLiff({ getIDToken() { return ""; } }),
      dependencies: fetchDependencies(async () => {
        fetchCount += 1;
      }),
    }),
    (error) => error instanceof auth.AuthSessionError
      && error.type === auth.AUTH_STATES.UNAUTHENTICATED,
  );
  assert.equal(fetchCount, 0);

  await assert.rejects(
    auth.loadAuthenticatedAdminCarpool("admin-event-1", {
      liff: makeLiff(),
      dependencies: fetchDependencies(async () =>
        jsonResponse({ ok: false, error: "admin_forbidden" }, 403)
      ),
    }),
    (error) => error instanceof auth.AuthSessionError
      && error.status === 403,
  );
});

test("管理予定保存は認証済みPOSTだけを使い再取得version一致後に成功する", async () => {
  const requests = [];
  const result = await auth.submitAuthenticatedAdminSchedule_(
    adminScheduleInput(),
    {
      liff: makeLiff(),
      dependencies: fetchDependencies(async (url, options) => {
        requests.push({ url, options });
        if (requests.length === 1) {
          const sent = JSON.parse(options.body);
          assert.deepEqual(sent, {
            requestId: REQUEST_ID,
            ...adminScheduleInput(),
          });
          assert.equal(JSON.stringify(sent).includes("lineId"), false);
          assert.equal(JSON.stringify(sent).includes("memberId"), false);
          return jsonResponse({
            ok: true,
            status: "ok",
            requestId: REQUEST_ID,
            mode: "create",
            eventKey: "20990102AA",
            updatedAt: "2026-07-24T00:00:00.000Z",
          });
        }
        return jsonResponse({
          ok: true,
          status: "ok",
          schedules: [writableAdminSchedule()],
          hasMore: false,
        });
      }, {
        createRequestId() { return REQUEST_ID; },
      }),
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    `${TEST_WORKER_BASE_URL}${auth.AUTHENTICATED_ADMIN_SCHEDULE_SUBMIT_PATH}`,
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(
    requests[1].url,
    `${TEST_WORKER_BASE_URL}${auth.AUTHENTICATED_ADMIN_SCHEDULES_PATH}`,
  );
  assert.equal(result.schedule.eventKey, "20990102AA");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("管理予定編集はeventKeyとversionだけを送りclient申告IDを許可しない", async () => {
  const input = adminScheduleInput({
    mode: "update",
    eventKey: "20990102AA",
    expectedUpdatedAt: "2026-07-23T00:00:00.000Z",
  });
  const payload = auth.buildAuthenticatedAdminSchedulePayload_(input, {
    createRequestId() { return REQUEST_ID; },
  });
  assert.deepEqual(payload, { requestId: REQUEST_ID, ...input });
  assert.equal(JSON.stringify(payload).includes("lineId"), false);

  for (const invalid of [
    { ...input, lineId: "client-identity" },
    { ...input, expectedUpdatedAt: 123 },
    adminScheduleInput({
      schedule: { ...adminScheduleInput().schedule, extra: "x" },
    }),
    adminScheduleInput({
      schedule: { ...adminScheduleInput().schedule, date: "20990231" },
    }),
  ]) {
    assert.throws(
      () => auth.buildAuthenticatedAdminSchedulePayload_(invalid, {
        createRequestId() { return REQUEST_ID; },
      }),
      (error) => error instanceof auth.AuthSessionError,
    );
  }
});

test("管理予定保存は再取得不一致・通信結果不明を成功扱いせず自動retryしない", async () => {
  let mismatchCount = 0;
  await assert.rejects(
    auth.submitAuthenticatedAdminSchedule_(
      adminScheduleInput(),
      {
        liff: makeLiff(),
        dependencies: fetchDependencies(async () => {
          mismatchCount += 1;
          return mismatchCount === 1
            ? jsonResponse({
                ok: true,
                status: "ok",
                requestId: REQUEST_ID,
                mode: "create",
                eventKey: "20990102AA",
                updatedAt: "2026-07-24T00:00:00.000Z",
              })
            : jsonResponse({
                ok: true,
                status: "ok",
                schedules: [writableAdminSchedule({
                  updatedAt: "different-version",
                })],
                hasMore: false,
              });
        }, {
          createRequestId() { return REQUEST_ID; },
        }),
      },
    ),
    (error) => error instanceof auth.AuthSessionError
      && error.code === "admin_schedule_confirmation_failed",
  );
  assert.equal(mismatchCount, 2);

  let networkCount = 0;
  let networkError;
  try {
    await auth.submitAuthenticatedAdminSchedule_(
      adminScheduleInput(),
      {
        liff: makeLiff(),
        dependencies: fetchDependencies(async () => {
          networkCount += 1;
          throw new Error("network");
        }, {
          createRequestId() { return REQUEST_ID; },
        }),
      },
    );
  } catch (error) {
    networkError = error;
  }
  assert.equal(networkCount, 1);
  assert.equal(
    auth.classifyAdminScheduleSubmitError_(networkError),
    "result_unknown",
  );
});

test("管理者権限の欠落・余分な属性・型不正をresponse errorにする", async (t) => {
  for (const [name, adminValue] of [
    ["欠落", undefined],
    ["余分な属性", { authorized: true, role: "admin" }],
    ["型不正", { authorized: "true" }],
  ]) {
    await t.test(name, async () => {
      const home = registeredHome();
      if (adminValue === undefined) delete home.admin;
      else home.admin = adminValue;
      const result = await registeredReadOnlyResult(home);
      assert.equal(result.status, auth.AUTH_STATES.RESPONSE_ERROR);
    });
  }
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

test("ご意見投稿はIDトークン認証だけを使い自己申告本人情報を送らない", async () => {
  const calls = [];
  const result = await auth.submitAuthenticatedFeedback_(
    { category: "要望", message: "改善してほしい点です" },
    {
      liff: makeLiff(),
      dependencies: fetchDependencies(async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
          ok: true,
          status: "ok",
          requestId: REQUEST_ID,
          feedbackId: "a".repeat(64),
          feedbackStatus: "未対応",
        });
      }, {
        createRequestId: () => REQUEST_ID,
      }),
    },
  );
  assert.equal(result.status, "未対応");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${TEST_WORKER_BASE_URL}/line/feedback/submit-authenticated`,
  );
  assert.equal(calls[0].options.mode, "cors");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    requestId: REQUEST_ID,
    category: "要望",
    message: "改善してほしい点です",
  });
  assert.doesNotMatch(
    calls[0].options.body,
    /lineId|line_id|memberId|userId|name|sub/,
  );
});

test("管理者ご意見一覧とstatus更新は認証済み契約を厳密に検証する", async () => {
  const calls = [];
  const dependencies = fetchDependencies(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/line/admin/feedback-authenticated")) {
      return jsonResponse({
        ok: true,
        status: "ok",
        items: [{
          feedbackId: "b".repeat(64),
          name: "登録名",
          at: "2026-07-27T00:00:00.000Z",
          category: "不具合",
          message: "表示の問題",
          status: "未対応",
          updatedAt: "2026-07-27T00:00:00.000Z",
        }],
        hasMore: false,
      });
    }
    return jsonResponse({
      ok: true,
      status: "ok",
      requestId: REQUEST_ID,
      feedbackId: "b".repeat(64),
      feedbackStatus: "対応中",
    });
  }, {
    createRequestId: () => REQUEST_ID,
  });
  const list = await auth.loadAuthenticatedAdminFeedback_({
    liff: makeLiff(),
    dependencies,
  });
  assert.equal(list.items.length, 1);
  const updated = await auth.updateAuthenticatedAdminFeedbackStatus_(
    {
      feedbackId: "b".repeat(64),
      status: "対応中",
      expectedUpdatedAt: "2026-07-27T00:00:00.000Z",
    },
    { liff: makeLiff(), dependencies },
  );
  assert.equal(updated.status, "対応中");
  const payload = JSON.parse(calls[1].options.body);
  assert.deepEqual(payload, {
    requestId: REQUEST_ID,
    feedbackId: "b".repeat(64),
    status: "対応中",
    expectedUpdatedAt: "2026-07-27T00:00:00.000Z",
  });
  assert.doesNotMatch(
    calls.map((call) => call.url + String(call.options.body || "")).join(" "),
    /lineId|line_id|memberId|userId|sub/,
  );
});

test("カスタム通知はopaque宛先refだけを送りqueue成功と実送信を区別する", async () => {
  const calls = [];
  const recipientRef = "c".repeat(64);
  const dependencies = fetchDependencies(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/preview-authenticated")) {
      return jsonResponse({
        ok: true,
        status: "ok",
        event: null,
        recipientCount: 1,
        automaticRecipients: [],
        manualCandidates: [{
          recipientRef,
          displayName: "登録名",
          performerNames: ["演奏者"],
          selected: true,
        }],
      });
    }
    return jsonResponse({
      ok: true,
      status: "ok",
      requestId: REQUEST_ID,
      jobId: "d".repeat(64),
      deliveryStatus: "queued",
      recipientCount: 1,
    });
  }, {
    createRequestId: () => REQUEST_ID,
  });
  const preview = await auth.previewAuthenticatedCustomNotification_(
    { eventKey: "", statuses: [], extraRecipientRefs: [recipientRef] },
    { liff: makeLiff(), dependencies },
  );
  assert.equal(preview.recipientCount, 1);
  const queued = await auth.submitAuthenticatedCustomNotification_(
    {
      eventKey: "",
      statuses: [],
      extraRecipientRefs: [recipientRef],
      message: "安全なテスト通知",
    },
    { liff: makeLiff(), dependencies },
  );
  assert.equal(queued.deliveryStatus, "queued");
  assert.equal(queued.recipientCount, 1);
  const submitted = JSON.parse(calls[1].options.body);
  assert.equal(submitted.requestId, REQUEST_ID);
  assert.deepEqual(submitted.extraRecipientRefs, [recipientRef]);
  assert.doesNotMatch(
    calls.map((call) => String(call.options.body || "")).join(" "),
    /lineId|line_id|extraLineIds|senderLineId|memberId|userId|sub/,
  );
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
          : jsonResponse({
              status: "ok",
              ok: true,
              registered: false,
              map: {},
              comments: {},
            });
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
  assert.equal(captured.url, `${TEST_WORKER_BASE_URL}/auth/session`);
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
  assert.match(copies.unregistered.message, /初回登録は現在利用できません/);
  assert.match(copies.registered.title, /本人認証済み/);
  assert.match(copies.registered.message, /予定ごとに保存できます/);
  assert.match(copies.registered.message, /保存機能はテスト用ゲートにより停止している場合があります/);
  assert.doesNotMatch(copies.registered.message, /表示確認のみ|登録・変更はまだ利用できません/);
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
