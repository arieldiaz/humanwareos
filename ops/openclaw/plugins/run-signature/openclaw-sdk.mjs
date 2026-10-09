import {join} from "node:path";

export function loadCoreSdk(name) {
  return import(join(process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw", "dist", "plugin-sdk", `${name}.js`));
}
