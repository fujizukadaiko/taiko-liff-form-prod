"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const authSource = fs.readFileSync(path.join(root, "auth-session.js"), "utf8");

test("staging Workerだけを接続先にする", () => {
  const staging = /https:\/\/taiko-worker-plain-staging\.fujizukadaiko\.workers\.dev/;
  const production = /https:\/\/taiko-worker-plain\.fujizukadaiko\.workers\.dev/;
  assert.match(html, staging);
  assert.match(authSource, staging);
  assert.doesNotMatch(html, production);
  assert.doesNotMatch(authSource, production);
});

test("本人認証済み読み取り専用モードは従来初期化へ進まない", () => {
  assert.match(html, /const STAGING_AUTHENTICATED_READ_ONLY = true;/);
  assert.doesNotMatch(html, /STAGING_AUTH_CHECK_ONLY/);
  assert.match(html, /if \(STAGING_AUTHENTICATED_READ_ONLY\) \{\s*await initStagingAuthenticatedReadOnly_\(\);\s*return;\s*\}/);
  const mainInit = html.indexOf("async function init(){", html.indexOf("function initStagingAuthenticatedReadOnly_"));
  const guard = html.indexOf("if (STAGING_AUTHENTICATED_READ_ONLY)", mainInit);
  const legacyRefresh = html.indexOf("await refreshData();", guard);
  assert.ok(mainInit >= 0 && guard > mainInit && legacyRefresh > guard);
  assert.ok(
    (html.match(/if \(STAGING_AUTHENTICATED_READ_ONLY\) return;/g) || []).length >= 5,
    "独立した予定・通知・feedback初期化にもread-onlyガードが必要",
  );
  assert.match(html, /if \(!STAGING_AUTHENTICATED_READ_ONLY\) \{\s*bindAdminAutoDeadlineOnce\(\)/);
});

test("通常起動はhome-summaryから始まり/auth/sessionを重複しない", () => {
  const start = authSource.indexOf("async function startStagingAuthenticatedReadOnly");
  const end = authSource.indexOf("\n  return {", start);
  const readOnlyFlow = authSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(readOnlyFlow, /fetchHomeSummary_/);
  assert.match(readOnlyFlow, /fetchAttendanceSummary_/);
  assert.doesNotMatch(readOnlyFlow, /verifyLineSession_|\/auth\/session/);

  assert.match(authSource, /"\/line\/home-summary"/);
  assert.match(authSource, /"\/line\/attendance\/all"/);
  assert.match(authSource, /body: "\{\}"/);
  assert.doesNotMatch(authSource, /lineId|line_id|lineUserId|memberId|memberIds/);
});

test("新しい認証通信はTokenを永続化・記録せずno-corsを使わない", () => {
  assert.doesNotMatch(authSource, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(authSource, /console\.(?:log|info|warn|error)|no-cors/);
  assert.doesNotMatch(authSource, /getDecodedIDToken/);
  assert.match(authSource, /liff\.getIDToken\(\)/);
  assert.match(authSource, /mode: "cors"/);
  assert.match(authSource, /cache: "no-store"/);
  assert.match(authSource, /credentials: "omit"/);
});

test("読み取り専用UIは従来画面とfeedbackを隠す", () => {
  assert.match(html, /<script src="\.\/auth-session\.js"><\/script>/);
  assert.match(html, /id="authSessionCard"/);
  assert.match(html, /id="authSessionTitle"/);
  assert.match(html, /id="authSessionMessage"/);
  assert.match(html, /id="readOnlyScheduleSection"/);
  assert.match(html, /id="readOnlyScheduleList"/);
  assert.match(html, /getReadOnlyUiCopy/);
  assert.match(html, /renderReadOnlySchedules_/);
  assert.match(html, /element\.hidden = element !== card/);
  assert.match(html, /getElementById\("feedbackFab"\).*setAttribute\("hidden"/);
  assert.match(html, /本人認証済み・読み取り専用/);
});

test("読み取り専用カード描画は操作要素・submit・未エスケープinnerHTMLを使わない", () => {
  const start = authSource.indexOf("function renderReadOnlySchedules_");
  const end = authSource.indexOf("\n  function getAuthUiCopy", start);
  assert.ok(start >= 0 && end > start);
  const renderer = authSource.slice(start, end);
  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(renderer, /createElement\(["'](?:input|select|textarea|button|form)["']\)/i);
  assert.doesNotMatch(renderer, /addEventListener\(["']submit["']/i);
  assert.match(renderer, /textContent/);
});

test("通常読み取りフローは許可された2 APIだけを使用し書き込みへ進まない", () => {
  const start = authSource.indexOf("async function startStagingAuthenticatedReadOnly");
  const end = authSource.indexOf("\n  return {", start);
  const flow = authSource.slice(start, end);
  assert.doesNotMatch(flow, /attendance\/submit|\/line\/schedules|events\/by-date/);
  assert.doesNotMatch(flow, /admin|feedback|API_ENDPOINT/);
  assert.doesNotMatch(flow, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(authSource, /submit-authenticated/);
});

test("attendanceWriteは読み取り専用表示にだけ使用する", () => {
  assert.match(authSource, /validateAttendanceWrite_/);
  assert.match(authSource, /eventAllowedCount/);
  assert.match(authSource, /performerAllowedEventCount/);
  assert.match(authSource, /予定の回答可否/);
  assert.match(authSource, /回答可否:/);
  assert.doesNotMatch(authSource, /createElement\(["'](?:input|select|textarea|button|form)["']\)/i);
  assert.doesNotMatch(authSource, /addEventListener\(["']submit["']/i);
});

test("index.htmlのインラインJavaScriptが構文上有効", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(match[1]), `inline script ${index + 1}`);
  }
});
