import assert from "node:assert/strict";
import {mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import test from "node:test";
import {isMainModule} from "./main-module.mjs";

test("recognizes a main module invoked through a runtime symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "calendar-main-"));
  try {
    const target = join(directory, "server.mjs");
    const link = join(directory, "current-server.mjs");
    writeFileSync(target, "");
    symlinkSync(target, link);
    assert.equal(isMainModule(pathToFileURL(realpathSync(target)).href, link), true);
    assert.equal(isMainModule(pathToFileURL(realpathSync(target)).href, target), true);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
