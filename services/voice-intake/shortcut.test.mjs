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
  assert.equal(items(p.WFFormValues)[0].WFValue.Value.OutputUUID, record.WFWorkflowActionParameters.UUID);
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

test('every variable reference points to an earlier action', () => {
  for (const mode of ['record', 'dictate']) {
    const workflow = buildShortcut({url: URL, mode});
    const seen = new Set();
    for (const a of workflow.WFWorkflowActions) {
      for (const [, uuid] of JSON.stringify(a.WFWorkflowActionParameters).matchAll(/"OutputUUID":"([^"]+)"/g)) assert.ok(seen.has(uuid), `${a.WFWorkflowActionIdentifier} -> ${uuid}`);
      seen.add(a.WFWorkflowActionParameters.UUID);
    }
  }
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
