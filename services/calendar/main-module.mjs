import {realpathSync} from "node:fs";
import {pathToFileURL} from "node:url";

export function isMainModule(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
}
