const ACTION_SCHEMA = `
ACTION schema:
{
  "intent":"schedule|reminder|update|cancel|complete|list|announce|answer|refuse",
  "title":"",
  "text":"",
  "target":"",
  "date":"",
  "time":"",
  "timezone":"",
  "kind":"meeting|reminder|all|",
  "attendees":[],
  "reply":"",
  "ask":""
}

Action capabilities:
- schedule: create a new active meeting record and Meet link. Required: title plus resolvable future time.
- reminder: create a reminder. Required: text plus resolvable future time.
- update: move/reschedule or rename one active meeting/reminder. Required: target reference plus changed fields.
- cancel: cancel active meeting/reminder/all. Required: kind/target unless user clearly says all.
- complete: mark active meeting/reminder done. Required: target reference.
- list: show active meetings, reminders, or all; target narrows search or link lookup.
- announce: send text to group. Required: text.
- answer/refuse: conversational response only; no tool side effects.

Finite workflows:
- If the user asks for multiple operations, return {"actions":[ACTION,ACTION,...]} in exact order.
- Later steps may reference earlier tool results with {{previous.id}}, {{previous.meetLink}}, or {{steps.1.id}}.
- Every ACTION must be flat. Never put actions/sequence/nested tool objects inside an ACTION.
- Never output a schedule/reminder/update time earlier than clock.timestampMs; ask for a future time instead.
- Do not revive a cancelled meeting unless the user explicitly says reschedule/restore/uncancel or refers to last/previous/that cancelled item.
- Optional fields must be "" or []; missing required execution details go in ask.
Return valid JSON only.
`;

module.exports = { ACTION_SCHEMA };
