import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

function item(kind) {
  return {
    kind,
    setTitle(value) { this.title = value; return this; },
    setRequired(value) { this.required = value; return this; },
    setHelpText(value) { this.helpText = value; return this; },
    setChoiceValues(value) { this.choiceValues = value; return this; },
    setValidation(value) { this.validation = value; return this; },
    showOtherOption(value) { this.allowOther = value; return this; },
    createChoice(label, destination) { return {label, destination}; },
    setChoices(value) { this.choices = value; return this; },
  };
}

function harness({failSheet = false} = {}) {
  const trashed = [];
  const form = {
    items: [],
    addPageBreakItem() { const value = item("section"); this.items.push(value); return value; },
    addTextItem() { const value = item("text"); this.items.push(value); return value; },
    addParagraphTextItem() { const value = item("paragraph"); this.items.push(value); return value; },
    addMultipleChoiceItem() { const value = item("multipleChoice"); this.items.push(value); return value; },
    addCheckboxItem() { const value = item("checkbox"); this.items.push(value); return value; },
    addScaleItem() { const value = item("scale"); value.setBounds = function (lower, upper) { this.bounds = [lower, upper]; return this; }; value.setLabels = function (lower, upper) { this.labels = [lower, upper]; return this; }; this.items.push(value); return value; },
    setDescription(value) { this.description = value; },
    setConfirmationMessage(value) { this.confirmationMessage = value; },
    setDestination(type, id) { this.destination = {type, id}; },
    getId() { return "form-id"; },
    getEditUrl() { return "https://forms.example/edit"; },
    getPublishedUrl() { return "https://forms.example/view"; },
  };
  const sheet = {getId() { return "sheet-id"; }, getUrl() { return "https://sheets.example/sheet-id"; }};
  const validation = {requireSelectAtMost(value) { this.max = value; return this; }, build() { return {max: this.max}; }};
  const context = {
    FormApp: {
      create() { return form; },
      createCheckboxValidation() { return Object.create(validation); },
      DestinationType: {SPREADSHEET: "spreadsheet"},
      PageNavigationType: {SUBMIT: "submit"},
    },
    SpreadsheetApp: {create() { if (failSheet) throw new Error("sheet failed"); return sheet; }},
    DriveApp: {getFileById(id) { return {setTrashed(value) { if (value) trashed.push(id); }}; }},
  };
  vm.runInNewContext(fs.readFileSync(new URL("./Code.js", import.meta.url), "utf8"), context);
  return {context, form, trashed};
}

test("creates routed sections, bounded checkboxes, and native other answers", () => {
  const {context, form} = harness();
  const result = context.createSurvey({
    title: "Parent survey",
    questions: [
      {type: "checkbox", title: "Concerns", choices: ["Privacy", "Accuracy", "Other"], maxSelections: 2, allowOther: true},
      {type: "multipleChoice", title: "Follow up?", choices: [{label: "Yes", goToSection: "contact"}, {label: "No", goToSection: "submit"}]},
      {type: "section", id: "contact", title: "Contact"},
      {type: "text", title: "Email", required: true},
    ],
  });

  assert.deepEqual({...result}, {formId: "form-id", editUrl: "https://forms.example/edit", publishedUrl: "https://forms.example/view", spreadsheetId: "sheet-id", spreadsheetUrl: "https://sheets.example/sheet-id"});
  assert.deepEqual(form.items[0].validation, {max: 2});
  assert.equal(form.items[0].allowOther, true);
  assert.equal(form.items[1].choices[0].destination, form.items[2]);
  assert.equal(form.items[1].choices[1].destination, "submit");
  assert.deepEqual(form.destination, {type: "spreadsheet", id: "sheet-id"});
});

test("trashes a partially created form when spreadsheet creation fails", () => {
  const {context, trashed} = harness({failSheet: true});
  assert.throws(() => context.createSurvey({title: "Parent survey", questions: [{type: "text", title: "Name"}]}), /sheet failed/);
  assert.deepEqual(trashed, ["form-id"]);
});
