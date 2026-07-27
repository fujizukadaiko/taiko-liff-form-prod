const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(
  path.join(__dirname, "..", "index.html"),
  "utf8",
);

function sourceBetween(start, end) {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  return html.slice(startIndex, endIndex);
}

function makeElement(value = "") {
  return {
    value,
    disabled: false,
    dataset: {},
    options: [],
    appendChild(option) {
      this.options.push(option);
    },
    set textContent(value) {
      if (value === "") this.options = [];
    },
  };
}

function makeContext() {
  const elements = {
    adminSafeType: makeElement("発表"),
    adminSafeAttendance: makeElement("N"),
    adminSafePushFlag: makeElement("N"),
    adminSafeDeadline: makeElement(""),
    adminSafeCallTime: makeElement(""),
    adminSafeCallPlace: makeElement(""),
    adminSafeTime: makeElement(""),
    adminSafePlace: makeElement(""),
    adminSafeStatus: makeElement("active"),
    adminSafeTargetGroup: makeElement("子ども"),
    adminSafeDate: makeElement("2026-08-30"),
  };
  elements.adminSafeAttendance.dataset.touched = "0";
  elements.adminSafeDeadline.dataset.touched = "0";
  elements.adminSafeDeadline.dataset.autofilled = "0";
  elements.adminSafeTime.dataset.autofilled = "0";
  elements.adminSafePlace.dataset.autofilled = "0";

  const context = {
    document: {
      getElementById(id) {
        return elements[id] || null;
      },
      createElement() {
        return makeElement();
      },
    },
    state: { authenticatedAdminEdit: null },
  };
  vm.createContext(context);
  vm.runInContext(
    sourceBetween(
      "function autoAdminSafeDeadline_",
      "function resetAdminSafeForm_",
    ),
    context,
  );
  return { context, elements };
}

test("予定登録フォームはproductionと同じ種別別の初期値と無効化を行う", () => {
  const { context, elements } = makeContext();

  context.updateAdminSafeFormRules_();
  assert.equal(elements.adminSafeAttendance.value, "Y");
  assert.equal(elements.adminSafeAttendance.disabled, false);
  assert.equal(elements.adminSafeDeadline.value, "2026-08-23");
  assert.equal(elements.adminSafeDeadline.disabled, false);
  assert.deepEqual(
    Array.from(elements.adminSafePushFlag.options, (option) => option.value),
    ["N", "Y"],
  );
  assert.equal(elements.adminSafePushFlag.disabled, false);

  elements.adminSafeType.value = "練習";
  elements.adminSafeTargetGroup.value = "大人";
  context.updateAdminSafeFormRules_();
  assert.equal(elements.adminSafeAttendance.value, "N");
  assert.equal(elements.adminSafeAttendance.disabled, true);
  assert.equal(elements.adminSafeDeadline.value, "");
  assert.equal(elements.adminSafeDeadline.disabled, true);
  assert.equal(elements.adminSafeCallTime.disabled, true);
  assert.equal(elements.adminSafeCallPlace.disabled, true);
  assert.equal(elements.adminSafeTime.value, "17:30");
  assert.equal(elements.adminSafePlace.value, "藤塚小学校体育館");
  assert.deepEqual(
    Array.from(elements.adminSafePushFlag.options, (option) => option.value),
    ["N"],
  );
  assert.equal(elements.adminSafePushFlag.disabled, true);

  elements.adminSafeType.value = "その他";
  context.updateAdminSafeFormRules_();
  assert.equal(elements.adminSafeAttendance.value, "N");
  assert.equal(elements.adminSafeAttendance.disabled, true);
  assert.equal(elements.adminSafeDeadline.value, "2026-08-23");
  assert.equal(elements.adminSafeDeadline.disabled, false);
  assert.equal(elements.adminSafeCallTime.disabled, false);
  assert.equal(elements.adminSafeCallPlace.disabled, false);
  assert.equal(elements.adminSafeTime.value, "");
  assert.equal(elements.adminSafePlace.value, "");
});

test("手入力した出欠対象と締切はproduction同様に自動上書きしない", () => {
  const { context, elements } = makeContext();
  elements.adminSafeAttendance.value = "N";
  elements.adminSafeAttendance.dataset.touched = "1";
  elements.adminSafeDeadline.value = "2026-08-25";
  elements.adminSafeDeadline.dataset.touched = "1";

  context.updateAdminSafeFormRules_();
  assert.equal(elements.adminSafeAttendance.value, "N");
  assert.equal(elements.adminSafeDeadline.value, "2026-08-25");
});
