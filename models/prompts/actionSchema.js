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
For workflows return {"actions":[ACTION,ACTION]}. Return valid JSON only.
`;

module.exports = { ACTION_SCHEMA };
