import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
// Runtime layout: <runtime>/framework/services/email-intake/framework.mjs, so the
// framework root is two directories up unless explicitly overridden.
const root = process.env.HUMANWARE_FRAMEWORK_ROOT
  ?? (process.env.HUMANWARE_RUNTIME_ROOT ? join(process.env.HUMANWARE_RUNTIME_ROOT, 'framework') : join(import.meta.dirname, '..', '..'));
export const framework = (path) => import(pathToFileURL(join(root, path)));
export const {EmailIntakeService} = await framework('ops/email-intake/service.mjs');
export const {SQLiteIntakeRepository} = await framework('ops/email-intake/repository.mjs');
export const {normalizeMessage, digest} = await framework('ops/email-intake/model.mjs');

export const {ownerSessionRequest, splitOwnerText} = await framework("ops/email-intake/owner-session.mjs");
