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

test("回答可能な本人演奏者だけにradio draft UIを生成する", async () => {
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
  const radios = elements.filter((element) => element.tagName === "INPUT");
  const fieldsets = elements.filter((element) => element.tagName === "FIELDSET");
  const legends = elements.filter((element) => element.tagName === "LEGEND");
  const labels = elements.filter((element) => element.tagName === "LABEL");
  const resets = elements.filter((element) => element.tagName === "BUTTON");

  // event-1は2人、event-2は対象区分が合う1人だけが各3選択肢を持つ。
  assert.equal(fieldsets.length, 3);
  assert.equal(radios.length, 9);
  assert.equal(labels.length, 9);
  assert.equal(resets.length, 3);
  assert.ok(legends.every((legend) => /の出欠$/.test(legend.textContent)));
  assert.ok(radios.every((radio) => radio.type === "radio"));
  assert.ok(resets.every((button) => button.type === "button"));
  assert.deepEqual(summaries[0], { changedEventCount: 0, changedPerformerCount: 0 });

  // 参加と欠席は初期選択、未回答の本人2は未選択。
  assert.equal(radios.filter((radio) => radio.checked).length, 2);
  assert.ok(radios.some((radio) => radio.checked && radio.value === "参加"));
  assert.ok(radios.some((radio) => radio.checked && radio.value === "欠席"));
  assert.deepEqual(new Set(radios.map((radio) => radio.value)), new Set(["参加", "欠席", "未定"]));

  for (const radio of radios) {
    assert.doesNotMatch(`${radio.id}\n${radio.name}`, /event-[12]|本人[12]/);
  }
  for (const label of labels) {
    assert.ok(radios.some((radio) => radio.id === label.attributes.for));
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
    // 元の3回答可能演奏者から1人を除外するため、2組×3 radio。
    assert.equal(elements.filter((element) => element.tagName === "INPUT").length, 6, reason);
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
    collectElements(container).filter((element) => element.tagName === "INPUT").length,
    3,
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
    const checked = collectElements(container).filter(
      (element) => element.tagName === "INPUT" && element.checked,
    );
    assert.equal(checked.length, expected ? 1 : 0, initialAttend);
    if (expected) assert.equal(checked[0].value, expected);
  }
});

test("draft変更・元回答への復帰・取り消しをメモリ内だけで管理する", async () => {
  const result = await registeredReadOnlyResult();
  const state = auth.createAttendanceDraftState_(result.viewModel.events);
  assert.equal(state.size, 3);
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

test("radio操作と変更取り消しが集計と初期選択を更新する", async () => {
  const result = await registeredReadOnlyResult();
  const container = new FakeElement("div");
  const summaries = [];
  auth.renderReadOnlySchedules_(container, result.viewModel, fakeDocument(), {
    enableDraftPreview: true,
    onDraftSummary(summary) { summaries.push(summary); },
  });
  const elements = collectElements(container);
  const firstGroup = elements.find((element) => element.tagName === "FIELDSET");
  const groupElements = collectElements(firstGroup);
  const radios = groupElements.filter((element) => element.tagName === "INPUT");
  const reset = groupElements.find((element) => element.tagName === "BUTTON");
  const absence = radios.find((radio) => radio.value === "欠席");

  radios.forEach((radio) => { radio.checked = false; });
  absence.checked = true;
  absence.dispatch("change");
  assert.deepEqual(summaries.at(-1), { changedEventCount: 1, changedPerformerCount: 1 });
  assert.equal(reset.hidden, false);

  reset.dispatch("click");
  assert.deepEqual(summaries.at(-1), { changedEventCount: 0, changedPerformerCount: 0 });
  assert.equal(reset.hidden, true);
  assert.equal(radios.find((radio) => radio.value === "参加").checked, true);
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
  assert.equal(elements.filter((element) => element.tagName === "INPUT").length, 6);
  assert.equal(elements.filter((element) => element.tagName === "IMG").length, 0);
  assert.match(container.textContent, /<img src=x/);
  for (const input of elements.filter((element) => element.tagName === "INPUT")) {
    assert.equal((input.listeners.change || []).length, 1);
    assert.doesNotMatch(`${input.id}\n${input.name}`, /<img|onerror/);
  }
});

test("変更された本人演奏者だけをevent別merge payloadへ変換する", async () => {
  const result = await registeredReadOnlyResult();
  const state = auth.createAttendanceDraftState_(result.viewModel.events);
  auth.setAttendanceDraftSelection_(state, "0:0", "欠席");
  auth.setAttendanceDraftSelection_(state, "0:1", "参加");
  auth.setAttendanceDraftSelection_(state, "1:0", "未定");

  const payloads = auth.buildAuthenticatedAttendanceDraftPayloads_(result.viewModel.events, state);
  assert.deepEqual(payloads, [
    {
      eventKey: "event-1",
      mode: "merge",
      items: [
        { performerName: "本人1", attend: "欠席" },
        { performerName: "本人2", attend: "参加" },
      ],
    },
    {
      eventKey: "event-2",
      mode: "merge",
      items: [{ performerName: "本人1", attend: "未定" }],
    },
  ]);
  assert.deepEqual(auth.summarizeAttendanceDraft_(result.viewModel.events, state), {
    changedEventCount: 2,
    changedPerformerCount: 3,
  });
  const serialized = JSON.stringify(payloads);
  assert.doesNotMatch(serialized, /lineId|line_id|lineUserId|userId|memberId|token|comment/);
  assert.deepEqual(
    new Set(payloads.flatMap((payload) => payload.items.map((item) => item.attend))),
    new Set(["参加", "欠席", "未定"]),
  );

  auth.resetAttendanceDraftSelection_(state, "0:1");
  const afterReset = auth.buildAuthenticatedAttendanceDraftPayloads_(result.viewModel.events, state);
  assert.deepEqual(afterReset[0].items, [{ performerName: "本人1", attend: "欠席" }]);
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
  const payload = {
    eventKey: "event-1",
    mode: "merge",
    items: [{ performerName: "本人1", attend: "欠席" }],
  };
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
        ? jsonResponse({ ok: true, status: "ok", updatedCount: 1 })
        : jsonResponse({
            ok: true,
            status: "ok",
            registered: true,
            map: { "event-1": [{ performerName: "本人1", attend: "欠席" }] },
          });
    }),
  });

  assert.equal(tokenCalls, 1);
  assert.deepEqual(result, {
    updatedCount: 1,
    confirmedItems: [{ performerName: "本人1", attend: "欠席" }],
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    `${auth.STAGING_WORKER_BASE_URL}/line/attendance/submit-authenticated`,
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer fresh.token.value");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.equal(requests[0].options.mode, "cors");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(Object.hasOwn(requests[0].options.headers, "Origin"), false);
  assert.deepEqual(JSON.parse(requests[0].options.body), payload);
  assert.equal(requests[1].url, `${auth.STAGING_WORKER_BASE_URL}/line/attendance/all`);
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.body, "{}");
  assert.equal(requests[1].options.headers.Authorization, "Bearer fresh.token.value");
});

test("保存Token・payload・成功応答が不正なら安全側に停止する", async (t) => {
  const payload = {
    eventKey: "event-1",
    mode: "merge",
    items: [{ performerName: "本人1", attend: "欠席" }],
  };
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
    ["ok不正", { ok: false, status: "ok", updatedCount: 1 }],
    ["status不正", { ok: true, status: "success", updatedCount: 1 }],
    ["updatedCount型不正", { ok: true, status: "ok", updatedCount: "1" }],
    ["updatedCount不一致", { ok: true, status: "ok", updatedCount: 2 }],
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
          return jsonResponse({ ok: true, status: "ok", updatedCount: 1 }, 201);
        }),
      }),
      /unexpected_success_status/,
    );
    assert.equal(fetchCount, 1);
  });
});

test("保存後のattendance再取得が一致しなければdraft確定材料にしない", async (t) => {
  const payload = {
    eventKey: "event-1",
    mode: "merge",
    items: [{ performerName: "本人1", attend: "欠席" }],
  };
  for (const [name, attendanceResponse] of [
    ["値不一致", jsonResponse({
      ok: true,
      status: "ok",
      registered: true,
      map: { "event-1": [{ performerName: "本人1", attend: "参加" }] },
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
              ? jsonResponse({ ok: true, status: "ok", updatedCount: 1 })
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

  const firstCardRadios = collectElements(cards[0]).filter((element) => element.tagName === "INPUT");
  const absence = firstCardRadios.find((radio) => radio.value === "欠席" && !radio.checked);
  absence.checked = true;
  absence.dispatch("change");
  assert.equal(submitButtons[0].hidden, false);
  assert.equal(submitButtons[1].hidden, true);
  assert.equal(fetchCount, 0, "表示・radio変更だけでは通信しない");
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
  const absence = collectElements(firstCard).find(
    (element) => element.tagName === "INPUT" && element.value === "欠席" && !element.checked,
  );
  absence.checked = true;
  absence.dispatch("change");
  const button = collectElements(firstCard).find(
    (element) => element.className === "attendanceSubmitButton",
  );
  await button.dispatchAsync("click");

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/line\/attendance\/submit-authenticated$/);
  assert.equal(absence.checked, true);
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
      return requests.length === 1
        ? jsonResponse({ ok: true, status: "ok", updatedCount: 1 })
        : jsonResponse({
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
          });
    }),
  });
  const cards = collectElements(container).filter((element) => element.tagName === "ARTICLE");
  const changeRadio = (card, value) => {
    const radio = collectElements(card).find(
      (element) => element.tagName === "INPUT" && element.value === value && !element.checked,
    );
    radio.checked = true;
    radio.dispatch("change");
    return radio;
  };
  changeRadio(cards[0], "欠席");
  const otherDraft = changeRadio(cards[1], "未定");
  const buttons = cards.map((card) => collectElements(card).find(
    (element) => element.className === "attendanceSubmitButton",
  ));
  await buttons[0].dispatchAsync("click");

  assert.equal(requests.length, 2);
  const sent = JSON.parse(requests[0].options.body);
  assert.deepEqual(sent, {
    eventKey: "event-1",
    mode: "merge",
    items: [{ performerName: "本人1", attend: "欠席" }],
  });
  assert.equal(requests[1].options.body, "{}");
  assert.match(cards[0].textContent, /変更を保存しました/);
  assert.match(cards[0].textContent, /欠席/);
  assert.equal(buttons[0].hidden, true);
  assert.equal(buttons[1].hidden, false);
  assert.equal(otherDraft.checked, true);
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
        return jsonResponse({ ok: true, status: "ok", updatedCount: 1 });
      }
      return jsonResponse({
        ok: true,
        status: "ok",
        registered: true,
        map: { "event-1": [{ performerName: "本人1", attend: "欠席" }] },
      });
    }),
  });
  const cards = collectElements(container).filter((element) => element.tagName === "ARTICLE");
  for (const [card, value] of [[cards[0], "欠席"], [cards[1], "未定"]]) {
    const radio = collectElements(card).find(
      (element) => element.tagName === "INPUT" && element.value === value && !element.checked,
    );
    radio.checked = true;
    radio.dispatch("change");
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
    element.tagName === "INPUT" || element.tagName === "BUTTON"
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
      const radio = collectElements(card).find(
        (element) => element.tagName === "INPUT" && element.value === "欠席" && !element.checked,
      );
      radio.checked = true;
      radio.dispatch("change");
      const button = collectElements(card).find(
        (element) => element.className === "attendanceSubmitButton",
      );
      await button.dispatchAsync("click");
      assert.equal(fetchCount, 1);
      assert.equal(radio.checked, true);
      assert.equal(button.hidden, false);
      assert.match(card.textContent, /保存結果を確認できませんでした/);
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
