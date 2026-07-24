"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const authSource = fs.readFileSync(path.join(root, "auth-session.js"), "utf8");
const envSource = fs.readFileSync(path.join(root, "env-config.js"), "utf8");

test("staging Workerだけを接続先にする", () => {
  const staging = /https:\/\/taiko-worker-plain-staging\.fujizukadaiko\.workers\.dev/;
  const production = /https:\/\/taiko-worker-plain\.fujizukadaiko\.workers\.dev/;
  assert.match(envSource, staging);
  assert.doesNotMatch(html, staging);
  assert.doesNotMatch(authSource, staging);
  assert.doesNotMatch(envSource, production);
  assert.doesNotMatch(html, production);
  assert.doesNotMatch(authSource, production);
});

test("環境設定は認証モジュールより先に読み込み、接続先を引数注入する", () => {
  const envScript = html.indexOf('<script src="./env-config.js"></script>');
  const authScript = html.indexOf('<script src="./auth-session.js"></script>');
  assert.ok(envScript >= 0 && authScript > envScript);
  assert.match(html, /workerBaseUrl:\s*D1_BASE/);
  assert.match(authSource, /dependencies\?\.workerBaseUrl/);
  assert.match(authSource, /invalid_worker_base_url/);
});

test("staging表示とhostname不一致時のfail closedを維持する", () => {
  assert.match(html, /<title>\[STAGING\] 藤塚太鼓 出欠・予定<\/title>/);
  assert.match(html, /id="environmentBanner"[^>]*>[\s\S]*STAGING／テスト環境/);
  assert.match(html, /class="saveEnvironmentNotice"[\s\S]*本番データには反映されません/);
  assert.match(html, /if \(!APP_STARTUP_ALLOWED\) \{\s*renderEnvironmentConfigFailure_\(\);\s*return;/);
  assert.match(html, /resolveRuntimeConfig\(window\.location\)/);
  assert.match(envSource, /showEnvironmentBanner:\s*true/);
  assert.match(envSource, /page_hostname_mismatch/);
});

test("本人認証済み読み取り専用モードは従来初期化へ進まない", () => {
  assert.match(html, /const STAGING_PRODUCTION_UI_SHELL = true;/);
  assert.match(html, /const STAGING_AUTHENTICATED_READ_ONLY = true;/);
  assert.match(html, /const STAGING_ATTENDANCE_DRAFT_PREVIEW_ONLY = true;/);
  assert.doesNotMatch(html, /STAGING_AUTH_CHECK_ONLY/);
  assert.match(
    html,
    /if \(!STAGING_PRODUCTION_UI_SHELL \|\| !STAGING_AUTHENTICATED_READ_ONLY\) \{\s*renderEnvironmentConfigFailure_\(\);\s*return;\s*\}\s*await initStagingAuthenticatedReadOnly_\(\);\s*return;/,
  );
  const mainInit = html.indexOf("async function init(){", html.indexOf("function initStagingAuthenticatedReadOnly_"));
  const guard = html.indexOf("if (!STAGING_PRODUCTION_UI_SHELL || !STAGING_AUTHENTICATED_READ_ONLY)", mainInit);
  const safeStart = html.indexOf("await initStagingAuthenticatedReadOnly_();", guard);
  const safeReturn = html.indexOf("return;", safeStart);
  const legacyRefresh = html.indexOf("await refreshData();", safeReturn);
  assert.ok(mainInit >= 0 && guard > mainInit && legacyRefresh > guard);
  assert.ok(safeStart > guard && safeReturn > safeStart && legacyRefresh > safeReturn);
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

test("production相当shellは安全な認証済み機能だけを表示する", () => {
  assert.match(html, /<script src="\.\/auth-session\.js"><\/script>/);
  assert.match(html, /id="stagingHomeActions"[^>]*class="homeActions"[^>]*data-staging-shell="safe"/);
  assert.match(html, /id="authSessionCard"/);
  assert.match(html, /id="authSessionTitle"/);
  assert.match(html, /id="authSessionMessage"/);
  assert.match(html, /id="readOnlyScheduleSection"/);
  assert.match(html, /id="readOnlyScheduleList"/);
  assert.match(html, /getReadOnlyUiCopy/);
  assert.match(html, /renderReadOnlySchedules_/);
  assert.match(html, /element\.hidden = element\.dataset\.stagingShell !== "safe"/);
  assert.doesNotMatch(html, /element\.hidden = element !== card/);
  assert.match(html, /configureStagingProductionShell_\(status\)/);
  assert.match(html, /registered \? "出欠を確認・回答" : "現在利用できません"/);
  assert.match(html, /id="stagingUnavailableFeatures"/);
  assert.match(html, /安全な認証・保存APIの準備が完了するまで、旧システムには接続しません/);
  assert.match(html, /feedback\.setAttribute\("hidden", ""\)/);
  assert.match(html, /#feedbackFab\.fab\[hidden\]\s*\{\s*display: none !important;/);
  assert.match(html, /feedback\.style\.display = "none"/);
});

test("安全未対応のホーム操作は旧画面への遷移属性を持たない", () => {
  const openingTag = (id) => {
    const match = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(match, `${id} が必要`);
    return match[0];
  };

  const primary = openingTag("btnPrimary");
  const schedules = openingTag("btnSchedules");
  const editNames = openingTag("btnEditNames");

  assert.doesNotMatch(primary, /data-view-target/);
  assert.doesNotMatch(schedules, /data-view-target/);
  assert.doesNotMatch(editNames, /data-view-target/);
  assert.match(schedules, /\bdisabled\b/);
  assert.match(editNames, /\bdisabled\b/);
  assert.match(html, /予定表（準備中）/);
  assert.match(html, /登録氏名の変更（準備中）/);
});

test("安全shell以外のviewは表示対象から除外する", () => {
  const start = html.indexOf("function configureStagingProductionShell_");
  const end = html.indexOf("\n    function renderStagingReadOnlyState_", start);
  const shell = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(shell, /view\.id !== "view-home"/);
  assert.match(shell, /view\.classList\.remove\("show"\)/);
  assert.match(shell, /view\.hidden = true/);
  assert.match(shell, /schedules\.disabled = true/);
  assert.match(shell, /editNames\.disabled = true/);
  assert.doesNotMatch(shell, /API_ENDPOINT|fetch\(|getDecodedIDToken|lineId|memberId|no-cors/);
});

test("draft preview以外の書き込みUI・submit・未エスケープinnerHTMLを使わない", () => {
  const start = authSource.indexOf("function renderReadOnlySchedules_");
  const end = authSource.indexOf("\n  function getAuthUiCopy", start);
  assert.ok(start >= 0 && end > start);
  const renderer = authSource.slice(start, end);
  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(renderer, /createElement\(["'](?:select|textarea|form)["']\)/i);
  assert.doesNotMatch(renderer, /addEventListener\(["']submit["']/i);
  assert.match(renderer, /radio\.type = "radio"/);
  assert.match(renderer, /reset\.type = "button"/);
  assert.match(renderer, /enableDraftPreview/);
  assert.match(renderer, /textContent/);
});

test("通常読み取りフローは許可された2 APIだけを使用し書き込みへ進まない", () => {
  const start = authSource.indexOf("async function startStagingAuthenticatedReadOnly");
  const end = authSource.indexOf("\n  return {", start);
  const flow = authSource.slice(start, end);
  assert.doesNotMatch(flow, /attendance\/submit|\/line\/schedules|events\/by-date/);
  assert.doesNotMatch(flow, /admin|feedback|API_ENDPOINT/);
  assert.doesNotMatch(flow, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(flow, /submit-authenticated/);
  assert.match(authSource, /"\/line\/attendance\/submit-authenticated"/);
});

test("attendanceWriteは読み取り専用表示にだけ使用する", () => {
  assert.match(authSource, /validateAttendanceWrite_/);
  assert.match(authSource, /eventAllowedCount/);
  assert.match(authSource, /performerAllowedEventCount/);
  assert.match(authSource, /予定の回答可否/);
  assert.match(authSource, /回答可否:/);
  assert.doesNotMatch(authSource, /createElement\(["'](?:select|textarea|form)["']\)/i);
  assert.doesNotMatch(authSource, /addEventListener\(["']submit["']/i);
});

test("draft previewは認証済み予定単位保存だけを追加しlegacy経路を持たない", () => {
  assert.match(authSource, /buildAuthenticatedAttendanceDraftPayloads_/);
  assert.match(authSource, /createAttendanceDraftState_/);
  assert.match(authSource, /変更を取り消す/);
  assert.match(html, /const STAGING_AUTHENTICATED_ATTENDANCE_SUBMIT_UI = true;/);
  assert.match(html, /回答可能な予定は保存操作を試せます/);
  assert.match(html, /「変更を保存しました。」と表示された回答だけがサーバーへ反映されています/);
  assert.match(authSource, /submit-authenticated/);
  assert.doesNotMatch(authSource, /"\/line\/attendance\/submit"/);
  assert.doesNotMatch(authSource, /XMLHttpRequest|sendBeacon/);
  assert.doesNotMatch(authSource, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(authSource, /beforeunload|visibilitychange|pagehide/);
  assert.doesNotMatch(authSource, /console\.(?:log|info|warn|error)/);
});

test("draft DOMは安全な連番を使いidentityをdata属性へ保存しない", () => {
  const start = authSource.indexOf("function renderReadOnlySchedules_");
  const end = authSource.indexOf("\n  function getAuthUiCopy", start);
  const renderer = authSource.slice(start, end);
  assert.match(renderer, /attendance-draft-\$\{eventIndex\}-\$\{performerIndex\}/);
  assert.doesNotMatch(renderer, /dataset|setAttribute\(["']data-/);
  assert.doesNotMatch(renderer, /radio\.(?:id|name)\s*=.*eventKey|radio\.(?:id|name)\s*=.*performerName/);
  assert.match(renderer, /createElement\("fieldset"\)/);
  assert.match(renderer, /createElement\("legend"\)/);
  assert.match(renderer, /label\.setAttribute\("for", radioId\)/);
});

test("index.htmlのインラインJavaScriptが構文上有効", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(match[1]), `inline script ${index + 1}`);
  }
});
