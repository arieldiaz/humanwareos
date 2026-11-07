import test from 'node:test';
import assert from 'node:assert/strict';
import {buildShortcut} from './shortcut.mjs';

const URL = 'https://intake.example.test/capture';
const byId = (workflow, id) => workflow.WFWorkflowActions.filter(a => a.WFWorkflowActionIdentifier === `is.workflow.actions.${id}`);
const items = (value) => value.Value.WFDictionaryFieldValueItems;
const key = (item) => item.WFKey.Value.string;

test('record shortcut starts recording immediately and posts the file with device and time', () => {
  const workflow = buildShortcut({url: URL});
  const [record] = byId(workflow, 'recordaudio');
  assert.deepEqual([record.WFWorkflowActionParameters.WFRecordingStart, record.WFWorkflowActionParameters.WFRecordingEnd], ['Immediately', 'On Tap']);
  const [post] = byId(workflow, 'downloadurl');
  const p = post.WFWorkflowActionParameters;
  assert.deepEqual([p.WFURL, p.WFHTTPMethod, p.WFHTTPBodyType], [URL, 'POST', 'Form']);
  assert.deepEqual(items(p.WFFormValues).map(key), ['audio', 'deviceName', 'deviceModel', 'capturedAt']);
  assert.equal(items(p.WFFormValues)[0].WFItemType, 5);
  assert.deepEqual(items(p.WFFormValues)[0].WFValue, {WFSerializationType: 'WFTokenAttachmentParameterState',
    Value: {WFSerializationType: 'WFTextTokenAttachment', Value: {Type: 'Variable', VariableName: 'Recording'}}});
  const recording = workflow.WFWorkflowActions.find(a => a.WFWorkflowActionParameters.WFVariableName === 'Recording');
  assert.equal(recording.WFWorkflowActionParameters.WFInput.Value.OutputUUID, record.WFWorkflowActionParameters.UUID);
  assert.deepEqual(workflow.WFWorkflowTypes, ['Watch']);
  const actions = workflow.WFWorkflowActions.map(a => a.WFWorkflowActionIdentifier);
  assert.ok(actions.indexOf('is.workflow.actions.date') < actions.indexOf('is.workflow.actions.recordaudio'), 'capture time is taken before recording');
});

test('the edge credential is asked at import, never embedded', () => {
  const workflow = buildShortcut({url: URL});
  const questions = workflow.WFWorkflowImportQuestions;
  assert.equal(questions.length, 2);
  for (const q of questions) {
    const target = workflow.WFWorkflowActions[q.ActionIndex];
    assert.equal(target.WFWorkflowActionIdentifier, 'is.workflow.actions.gettext');
    assert.equal(target.WFWorkflowActionParameters[q.ParameterKey], '');
    assert.equal(q.DefaultValue, '');
  }
  const headers = items(byId(workflow, 'downloadurl')[0].WFWorkflowActionParameters.WFHTTPHeaders);
  assert.deepEqual(headers.map(key), ['CF-Access-Client-Id', 'CF-Access-Client-Secret']);
  headers.forEach((header, i) => {
    assert.equal(header.WFValue.Value.string, '￼');
    assert.equal(Object.values(header.WFValue.Value.attachmentsByRange)[0].OutputUUID, workflow.WFWorkflowActions[questions[i].ActionIndex].WFWorkflowActionParameters.UUID);
  });
});

test('every variable reference points to an earlier action and control flow is balanced', () => {
  for (const mode of ['record', 'dictate']) {
    const workflow = buildShortcut({url: URL, mode});
    const seen = new Set(), stack = [];
    for (const a of workflow.WFWorkflowActions) {
      const p = a.WFWorkflowActionParameters, json = JSON.stringify(p);
      for (const [, uuid] of json.matchAll(/"OutputUUID":"([^"]+)"/g)) assert.ok(seen.has(uuid), `${a.WFWorkflowActionIdentifier} -> ${uuid}`);
      for (const [, name] of json.matchAll(/"VariableName":"([^"]+)"/g)) assert.ok(seen.has(name), `${a.WFWorkflowActionIdentifier} -> ${name}`);
      seen.add(p.UUID); seen.add(p.WFVariableName);
      if (p.WFControlFlowMode === 0) stack.push(p.GroupingIdentifier);
      else if (p.WFControlFlowMode === 1) assert.equal(stack.at(-1), p.GroupingIdentifier);
      else if (p.WFControlFlowMode === 2) assert.equal(stack.pop(), p.GroupingIdentifier);
    }
    assert.equal(stack.length, 0);
  }
});

test('stopping the capture sends it: no menu, loop, or exit stands between capture and post', () => {
  for (const mode of ['record', 'dictate']) {
    const actions = buildShortcut({url: URL, mode}).WFWorkflowActions;
    const ids = actions.map(a => a.WFWorkflowActionIdentifier.replace('is.workflow.actions.', ''));
    for (const absent of ['choosefrommenu', 'repeat.count', 'exit']) assert.equal(ids.includes(absent), false, `${mode}: ${absent}`);
    const capture = ids.indexOf(mode === 'record' ? 'recordaudio' : 'dictatetext');
    assert.deepEqual(ids.slice(capture + 1, ids.indexOf('downloadurl')), ['setvariable', 'getdevicedetails', 'getdevicedetails']);
    assert.equal(ids.indexOf('downloadurl'), ids.lastIndexOf('downloadurl'), 'exactly one upload');
    assert.ok(!JSON.stringify(actions).includes('Choice'), 'no review state survives');
  }
});

test('each outcome shows a distinct notification', () => {
  const actions = buildShortcut({url: URL}).WFWorkflowActions;
  const bodies = actions.filter(a => a.WFWorkflowActionIdentifier.endsWith('notification')).map(a => a.WFWorkflowActionParameters.WFNotificationActionBody.Value.string);
  assert.deepEqual(bodies, ['￼', 'Blocked by Cloudflare: check token', 'Mini unavailable']);
  const access = actions.find(a => a.WFWorkflowActionParameters.WFCondition === 99).WFWorkflowActionParameters;
  assert.equal(access.WFConditionalActionString, 'Cloudflare Access', 'matches the Access 403 page title');
});

test('dictation fallback posts text instead of audio', () => {
  const workflow = buildShortcut({url: URL, mode: 'dictate'});
  assert.equal(byId(workflow, 'recordaudio').length, 0);
  assert.equal(byId(workflow, 'dictatetext').length, 1);
  assert.deepEqual(items(byId(workflow, 'downloadurl')[0].WFWorkflowActionParameters.WFFormValues).map(key), ['text', 'deviceName', 'deviceModel', 'capturedAt']);
});

test('only an https capture url is accepted', () => {
  assert.throws(() => buildShortcut({url: 'http://intake.example.test/capture'}), /https/);
  assert.throws(() => buildShortcut({url: 'https://intake.example.test/audio'}), /capture/);
});
