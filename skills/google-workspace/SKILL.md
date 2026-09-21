---
name: google-workspace
description: Create Google Forms surveys with linked Google Sheets response destinations through the configured Google Workspace connector.
---

# Google Workspace

1. Check authorization with google_workspace_auth_status. If authorization is absent, call google_workspace_authorize, give the human the returned Google consent URL, and wait for them to complete Google's own screen. Never request an authorization code, client credential, or token in chat. Done when status is authorized.
2. Confirm the survey title, introduction, confirmation message, and ordered questions. Use section, text, paragraph, multipleChoice, checkbox, or scale; include choices or scale bounds where required. Use `maxSelections` for bounded checkbox questions and `allowOther` for a native write-in option. For conditional routing, give each destination section an `id` and express every routed multiple-choice option as `{label, goToSection}`; use `submit` to end the form. Done when the tool input is complete and contains no private credential material.
3. Call google_workspace_create_survey once. Do not retry an ambiguous network failure because the first call may have created files. Done when the result contains both the Form and spreadsheet identifiers and URLs.
4. Report the edit URL, published URL, and spreadsheet URL. Verify the response spreadsheet is linked by submitting a bounded test response only when the human explicitly authorizes writing test data. Done when the created resources and any unperformed live verification are stated exactly.
