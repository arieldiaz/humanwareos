function createSurvey(spec) {
  validateSurvey_(spec);
  var form;
  var sheet;
  try {
    form = FormApp.create(spec.title);
    sheet = SpreadsheetApp.create(spec.spreadsheetTitle || spec.title + " — Responses");
    if (spec.description) form.setDescription(spec.description);
    if (spec.confirmationMessage) form.setConfirmationMessage(spec.confirmationMessage);
    var items = spec.questions.map(function (question) { return addQuestion_(form, question); });
    applyRouting_(spec.questions, items);
    form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());
    return {formId: form.getId(), editUrl: form.getEditUrl(), publishedUrl: form.getPublishedUrl(), spreadsheetId: sheet.getId(), spreadsheetUrl: sheet.getUrl()};
  } catch (error) {
    if (form) DriveApp.getFileById(form.getId()).setTrashed(true);
    if (sheet) DriveApp.getFileById(sheet.getId()).setTrashed(true);
    throw error;
  }
}
function addQuestion_(form, question) {
  var item;
  if (question.type === "section") item = form.addPageBreakItem();
  else if (question.type === "text") item = form.addTextItem();
  else if (question.type === "paragraph") item = form.addParagraphTextItem();
  else if (question.type === "multipleChoice") {
    item = form.addMultipleChoiceItem();
    if (typeof question.choices[0] === "string") item.setChoiceValues(question.choices);
  }
  else if (question.type === "checkbox") item = form.addCheckboxItem().setChoiceValues(question.choices);
  else if (question.type === "scale") item = form.addScaleItem().setBounds(question.lower || 1, question.upper || 5).setLabels(question.lowerLabel || "", question.upperLabel || "");
  else throw new Error("Unsupported question type: " + question.type);
  item.setTitle(question.title);
  if (question.type !== "section") item.setRequired(Boolean(question.required));
  if (question.helpText) item.setHelpText(question.helpText);
  if ((question.type === "multipleChoice" || question.type === "checkbox") && question.allowOther) item.showOtherOption(true);
  if (question.type === "checkbox" && question.maxSelections) {
    item.setValidation(FormApp.createCheckboxValidation().requireSelectAtMost(question.maxSelections).build());
  }
  return item;
}
function applyRouting_(questions, items) {
  var sections = {};
  questions.forEach(function (question, index) {
    if (question.type === "section" && question.id) sections[question.id] = items[index];
  });
  questions.forEach(function (question, index) {
    if (question.type !== "multipleChoice" || typeof question.choices[0] === "string") return;
    var item = items[index];
    item.setChoices(question.choices.map(function (choice) {
      if (choice.goToSection === "submit") return item.createChoice(choice.label, FormApp.PageNavigationType.SUBMIT);
      return item.createChoice(choice.label, sections[choice.goToSection]);
    }));
  });
}
function validateSurvey_(spec) {
  if (!spec || typeof spec.title !== "string" || !spec.title.trim()) throw new Error("Survey title is required");
  if (!Array.isArray(spec.questions) || !spec.questions.length) throw new Error("At least one survey question is required");
  var sectionIds = {};
  spec.questions.forEach(function (question) {
    if (!question || typeof question.title !== "string" || !question.title.trim()) throw new Error("Every question needs a title");
    if ((question.type === "multipleChoice" || question.type === "checkbox") && (!Array.isArray(question.choices) || question.choices.length < 2)) throw new Error(question.title + " needs at least two choices");
    if (question.type === "checkbox" && question.choices.some(function (choice) { return typeof choice !== "string"; })) throw new Error(question.title + " checkbox choices must be text");
    if (question.type === "multipleChoice") {
      var routed = typeof question.choices[0] === "object";
      if (question.choices.some(function (choice) { return (typeof choice === "object") !== routed; })) throw new Error(question.title + " cannot mix routed and plain choices");
    }
    if (question.type === "scale" && question.lower && question.upper && question.lower >= question.upper) throw new Error(question.title + " has invalid scale bounds");
    if (question.type === "checkbox" && question.maxSelections && (!Number.isInteger(question.maxSelections) || question.maxSelections < 1 || question.maxSelections > question.choices.length)) throw new Error(question.title + " has an invalid selection limit");
    if (question.type === "section") {
      if (!question.id) throw new Error(question.title + " needs a section id");
      if (sectionIds[question.id]) throw new Error("Duplicate section id: " + question.id);
      sectionIds[question.id] = true;
    }
    if (question.maxSelections && question.type !== "checkbox") throw new Error(question.title + " selection limits require a checkbox question");
  });
  spec.questions.forEach(function (question) {
    if (question.type !== "multipleChoice" || typeof question.choices[0] !== "object") return;
    question.choices.forEach(function (choice) {
      if (choice.goToSection !== "submit" && !sectionIds[choice.goToSection]) throw new Error(question.title + " routes to unknown section: " + choice.goToSection);
    });
  });
}
