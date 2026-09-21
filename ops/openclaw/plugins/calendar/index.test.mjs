import assert from "node:assert/strict";
import test from "node:test";
import plugin, {CalendarClient} from "./index.js";

test("calendar client sends the trusted runtime actor and stable tool call id", async () => {
  let request;
  const client = new CalendarClient("http://127.0.0.1:8794", "agent:max", async (url, options) => {
    request = {url, options};
    return new Response(JSON.stringify({ok: true}), {status: 200, headers: {"content-type": "application/json"}});
  });
  assert.deepEqual(await client.call("calendar_list_calendars", {}, "call-1"), {ok: true});
  assert.equal(request.url, "http://127.0.0.1:8794/api/tools/calendar_list_calendars");
  assert.equal(request.options.headers["x-calendar-agent"], "agent:max");
  assert.deepEqual(JSON.parse(request.options.body), {operationId: "call-1", args: {}});
});

test("plugin registers agent-context calendar tools", () => {
  const factories = [];
  plugin.register({pluginConfig: {endpoint: "http://127.0.0.1:8794"}, registerTool(factory, options) { factories.push({factory, options}); }});
  assert.equal(factories.length, 11);
  const create = factories.find((item) => item.options.name === "calendar_create_calendar").factory({agentId: "liv"});
  assert.equal(create.name, "calendar_create_calendar");
  assert.deepEqual(create.parameters.required, ["name", "ownerAddress", "reason"]);
});
