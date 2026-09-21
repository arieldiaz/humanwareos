function createSurvey(spec) {
  validateSurvey_(spec);
  var form = FormApp.create(spec.title);
  var sheet = SpreadsheetApp.create(spec.spreadsheetTitle || spec.title + " — Responses");
  try {
    if (spec.description) form.setDescription(spec.description);
    if (spec.confirmationMessage) form.setConfirmationMessage(spec.confirmationMessage);
    spec.questions.forEach(function (question) { addQuestion_(form, question); });
    form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());
    return {formId: form.getId(), editUrl: form.getEditUrl(), publishedUrl: form.getPublishedUrl(), spreadsheetId: sheet.getId(), spreadsheetUrl: sheet.getUrl()};
  } catch (error) {
    DriveApp.getFileById(form.getId()).setTrashed(true);
    DriveApp.getFileById(sheet.getId()).setTrashed(true);
    throw error;
  }
}
function addQuestion_(form, question) {
  var item;
  if (question.type === "text") item = form.addTextItem();
  else if (question.type === "paragraph") item = form.addParagraphTextItem();
  else if (question.type === "multipleChoice") item = form.addMultipleChoiceItem().setChoiceValues(question.choices);
  else if (question.type === "checkbox") item = form.addCheckboxItem().setChoiceValues(question.choices);
  else if (question.type === "scale") item = form.addScaleItem().setBounds(question.lower || 1, question.upper || 5).setLabels(question.lowerLabel || "", question.upperLabel || "");
  else throw new Error("Unsupported question type: " + question.type);
  item.setTitle(question.title).setRequired(Boolean(question.required));
  if (question.helpText) item.setHelpText(question.helpText);
}
function validateSurvey_(spec) {
  if (!spec || typeof spec.title !== "string" || !spec.title.trim()) throw new Error("Survey title is required");
  if (!Array.isArray(spec.questions) || !spec.questions.length) throw new Error("At least one survey question is required");
  spec.questions.forEach(function (question) {
    if (!question || typeof question.title !== "string" || !question.title.trim()) throw new Error("Every question needs a title");
    if ((question.type === "multipleChoice" || question.type === "checkbox") && (!Array.isArray(question.choices) || question.choices.length < 2)) throw new Error(question.title + " needs at least two choices");
    if (question.type === "scale" && question.lower && question.upper && question.lower >= question.upper) throw new Error(question.title + " has invalid scale bounds");
  });
}
