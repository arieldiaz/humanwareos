const state = {data: null, visible: new Set()};
const date = new Intl.DateTimeFormat(undefined, {weekday: "short", month: "short", day: "numeric"});
const time = new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"});

function instant(boundary) { return boundary.kind === "date" ? new Date(`${boundary.date}T00:00:00`) : new Date(boundary.dateTime); }
function when(event) {
  if (event.start.kind === "date") return `${date.format(instant(event.start))} · all day`;
  return `${date.format(instant(event.start))} · ${time.format(instant(event.start))}`;
}
function escape(value) { const node = document.createElement("span"); node.textContent = value ?? ""; return node.innerHTML; }

function render() {
  const calendars = new Map(state.data.calendars.map((calendar) => [calendar.id, calendar]));
  const events = state.data.events.filter((event) => state.visible.has(event.calendarId) && event.status !== "cancelled").sort((a, b) => instant(a.start) - instant(b.start));
  document.querySelector("#events").innerHTML = events.length ? events.map((event) => {
    const calendar = calendars.get(event.calendarId); const color = event.color || calendar?.color || "#64748b";
    return `<article class="event" style="--event-color:${escape(color)}"><time>${escape(when(event))}</time><div><h2>${escape(event.title)}</h2><p>${escape([event.category, event.location].filter(Boolean).join(" · "))}</p></div><span>${escape(calendar?.name ?? "Calendar")}</span></article>`;
  }).join("") : `<p class="muted">No upcoming events in the selected calendars.</p>`;
}

async function load() {
  const response = await fetch("api/dashboard", {headers: {accept: "application/json"}}); if (!response.ok) throw new Error(`HTTP ${response.status}`);
  state.data = await response.json(); state.visible = new Set(state.data.calendars.map((calendar) => calendar.id));
  document.querySelector("#range").textContent = `${state.data.events.length} events · ${state.data.calendars.length} calendars`;
  document.querySelector("#legend").innerHTML = state.data.calendars.map((calendar) => `<label><input type="checkbox" value="${escape(calendar.id)}" checked><i style="--calendar-color:${escape(calendar.color)}"></i>${escape(calendar.name)}</label>`).join("");
  document.querySelector("#legend").addEventListener("change", (event) => { event.target.checked ? state.visible.add(event.target.value) : state.visible.delete(event.target.value); render(); });
  render();
}
load().catch((error) => { document.querySelector("#events").innerHTML = `<p class="error">Calendar unavailable: ${escape(error.message)}</p>`; });
