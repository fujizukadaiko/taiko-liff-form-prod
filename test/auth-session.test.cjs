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

test("LIFF init完了前にIDトークンを取得しない", async () => {
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
  const promise = auth.startStagingLineAuthCheck({
    liff,
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      calls.push("fetch");
      return jsonResponse({ ok: true, authenticated: true });
    }),
  });

  await Promise.resolve();
  assert.deepEqual(calls, ["init:start"]);
  releaseInit();
  const result = await promise;
  assert.equal(result.status, auth.AUTH_STATES.AUTHENTICATED);
  assert.deepEqual(calls, ["init:start", "init:end", "isLoggedIn", "getIDToken", "fetch"]);
});

test("未ログインならloginを呼び、トークン取得とfetchを行わない", async () => {
  let loginCount = 0;
  let tokenCount = 0;
  let fetchCount = 0;
  const result = await auth.startStagingLineAuthCheck({
    liff: makeLiff({
      isLoggedIn() { return false; },
      login() { loginCount += 1; },
      getIDToken() { tokenCount += 1; return TOKEN; },
    }),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return jsonResponse({ ok: true, authenticated: true });
    }),
  });
  assert.equal(result.status, auth.AUTH_STATES.UNAUTHENTICATED);
  assert.equal(result.reason, "liff_unavailable");
  assert.equal(loginCount, 1);
  assert.equal(tokenCount, 0);
  assert.equal(fetchCount, 0);
});

test("IDトークンがnullならfetchしない", async () => {
  let fetchCount = 0;
  const result = await auth.startStagingLineAuthCheck({
    liff: makeLiff({ getIDToken() { return null; } }),
    liffId: "test-liff-id",
    dependencies: fetchDependencies(async () => {
      fetchCount += 1;
      return jsonResponse({ ok: true, authenticated: true });
    }),
  });
  assert.equal(result.status, auth.AUTH_STATES.UNAUTHENTICATED);
  assert.equal(fetchCount, 0);
});

test("認証リクエストはstaging /auth/sessionへ安全な指定で送る", async () => {
  let capturedUrl;
  let capturedOptions;
  const result = await auth.verifyLineSession_(TOKEN, fetchDependencies(async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return jsonResponse({ ok: true, authenticated: true });
  }));

  assert.deepEqual(result, { ok: true, authenticated: true });
  assert.equal(capturedUrl, `${auth.STAGING_WORKER_BASE_URL}/auth/session`);
  assert.equal(capturedOptions.method, "GET");
  assert.equal(capturedOptions.mode, "cors");
  assert.equal(capturedOptions.cache, "no-store");
  assert.equal(capturedOptions.credentials, "omit");
  assert.equal(capturedOptions.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(new URL(capturedUrl).search, "");
  assert.ok(capturedOptions.signal);
});

test("正常JSON以外を成功扱いしない", async (t) => {
  await t.test("200でもJSON解析失敗", async () => {
    await assert.rejects(
      auth.verifyLineSession_(TOKEN, fetchDependencies(async () =>
        jsonResponse(new SyntaxError("bad json")))),
      (error) => error.type === auth.AUTH_STATES.TEMPORARY_ERROR,
    );
  });
  await t.test("200でもauthenticated=false", async () => {
    await assert.rejects(
      auth.verifyLineSession_(TOKEN, fetchDependencies(async () =>
        jsonResponse({ ok: true, authenticated: false }))),
      (error) => error.type === auth.AUTH_STATES.UNAUTHENTICATED,
    );
  });
  await t.test("JSONでない200", async () => {
    await assert.rejects(
      auth.verifyLineSession_(TOKEN, fetchDependencies(async () =>
        jsonResponse({}, 200, "text/html"))),
      (error) => error.type === auth.AUTH_STATES.TEMPORARY_ERROR,
    );
  });
});

test("HTTPエラーを安全な状態へ分類する", async (t) => {
  for (const [status, expected] of [
    [401, auth.AUTH_STATES.UNAUTHENTICATED],
    [502, auth.AUTH_STATES.TEMPORARY_ERROR],
    [503, auth.AUTH_STATES.TEMPORARY_ERROR],
  ]) {
    await t.test(String(status), async () => {
      await assert.rejects(
        auth.verifyLineSession_(TOKEN, fetchDependencies(async () =>
          jsonResponse({ ok: false, error: "safe_code" }, status))),
        (error) => error.type === expected && error.status === status,
      );
    });
  }
});

test("通信例外とtimeoutをnetwork_errorに分類する", async (t) => {
  await t.test("通信例外", async () => {
    await assert.rejects(
      auth.verifyLineSession_(TOKEN, fetchDependencies(async () => {
        throw new TypeError("network failed");
      })),
      (error) => error.type === auth.AUTH_STATES.NETWORK_ERROR &&
        error.code === "authentication_network_error",
    );
  });
  await t.test("timeout", async () => {
    const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    await assert.rejects(
      auth.verifyLineSession_(TOKEN, fetchDependencies(fetchImpl, { timeoutMs: 5 })),
      (error) => error.type === auth.AUTH_STATES.NETWORK_ERROR &&
        error.code === "authentication_timeout",
    );
  });
});

test("画面文言は原因別で、機密情報を含まない", () => {
  const loading = auth.getAuthUiCopy(auth.AUTH_STATES.LOADING);
  const success = auth.getAuthUiCopy(auth.AUTH_STATES.AUTHENTICATED);
  const liffFailure = auth.getAuthUiCopy(auth.AUTH_STATES.UNAUTHENTICATED, "liff_unavailable");
  const worker401 = auth.getAuthUiCopy(auth.AUTH_STATES.UNAUTHENTICATED, "worker_unauthorized");
  const temporary = auth.getAuthUiCopy(auth.AUTH_STATES.TEMPORARY_ERROR);
  const network = auth.getAuthUiCopy(auth.AUTH_STATES.NETWORK_ERROR);

  assert.match(loading.title, /確認しています/);
  assert.match(success.title, /成功しました/);
  assert.match(success.message, /次の準備/);
  assert.match(liffFailure.title, /認証情報を取得できません/);
  assert.match(worker401.title, /本人認証に失敗/);
  assert.match(temporary.title, /一時的に接続できません/);
  assert.match(network.title, /認証サーバーへ接続できません/);
  const allCopy = JSON.stringify({ loading, success, liffFailure, worker401, temporary, network });
  assert.doesNotMatch(allCopy, new RegExp(TOKEN.replaceAll(".", "\\.")));
  assert.doesNotMatch(allCopy, /lineUserId|\bsub\b|channel.?id/i);
});

