function extractJson(text) {
    if (!text) return null;
    if (typeof text !== 'string') text = JSON.stringify(text);

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(candidate.slice(start, end + 1));
}

module.exports = { extractJson };
