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

function registeredHome() {
  return {
    ok: true,
    registered: true,
    member: {
      performers: [
        { performerName: "本人1" },
        { performerName: "本人2" },
      ],
    },
    events: [{ eventKey: "event-1" }, { eventKey: "event-2" }],
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
    }),
    unauthenticated: auth.getReadOnlyUiCopy(auth.AUTH_STATES.UNAUTHENTICATED),
    database: auth.getReadOnlyUiCopy(auth.AUTH_STATES.DATABASE_ERROR),
    temporary: auth.getReadOnlyUiCopy(auth.AUTH_STATES.TEMPORARY_ERROR),
    network: auth.getReadOnlyUiCopy(auth.AUTH_STATES.NETWORK_ERROR),
    response: auth.getReadOnlyUiCopy(auth.AUTH_STATES.RESPONSE_ERROR),
  };

  assert.match(copies.loading.title, /安全に確認/);
  assert.match(copies.unregistered.message, /まだあなたのメンバー情報が登録されていません/);
  assert.match(copies.registered.message, /読み取り専用/);
  assert.match(copies.registered.message, /メンバー件数: 2/);
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
