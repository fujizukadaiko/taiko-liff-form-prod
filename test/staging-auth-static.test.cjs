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
  const end = authSource.indexOf("\n  const FEEDBACK_CATEGORIES", start);
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
  assert.match(html, /configureStagingProductionShell_\(effectiveStatus, snapshot\)/);
  assert.match(html, /unregistered[\s\S]*"初回登録"[\s\S]*viewerOnly[\s\S]*"登録情報を変更"[\s\S]*"出欠を確認・回答"/);
  assert.doesNotMatch(html, /id="stagingUnavailableFeatures"/);
  assert.doesNotMatch(html, /id="stagingAdminAccessCard"/);
  assert.doesNotMatch(html, /管理者認証済み/);
  assert.doesNotMatch(html, /現在利用できない機能/);
  assert.match(html, /snapshot\.adminAccess\.authorized === true/);
  assert.match(
    html,
    /effectiveStatus === "registered_read_only" \? "none" : ""/,
  );
  assert.match(html, /#feedbackFab\.fab\[hidden\]\s*\{\s*display: none !important;/);
  assert.match(html, /feedback\.hidden = !registered/);
  assert.match(html, /feedback\.style\.display = registered \? "" : "none"/);
});

test("ホーム操作は旧画面への遷移属性を持たず安全経路で有効化する", () => {
  const openingTag = (id) => {
    const match = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(match, `${id} が必要`);
    return match[0];
  };

  const primary = openingTag("btnPrimary");
  const schedules = openingTag("btnSchedules");
  const editNames = openingTag("btnEditNames");
  const backFromForm = openingTag("btnBackFromForm");

  assert.doesNotMatch(primary, /data-view-target/);
  assert.doesNotMatch(schedules, /data-view-target/);
  assert.doesNotMatch(editNames, /data-view-target/);
  assert.doesNotMatch(backFromForm, /data-view-target/);
  assert.match(schedules, /\bdisabled\b/);
  assert.match(editNames, /\bdisabled\b/);
  assert.match(html, /<span class="homeSecondaryTitle">予定表<\/span>/);
  assert.match(html, /showStagingAuthenticatedView_\("view-schedules"\)/);
  assert.match(html, /renderStagingMemberSchedules_\(\)/);
  assert.match(html, /登録氏名の変更（準備中）/);
});

test("安全shellは認証済みの9 viewだけを切り替える", () => {
  const viewStart = html.indexOf("function showStagingAuthenticatedView_");
  const shellStart = html.indexOf("function configureStagingProductionShell_");
  const viewSwitch = html.slice(viewStart, shellStart);
  const shellEnd = html.indexOf("\n    function renderStagingReadOnlyState_", shellStart);
  const shell = html.slice(shellStart, shellEnd);
  assert.ok(viewStart >= 0 && shellStart > viewStart && shellEnd > shellStart);
  for (const viewId of [
    "view-home",
    "view-form",
    "view-schedules",
    "view-register",
    "view-admin",
    "view-admin-report",
    "view-admin-carpool",
    "view-custom-push",
    "view-feedback",
  ]) {
    assert.match(viewSwitch, new RegExp(`"${viewId}"`));
  }
  assert.match(viewSwitch, /const active = view\.id === viewId/);
  assert.match(viewSwitch, /view\.hidden = !active/);
  assert.match(viewSwitch, /view\.classList\.toggle\("show", active\)/);
  assert.match(shell, /showStagingAuthenticatedView_\("view-home"\)/);
  assert.match(shell, /showStagingAuthenticatedView_\("view-form"\)/);
  assert.match(shell, /querySelectorAll\("\.stagingLegacyFormControl"\)/);
  assert.match(shell, /element\.hidden = true/);
  assert.match(shell, /const available = registered \|\| unregistered/);
  assert.match(shell, /schedules\.disabled = !available/);
  assert.match(shell, /editNames\.disabled = !registered/);
  assert.doesNotMatch(
    `${viewSwitch}\n${shell}`,
    /API_ENDPOINT|fetch\(|getDecodedIDToken|lineId|memberId|no-cors|show\("#view-/,
  );
  assert.match(viewSwitch, /submitAuthenticatedMemberProfile_/);
  assert.match(viewSwitch, /classifyMemberSubmitError_/);
  assert.match(viewSwitch, /memberSubmitMessage_/);
  assert.match(viewSwitch, /自動再送はしていません/);
});

test("管理者メニューは安全な認証済み機能だけを有効にしサマリを廃止する", () => {
  assert.match(
    html,
    /id="adminMenu"[\s\S]*data-staging-shell="safe"[\s\S]*hidden/,
  );
  assert.match(html, /id="view-admin"[^>]*data-view[^>]*hidden/);
  assert.match(html, /id="view-admin-legacy"[^>]*data-view/);
  assert.match(html, /予定登録\/編集/);
  for (const id of ["btnAdminCustomPush", "btnFeedback"]) {
    const openingTag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(openingTag, `${id} が必要`);
    assert.doesNotMatch(openingTag[0], /\bdisabled\b/);
    assert.doesNotMatch(openingTag[0], /data-view-target/);
  }
  assert.doesNotMatch(html, /id="btnSummary"/);
  assert.doesNotMatch(html, /id="view-summary"/);
  const scheduleButton = html.match(
    /<button[^>]*id="btnAdminMenuSchedules"[^>]*>/,
  );
  assert.ok(scheduleButton);
  assert.doesNotMatch(scheduleButton[0], /data-view-target/);
  const reportButton = html.match(
    /<button[^>]*id="btnAdminMenuReport"[^>]*>/,
  );
  assert.ok(reportButton);
  assert.doesNotMatch(reportButton[0], /\bdisabled\b/);
  assert.doesNotMatch(reportButton[0], /data-view-target/);
  const carpoolButton = html.match(
    /<button[^>]*id="btnAdminCarpool"[^>]*>/,
  );
  assert.ok(carpoolButton);
  assert.doesNotMatch(carpoolButton[0], /\bdisabled\b/);
  assert.doesNotMatch(carpoolButton[0], /data-view-target/);
  assert.match(html, />\s*出欠結果一覧\s*</);
  assert.match(html, /startAuthenticatedAdminSchedules/);
  assert.match(html, /submitAuthenticatedAdminSchedule_/);
  assert.match(html, /classifyAdminScheduleSubmitError_/);
  assert.match(html, /expectedUpdatedAt/);
  assert.match(html, /自動再送しません/);
  assert.match(html, /削除はまだ利用できません/);
  assert.match(html, /showStagingAuthenticatedView_\("view-admin"\)/);
  assert.match(html, /showStagingAuthenticatedView_\("view-admin-report"\)/);
  assert.match(html, /showStagingAuthenticatedView_\("view-custom-push"\)/);
  assert.match(html, /showStagingAuthenticatedView_\("view-feedback"\)/);
  assert.match(
    html,
    /adult: "大人"[\s\S]*child: "子ども"[\s\S]*both: "両方"/,
  );
  assert.match(html, /active: "有効"[\s\S]*inactive: "無効"/);
  assert.doesNotMatch(
    html.slice(
      html.indexOf("async function loadStagingAdminSchedules_"),
      html.indexOf("function clearAuthenticatedProductionHome_"),
    ),
    /API_ENDPOINT|no-cors|lineId|memberId|adminListFetch|show\("#view-admin"\)/,
  );
});

test("安全な予定登録画面はproductionの画面構造と操作順を再利用する", () => {
  const start = html.indexOf('<section id="view-admin"');
  const end = html.indexOf('<section id="view-admin-legacy"', start);
  const safeAdmin = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  for (const contract of [
    /予定登録（管理者）/,
    /class="card fEvent" id="adminSafeListAcc"/,
    /class="fHead"[\s\S]*タップで開閉/,
    /class="adminControls"/,
    /class="selectBtn schedSel short"/,
    /class="adminGrid"/,
    /種別 \*/,
    /対象区分 \*/,
    /タイトル \*/,
    /日付 \*/,
    /集合時間（発表・その他のみ）/,
    /出欠対象（発表のみ）/,
    /配信フラグ（必須：発表のみ）/,
    /新規モードに戻す/,
  ]) {
    assert.match(safeAdmin, contract);
  }
  assert.match(safeAdmin, /STAGING／テスト環境/);
  assert.match(safeAdmin, /自動再送しません/);
  assert.doesNotMatch(safeAdmin, /id="ad_|API_ENDPOINT|lineId|memberId|no-cors/);

  const renderStart = html.indexOf("function renderStagingAdminSchedules_");
  const renderEnd = html.indexOf(
    "async function loadStagingAdminSchedules_",
    renderStart,
  );
  const render = html.slice(renderStart, renderEnd);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(render, /card adminSafeScheduleCard/);
  assert.match(render, /btn btn-ghost btn-sm btn-compact btn-edit/);
  assert.match(render, /出欠対象:/);
  assert.match(render, /期限:/);
  assert.doesNotMatch(render, /createElement\("details"\)|innerHTML/);

  const rulesStart = html.indexOf("function updateAdminSafeFormRules_");
  const rulesEnd = html.indexOf("function resetAdminSafeForm_", rulesStart);
  const rules = html.slice(rulesStart, rulesEnd);
  assert.ok(rulesStart >= 0 && rulesEnd > rulesStart);
  assert.match(rules, /attendance\.dataset\.touched !== "1"/);
  assert.match(rules, /attendance\.value = "Y"/);
  assert.match(rules, /deadline\.disabled = false/);
  assert.match(rules, /autoAdminSafeDeadline_\(\)/);
});

test("旧カスタム通知とFeedbackのclick listenerは全環境で起動しない", () => {
  assert.match(
    html,
    /カスタム一斉通知：送信UI[\s\S]{0,240}\(function\(\)\{\s*[\s\S]{0,160}?return;/,
  );
  assert.match(
    html,
    /フィードバック一覧ビュー（管理）[\s\S]{0,240}\(function \(\) \{\s*[\s\S]{0,180}?return;/,
  );
  assert.match(
    html,
    /「変更を保存」ボタンでまとめて更新[\s\S]{0,240}\(function \(\) \{\s*[\s\S]{0,180}?return;/,
  );
});

test("カスタム通知とご意見BOXは認証モジュールだけへ接続し結果不明を自動再送しない", () => {
  const start = html.indexOf("function stagingAuthenticatedApiOptions_");
  const end = html.indexOf("function bindStagingAdminSafe_", start);
  const flow = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  for (const method of [
    "previewAuthenticatedCustomNotification_",
    "submitAuthenticatedCustomNotification_",
    "submitAuthenticatedFeedback_",
    "loadAuthenticatedAdminFeedback_",
    "updateAuthenticatedAdminFeedbackStatus_",
  ]) {
    assert.match(flow, new RegExp(method));
    assert.match(authSource, new RegExp(method));
  }
  assert.match(flow, /送信待ちへ登録しました。実送信結果とは異なります/);
  assert.match(flow, /自動再送はしません/);
  assert.match(flow, /自動再送はしていません/);
  assert.match(flow, /createElement/);
  assert.match(flow, /textContent/);
  assert.doesNotMatch(
    flow,
    /API_ENDPOINT|GAS_ENDPOINT|D1_ORIGIN|no-cors|getDecodedIDToken|lineId|memberId|extraLineIds|senderLineId|fetch\(|innerHTML|localStorage|sessionStorage/,
  );
  assert.match(envSource, /frontVersion:\s*"Front v7\.1\.0"/);
});

test("配車補助は認証済みAPIと安全なDOMだけを使い入力を画面内に保持する", () => {
  const start = html.indexOf("function resetStagingAdminCarpool_");
  const end = html.indexOf("function bindStagingAdminSafe_", start);
  const flow = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(flow, /startAuthenticatedAdminAttendanceReport/);
  assert.match(flow, /loadAuthenticatedAdminCarpool/);
  assert.match(flow, /state\.authenticatedAdminCarpoolEvents/);
  assert.match(flow, /state\.authenticatedAdminCarpool/);
  assert.match(flow, /candidate\.displayName/);
  assert.match(flow, /candidate\.participantNames/);
  assert.match(flow, /candidate\.comment/);
  assert.match(flow, /createElement/);
  assert.match(flow, /textContent/);
  assert.match(flow, /自動再試行はしていません/);
  assert.doesNotMatch(
    flow,
    /API_ENDPOINT|D1_ORIGIN|no-cors|lineId|memberId|getDecodedIDToken|innerHTML|initCarpoolPage|loadCarpoolDetail|localStorage|sessionStorage|fetch\(/,
  );

  const backButton = html.match(
    /<button[^>]*id="btnCarpoolBack"[^>]*>/,
  );
  assert.ok(backButton);
  assert.doesNotMatch(backButton[0], /data-view-target/);
  assert.match(html, /保存はせず、この画面上で計算します/);
  assert.match(authSource, /\/line\/admin\/carpool-authenticated/);
  assert.doesNotMatch(
    authSource,
    /\/line\/attendance\/report(?:["'`?])/,
  );
});

test("管理者向け出欠結果は認証済みAPIだけで取得し安全なDOM操作で描画する", () => {
  const flow = html.slice(
    html.indexOf("function adminReportBadgeClass_"),
    html.indexOf("function bindStagingAdminSafe_"),
  );
  assert.ok(flow.length > 0);
  assert.match(flow, /startAuthenticatedAdminAttendanceReport/);
  assert.match(flow, /loadAuthenticatedAdminAttendanceReport/);
  assert.match(flow, /state\.authenticatedAdminReportEvents/);
  assert.match(flow, /state\.authenticatedAdminReport/);
  assert.match(flow, /row\.displayName/);
  assert.match(flow, /row\.comment/);
  assert.match(flow, /event\.accepting/);
  assert.match(flow, /textContent/);
  assert.match(flow, /createElement/);
  assert.match(flow, /自動再試行はしていません/);
  assert.doesNotMatch(
    flow,
    /API_ENDPOINT|no-cors|lineId|memberId|getDecodedIDToken|renderReport|reportReload|innerHTML|show\("#view-admin-report"\)/,
  );

  const backButton = html.match(
    /<button[^>]*id="btnReportBack"[^>]*>/,
  );
  assert.ok(backButton);
  assert.doesNotMatch(backButton[0], /data-view-target/);
  assert.doesNotMatch(
    authSource,
    /\/line\/admin\/attendance-report(?:["'`?])/,
  );
  assert.match(
    authSource,
    /\/line\/admin\/attendance-report-authenticated/,
  );
});

test("会員保存の再取得確認後にホームで成功結果を表示する", () => {
  const submitStart = html.indexOf("async function submitStagingMemberForm_");
  const submitEnd = html.indexOf("\n    function bindStagingMemberForm_", submitStart);
  const submitFlow = html.slice(submitStart, submitEnd);
  const confirmation = submitFlow.indexOf(
    "await initStagingAuthenticatedReadOnly_();",
  );
  const snackbar = submitFlow.indexOf(
    "window.showSnackbar(successMessage",
  );

  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  assert.match(
    submitFlow,
    /const successMessage = registerMode === "create"[\s\S]*"初回登録が完了しました。"[\s\S]*"登録情報を保存しました。"/,
  );
  assert.ok(
    confirmation >= 0 && snackbar > confirmation,
    "保存後の再取得・一致確認が完了してから成功表示する必要がある",
  );
  assert.match(
    submitFlow,
    /window\.showSnackbar\(successMessage,\s*\{\s*variant: "success",\s*duration: 5000/,
  );
});

test("認証済みhome-summaryとattendanceをproductionホームDOMへ接続する", () => {
  assert.match(
    html,
    /id="cardEventsActive"[^>]*data-staging-shell="safe"[^>]*hidden/,
  );
  assert.match(html, /回答受付中の公演/);
  assert.match(html, /id="homeOnlyNALabel"/);
  assert.doesNotMatch(html, /id="homeOnlyNALabel"[^>]*hidden/);
  assert.match(html, /buildProductionHomeViewModel_\(\s*snapshot\.viewModel/);
  assert.match(html, /formatCompactYmdForProduction_/);
  assert.match(html, /row\.summary\.className/);
  assert.match(html, /state\.authenticatedProductionHome = productionHome/);
  assert.match(
    html,
    /primary\.setAttribute\(\s*"aria-controls",\s*unregistered \|\| viewerOnly \? "view-register" : "view-form"/,
  );

  const formView = html.indexOf('<section id="view-form" data-view>');
  const authenticatedSchedule = html.indexOf('id="readOnlyScheduleSection"');
  assert.ok(formView >= 0 && authenticatedSchedule > formView);
  assert.match(html, /class="[^"]*stagingLegacyFormControl[^"]*"[^>]*hidden/);
});

test("実LIFF回帰指摘のproduction同等表示を安全経路で反映する", () => {
  const scheduleStart = html.indexOf(
    "function appendMemberScheduleCard_",
  );
  const scheduleEnd = html.indexOf(
    "\n    function addStagingMemberPerformerField_",
    scheduleStart,
  );
  const schedules = html.slice(scheduleStart, scheduleEnd);
  assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart);
  assert.match(schedules, /snapshot\.viewModel\.schedules/);
  assert.match(schedules, /scheduleCard/);
  assert.match(schedules, /scDateCol/);
  assert.match(schedules, /scTitleBtn/);
  assert.match(schedules, /scPanel/);
  assert.match(schedules, /callTime/);
  assert.match(schedules, /callPlace/);
  assert.match(schedules, /schedule\.note/);
  assert.doesNotMatch(
    schedules,
    /fetch\(|\/line\/schedules|API_ENDPOINT|D1_ORIGIN|lineId|memberId|innerHTML/,
  );

  assert.match(html, /回答受付中の公演/);
  assert.match(html, /こんにちは、/);
  assert.match(html, /profile\.inputName/);
  assert.match(html, /status === "loading"[\s\S]*"読み込み中…"/);
  assert.doesNotMatch(
    html,
    /<span class="homePrimaryTitle">現在利用できません<\/span>/,
  );
  assert.match(
    html,
    /box\.className = "muted";\s*\/\/ productionではrepBox|productionではrepBox[\s\S]*box\.className = "muted"/,
  );

  const customStart = html.indexOf(
    "function customNotificationSelection_",
  );
  const customEnd = html.indexOf(
    "\n    function setFeedbackModalOpen_",
    customStart,
  );
  const custom = html.slice(customStart, customEnd);
  assert.match(custom, /schedule\.kind === "発表"/);
  assert.match(custom, /a\.date\.localeCompare\(b\.date\)/);
  assert.match(custom, /renderCustomNotificationManualSelection_/);
  assert.match(custom, /extra\.oninput/);
  assert.match(custom, /wrap\.classList\.toggle\("is-disabled", manual\)/);
  assert.match(custom, /input\.disabled = manual/);
  assert.match(custom, /lock\.hidden = !manual/);

  const feedbackStart = html.indexOf(
    "function renderAdminFeedbackSafe_",
  );
  const feedbackEnd = html.indexOf(
    "\n    async function loadAdminFeedbackSafe_",
    feedbackStart,
  );
  const feedback = html.slice(feedbackStart, feedbackEnd);
  assert.match(feedback, /number\.textContent = `#\$\{item\.no\}`/);
  assert.match(feedback, /list\.className = "fb-list"/);
  assert.match(feedback, /select\.className = `fb-status is-\$\{item\.status\}`/);
  assert.match(feedback, /formatDate\(item\.at\)/);
  assert.doesNotMatch(
    feedback,
    /innerHTML|lineId|memberId|fetch\(|localStorage|sessionStorage/,
  );
});

test("productionホームアダプターは旧renderer・業務ルール・通信へ依存しない", () => {
  const adapterStart = authSource.indexOf("function buildProductionHomeViewModel_");
  const rendererStart = authSource.indexOf("function renderProductionHome_", adapterStart);
  const rendererEnd = authSource.indexOf("\n  function draftKey_", rendererStart);
  assert.ok(adapterStart >= 0 && rendererStart > adapterStart && rendererEnd > rendererStart);
  const integration = authSource.slice(adapterStart, rendererEnd);
  assert.match(integration, /event\.eventWriteLabel !== EVENT_WRITE_LABELS\.get/);
  assert.match(integration, /performer\.attendanceWriteLabel !==/);
  assert.match(integration, /textContent/);
  assert.doesNotMatch(
    integration,
    /innerHTML|insertAdjacentHTML|outerHTML|fetch\(|API_ENDPOINT|HomeEventsUI|isPastDeadline|matchSeg|splitEventsForForm|onSubmit|addEventListener/,
  );
  assert.doesNotMatch(integration, /createElement\(["'](?:button|input|select|textarea|form)["']\)/i);
  assert.doesNotMatch(integration, /dataset|setAttribute\(["']data-/);
});

test("production形式の出欠UIは安全なDOMと予定単位buttonだけを使う", () => {
  const start = authSource.indexOf("function renderReadOnlySchedules_");
  const end = authSource.indexOf("\n  function getAuthUiCopy", start);
  assert.ok(start >= 0 && end > start);
  const renderer = authSource.slice(start, end);
  assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(renderer, /createElement\("select"\)/);
  assert.match(renderer, /createElement\("input"\)/);
  assert.doesNotMatch(renderer, /createElement\(["'](?:textarea|form)["']\)/i);
  assert.doesNotMatch(renderer, /addEventListener\(["']submit["']/i);
  assert.match(renderer, /toggle\.type = "button"/);
  assert.match(renderer, /submitButton\.type = "button"/);
  assert.match(renderer, /この予定の変更を保存/);
  assert.match(renderer, /コメント（任意・100文字まで）/);
  assert.match(renderer, /commentInput\.maxLength = MAX_ATTENDANCE_COMMENT_LENGTH/);
  assert.match(renderer, /enableDraftPreview/);
  assert.match(renderer, /textContent/);
  assert.match(
    html,
    /\.productionAttendanceReset\[hidden\],[\s\S]*\.attendanceSubmitButton\[hidden\],[\s\S]*\.productionAttendanceAccordionButton \.badge-unsaved\[hidden\]\s*\{[\s\S]*display:none !important;/,
  );
});

test("通常読み取りフローは許可された2 APIだけを使用し書き込みへ進まない", () => {
  const start = authSource.indexOf("async function startStagingAuthenticatedReadOnly");
  const end = authSource.indexOf("\n  const FEEDBACK_CATEGORIES", start);
  const flow = authSource.slice(start, end);
  assert.doesNotMatch(flow, /attendance\/submit|\/line\/schedules|events\/by-date/);
  assert.doesNotMatch(flow, /\/line\/admin|\/admin\/|feedback|API_ENDPOINT/);
  assert.match(flow, /adminAccess: home\.adminAccess/);
  assert.doesNotMatch(flow, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(flow, /submit-authenticated/);
  assert.match(authSource, /"\/line\/attendance\/submit-authenticated"/);
});

test("attendanceWriteだけを入力可否の根拠にする", () => {
  assert.match(authSource, /validateAttendanceWrite_/);
  assert.match(authSource, /eventAllowedCount/);
  assert.match(authSource, /performerAllowedEventCount/);
  assert.match(authSource, /EVENT_WRITE_LABELS/);
  assert.match(authSource, /PERFORMER_WRITE_LABELS/);
  assert.match(
    authSource,
    /event\.eventAllowed[\s\S]*event\.eventWriteReason === "open"[\s\S]*performer\.attendanceWriteAllowed[\s\S]*performer\.attendanceWriteReason === "open"/,
  );
  assert.doesNotMatch(authSource, /createElement\(["'](?:textarea|form)["']\)/i);
  assert.doesNotMatch(authSource, /addEventListener\(["']submit["']/i);
});

test("draft previewは認証済み予定単位保存だけを追加しlegacy経路を持たない", () => {
  assert.match(authSource, /buildAuthenticatedAttendanceDraftPayloads_/);
  assert.match(authSource, /createAttendanceDraftState_/);
  assert.match(authSource, /変更を取り消す/);
  assert.match(html, /const STAGING_AUTHENTICATED_ATTENDANCE_SUBMIT_UI = true;/);
  assert.match(html, /STAGING／テスト環境での保存です。本番データには反映されません/);
  assert.doesNotMatch(html, /保存は予定ごとに行います。ほかの予定の未保存内容は送信しません/);
  assert.doesNotMatch(html, /「変更を保存しました。」と表示された回答だけがサーバーへ反映されています/);
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
  assert.match(renderer, /attendance-select-\$\{eventIndex\}-\$\{performerIndex\}/);
  assert.match(renderer, /attendance-event-panel-\$\{eventIndex\}/);
  assert.doesNotMatch(renderer, /dataset|setAttribute\(["']data-/);
  assert.doesNotMatch(renderer, /select\.id\s*=.*eventKey|select\.id\s*=.*performerName/);
  assert.match(renderer, /createElement\("select"\)/);
  assert.match(renderer, /createElement\("option"\)/);
  assert.match(renderer, /name\.setAttribute\("for", selectId\)/);
});

test("index.htmlのインラインJavaScriptが構文上有効", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(match[1]), `inline script ${index + 1}`);
  }
});
