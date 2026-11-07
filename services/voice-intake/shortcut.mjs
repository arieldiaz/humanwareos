import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

// Builds the capture Shortcut as a WFWorkflow property list. The edge credential
// is never embedded: two import questions ask for it when the file is added.
//
// Bump SHORTCUT_VERSION whenever the generated actions change, then update
// shortcut.fixture.json; the fixture test fails until both move together. The
// version is written into the file name, a leading Comment action, and the
// shortcutVersion form field, so a device and the service can tell what it runs.
export const SHORTCUT_VERSION = 4;
export const SHORTCUT_NAMES = {record: 'Voice Intake', dictate: 'Voice Intake (Dictation)'};
export const shortcutFileName = (mode, suffix = '') => `${SHORTCUT_NAMES[mode]} v${SHORTCUT_VERSION}${suffix}.shortcut`;
const ref = (uuid, name) => ({OutputUUID: uuid, OutputName: name, Type: 'ActionOutput'});
const attachment = (value) => ({Value: value, WFSerializationType: 'WFTextTokenAttachment'});
const text = (...parts) => {
  let string = '';
  const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === 'string') { string += part; continue; }
    attachmentsByRange[`{${string.length}, 1}`] = part;
    string += '￼';
  }
  return {Value: {string, attachmentsByRange}, WFSerializationType: 'WFTextTokenString'};
};
const field = (key, ...value) => ({WFItemType: 0, WFKey: text(key), WFValue: text(...value)});
const fields = (items) => ({Value: {WFDictionaryFieldValueItems: items}, WFSerializationType: 'WFDictionaryFieldValue'});
const action = (id, uuid, parameters = {}) => ({WFWorkflowActionIdentifier: `is.workflow.actions.${id}`, WFWorkflowActionParameters: {...(uuid ? {UUID: uuid} : {}), ...parameters}});

const named = (name) => ({Type: 'Variable', VariableName: name});
const input = (value) => ({Type: 'Variable', Variable: attachment(value)});
const ID = {clientId: 'A1F0C001-0000-4000-8000-000000000001', clientSecret: 'A1F0C001-0000-4000-8000-000000000002',
  date: 'A1F0C001-0000-4000-8000-000000000003', capture: 'A1F0C001-0000-4000-8000-000000000004',
  deviceName: 'A1F0C001-0000-4000-8000-000000000005', deviceModel: 'A1F0C001-0000-4000-8000-000000000006',
  capturedAt: 'A1F0C001-0000-4000-8000-000000000007', response: 'A1F0C001-0000-4000-8000-000000000008',
  message: 'A1F0C001-0000-4000-8000-000000000009', location: 'A1F0C001-0000-4000-8000-000000000010',
  Latitude: 'A1F0C001-0000-4000-8000-000000000011', Longitude: 'A1F0C001-0000-4000-8000-000000000012',
  City: 'A1F0C001-0000-4000-8000-000000000013', State: 'A1F0C001-0000-4000-8000-000000000014', Name: 'A1F0C001-0000-4000-8000-000000000015'};
const GROUP = {reply: 'A1F0C001-0000-4000-8000-0000000000a5', access: 'A1F0C001-0000-4000-8000-0000000000a6', location: 'A1F0C001-0000-4000-8000-0000000000a7'};
const flow = (id, group, mode, parameters = {}) => ({WFWorkflowActionIdentifier: `is.workflow.actions.${id}`, WFWorkflowActionParameters: {GroupingIdentifier: group, WFControlFlowMode: mode, ...parameters}});
const notify = (...body) => action('notification', undefined, {WFNotificationActionTitle: 'Voice intake', WFNotificationActionBody: text(...body), WFNotificationActionSound: false});

// Location runs after the capture so it never delays recording, and only inside
// an "if the fix has any value" branch so a device without one still uploads.
// Get Details of Locations exposes Name, Street, City, State, Country, ZIP Code,
// Latitude, Longitude, Altitude: no neighborhood. The service builds the label.
const LOCATION_DETAILS = ['Latitude', 'Longitude', 'City', 'State', 'Name'];
const locationActions = () => [
  action('getcurrentlocation', ID.location),
  action('setvariable', undefined, {WFVariableName: 'Location', WFInput: attachment(ref(ID.location, 'Current Location'))}),
  flow('conditional', GROUP.location, 0, {WFCondition: 100, WFInput: input(named('Location'))}),
  ...LOCATION_DETAILS.flatMap(detail => [
    action('properties.locations', ID[detail], {WFInput: attachment(named('Location')), WFContentItemPropertyName: detail}),
    action('setvariable', undefined, {WFVariableName: detail, WFInput: attachment(ref(ID[detail], detail))}),
  ]),
  flow('conditional', GROUP.location, 1),
  flow('conditional', GROUP.location, 2),
];
const locationFields = () => [field('latitude', named('Latitude')), field('longitude', named('Longitude')),
  field('locationCity', named('City')), field('locationState', named('State')), field('locationName', named('Name'))];

// mode 'record' captures full audio; 'dictate' is the fallback for a device whose
// Shortcuts runtime cannot record audio and sends on-device dictation instead.
// Get Current Location is reported to fail on watchOS, so the dictation variant,
// which exists for the Watch, carries no location unless asked.
// Stopping the capture sends it: there is no review menu, so the service's
// silence and length checks are the only guard against an accidental tap.
// A file field nests the variable in a WFTextTokenAttachment; a bare variable
// decodes to nothing and Shortcuts silently drops the field from the form.
export function buildShortcut({url, mode = 'record', location = mode === 'record', built = new Date().toISOString().slice(0, 10)}) {
  if (!/^https:\/\/[^/\s]+\/capture$/.test(url)) throw new Error('capture url must be https://<host>/capture');
  const capture = mode === 'record'
    ? action('recordaudio', ID.capture, {WFRecordingCompression: 'Normal', WFRecordingStart: 'Immediately', WFRecordingEnd: 'On Tap'})
    : action('dictatetext', ID.capture, {WFDictateTextStopListening: 'On Tap'});
  const payload = mode === 'record'
    ? {WFItemType: 5, WFKey: text('audio'), WFValue: {Value: attachment(named('Recording')), WFSerializationType: 'WFTokenAttachmentParameterState'}}
    : field('text', named('Recording'));
  const actions = [
    action('comment', undefined, {WFCommentActionText: `${SHORTCUT_NAMES.record} v${SHORTCUT_VERSION} · built ${built} · Humanware OS`}),
    action('gettext', ID.clientId, {WFTextActionText: ''}),
    action('gettext', ID.clientSecret, {WFTextActionText: ''}),
    action('date', ID.date, {WFDateActionMode: 'Current Date'}),
    action('format.date', ID.capturedAt, {WFDate: text(ref(ID.date, 'Date')), WFDateFormatStyle: 'ISO 8601', WFISO8601IncludeTime: true}),
    action('setvariable', undefined, {WFVariableName: 'Captured At', WFInput: attachment(ref(ID.capturedAt, 'Formatted Date'))}),
    capture,
    action('setvariable', undefined, {WFVariableName: 'Recording', WFInput: attachment(ref(ID.capture, mode === 'record' ? 'Recorded Audio' : 'Dictated Text'))}),
    ...(location ? locationActions() : []),
    action('getdevicedetails', ID.deviceName, {WFDeviceDetail: 'Device Name'}),
    action('getdevicedetails', ID.deviceModel, {WFDeviceDetail: 'Device Model'}),
    action('downloadurl', ID.response, {WFURL: url, WFHTTPMethod: 'POST', WFHTTPBodyType: 'Form', ShowHeaders: true,
      WFHTTPHeaders: fields([field('CF-Access-Client-Id', ref(ID.clientId, 'Text')), field('CF-Access-Client-Secret', ref(ID.clientSecret, 'Text'))]),
      WFFormValues: fields([payload, field('deviceName', ref(ID.deviceName, 'Device Name')), field('deviceModel', ref(ID.deviceModel, 'Device Model')),
        field('capturedAt', named('Captured At')), field('shortcutVersion', String(SHORTCUT_VERSION)), ...(location ? locationFields() : [])])}),
    // The service's JSON names every outcome; anything else came from the edge.
    action('getvalueforkey', ID.message, {WFInput: attachment(ref(ID.response, 'Contents of URL')), WFDictionaryKey: 'message', WFGetDictionaryValueType: 'Value'}),
    flow('conditional', GROUP.reply, 0, {WFCondition: 100, WFInput: input(ref(ID.message, 'Dictionary Value'))}),
    notify(ref(ID.message, 'Dictionary Value')),
    flow('conditional', GROUP.reply, 1),
    flow('conditional', GROUP.access, 0, {WFCondition: 99, WFConditionalActionString: 'Cloudflare Access', WFInput: input(ref(ID.response, 'Contents of URL'))}),
    notify('Blocked by Cloudflare: check token'),
    flow('conditional', GROUP.access, 1),
    notify('Mini unavailable'),
    flow('conditional', GROUP.access, 2),
    flow('conditional', GROUP.reply, 2),
  ];
  return {
    WFWorkflowClientVersion: '2607.0.2', WFWorkflowMinimumClientVersion: 900, WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: {WFWorkflowIconStartColor: 4282601983, WFWorkflowIconGlyphNumber: 59511},
    WFWorkflowTypes: ['Watch'], WFWorkflowInputContentItemClasses: [], WFWorkflowOutputContentItemClasses: [], WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowImportQuestions: [
      {ActionIndex: 1, Category: 'Parameter', ParameterKey: 'WFTextActionText', DefaultValue: '', Text: 'Voice intake Access client ID (CF-Access-Client-Id)'},
      {ActionIndex: 2, Category: 'Parameter', ParameterKey: 'WFTextActionText', DefaultValue: '', Text: 'Voice intake Access client secret (CF-Access-Client-Secret)'},
    ],
    WFWorkflowActions: actions,
  };
}

// Digest of both generated variants with the build date fixed; recorded in
// shortcut.fixture.json beside SHORTCUT_VERSION so the test catches a change to one without the other.
export function shortcutDigest() {
  const digest = createHash('sha256');
  for (const mode of Object.keys(SHORTCUT_NAMES)) digest.update(JSON.stringify(buildShortcut({url: 'https://intake.example.test/capture', mode, built: '2026-11-07'})));
  return digest.digest('hex');
}

// plutil writes the binary plist (`shortcuts sign` requires the .shortcut extension).
export function writeUnsigned(workflow, output) {
  const work = mkdtempSync(join(tmpdir(), 'voice-intake-shortcut-'));
  try {
    writeFileSync(join(work, 'workflow.json'), JSON.stringify(workflow));
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', output, join(work, 'workflow.json')]);
  } finally { rmSync(work, {recursive: true, force: true}); }
}

// The generator is the bottom of the service's import graph, so the entry check lives here.
export function isMainModule(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
}

// Signing needs a macOS user signed in to iCloud; the unsigned file stays for a later signer.
if (isMainModule(import.meta.url, process.argv[1])) {
  const {values} = parseArgs({options: {url: {type: 'string'}, 'out-dir': {type: 'string'}}});
  if (!values.url || !values['out-dir']) throw new Error('usage: shortcut.mjs --url https://<host>/capture --out-dir <directory>');
  mkdirSync(values['out-dir'], {recursive: true, mode: 0o700});
  let failed = false;
  for (const mode of Object.keys(SHORTCUT_NAMES)) {
    const unsigned = join(values['out-dir'], shortcutFileName(mode, '.unsigned')), signed = join(values['out-dir'], shortcutFileName(mode));
    writeUnsigned(buildShortcut({url: values.url, mode}), unsigned);
    try {
      execFileSync('/usr/bin/shortcuts', ['sign', '--mode', 'people-who-know-me', '--input', unsigned, '--output', signed], {stdio: ['ignore', 'ignore', 'inherit']});
      console.log(signed);
    } catch { failed = true; console.error(`unsigned: ${unsigned}`); }
  }
  if (failed) process.exitCode = 1;
}
