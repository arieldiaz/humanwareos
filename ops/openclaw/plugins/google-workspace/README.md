# Google Workspace OpenClaw plugin

This framework plugin creates a Google Form and links a new Google Sheets response destination. Google Forms API does not expose response-destination linking, so the connector calls a user-owned Apps Script API executable. The script uses documented Forms, Sheets, and Drive services.

## Ownership

Humanware OS owns the generic plugin, tool schemas, Apps Script source, and tests. Each private instance owns the Google Cloud project, OAuth client identity, Apps Script deployment identifier, protected credential references, token-store command, enabled-plugin selection, and survey content.

## Google setup

1. In a private Google Cloud project, enable the Google Apps Script API.
2. Create a desktop OAuth client with the loopback redirect URI emitted by the plugin.
3. Create a standalone Apps Script project from the files in the apps-script directory, associate it with the same Cloud project, and deploy it as an API executable that runs as the accessing user.
4. Add the deployment identifier and protected credential key names to the private instance plugin configuration.
5. Configure tokenCommand as an instance-owned executable argv array. OpenClaw appends get or put; get returns the refresh token on stdout, and put receives it on stdin. The bridge must connect directly to the instance secrets manager and must never log the token.

The runtime environment supplies the OAuth client ID and client secret under the configured environment key names. Values never belong in source, plugin configuration, argv, logs, or chat.

## Human authorization

Call google_workspace_authorize, open its consent URL, and approve on Google's own page. Google redirects to the loopback listener, which exchanges the one-time code and writes the refresh token through tokenCommand. Do not paste a code or token into OpenClaw. Use google_workspace_auth_status to confirm completion.

The consent request is limited to Forms, Sheets, and files created or opened by this application. The Forms scope is required because Apps Script's Forms service does not support the narrower Forms API forms.body scope.
