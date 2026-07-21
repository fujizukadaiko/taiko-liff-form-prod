"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const authSource = fs.readFileSync(path.join(root, "auth-session.js"), "utf8");

test("staging Workerだけを接続先にする", () => {
  assert.match(html, /https:\/\/taiko-worker-plain-staging\.fujizukadaiko\.workers\.dev/);
  assert.match(authSource, /https:\/\/taiko-worker-plain-staging\.fujizukadaiko\.workers\.dev/);
  assert.doesNotMatch(html, /https:\/\/taiko-worker-plain\.fujizukadaiko\.workers\.dev/);
  assert.doesNotMatch(authSource, /https:\/\/taiko-worker-plain\.fujizukadaiko\.workers\.dev/);
});

test("認証確認専用モードは既存初期化へ進まない", () => {
  assert.match(html, /const STAGING_AUTH_CHECK_ONLY = true;/);
  assert.match(html, /if \(STAGING_AUTH_CHECK_ONLY\) \{\s*await initStagingAuthCheck_\(\);\s*return;\s*\}/);
  const mainInit = html.indexOf("async function init(){", html.indexOf("function initStagingAuthCheck_"));
  const guard = html.indexOf("if (STAGING_AUTH_CHECK_ONLY)", mainInit);
  const legacyRefresh = html.indexOf("await refreshData();", guard);
  assert.ok(mainInit >= 0 && guard > mainInit && legacyRefresh > guard);
  assert.equal(
    (html.match(/if \(STAGING_AUTH_CHECK_ONLY\) return;/g) || []).length,
    3,
    "独立した自動取得処理にも認証専用ガードが必要",
  );
});

test("認証モジュールはTokenを永続化・記録せずno-corsを使わない", () => {
  assert.doesNotMatch(authSource, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(authSource, /console\.(?:log|info|warn|error)|no-cors/);
  assert.doesNotMatch(authSource, /getDecodedIDToken|lineId\s*[=:]/);
  assert.match(authSource, /liff\.getIDToken\(\)/);
});

test("認証UIと専用スクリプトが配置されている", () => {
  assert.match(html, /<script src="\.\/auth-session\.js"><\/script>/);
  assert.match(html, /id="authSessionCard"/);
  assert.match(html, /id="authSessionTitle"/);
  assert.match(html, /id="authSessionMessage"/);
  assert.match(html, /element\.hidden = element !== card/);
  assert.match(html, /getElementById\("feedbackFab"\).*setAttribute\("hidden"/);
});

test("index.htmlのインラインJavaScriptが構文上有効", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(match[1]), `inline script ${index + 1}`);
  }
});
