const chrono = require('chrono-node');

const TIMEZONE_ALIASES = {
    utc: 'UTC',
    gmt: 'UTC',
    est: 'America/New_York',
    edt: 'America/New_York',
    et: 'America/New_York',
    cst: 'America/Chicago',
    cdt: 'America/Chicago',
    ct: 'America/Chicago',
    mst: 'America/Denver',
    mdt: 'America/Denver',
    mt: 'America/Denver',
    pst: 'America/Los_Angeles',
    pdt: 'America/Los_Angeles',
    pt: 'America/Los_Angeles',
    ist: 'Asia/Kolkata',
    cet: 'Europe/Paris',
    cest: 'Europe/Paris',
    bst: 'Europe/London',
    wet: 'Europe/Lisbon',
    west: 'Europe/Lisbon',
    eet: 'Europe/Athens',
    eest: 'Europe/Athens',
    msk: 'Europe/Moscow',
    gst: 'Asia/Dubai',
    ast: 'Asia/Riyadh',
    sgt: 'Asia/Singapore',
    hkt: 'Asia/Hong_Kong',
    jst: 'Asia/Tokyo',
    kst: 'Asia/Seoul',
    pkt: 'Asia/Karachi',
    npt: 'Asia/Kathmandu',
    bdt: 'Asia/Dhaka',
    ict: 'Asia/Bangkok',
    wib: 'Asia/Jakarta',
    wita: 'Asia/Makassar',
    wit: 'Asia/Jayapura',
    sast: 'Africa/Johannesburg',
    wat: 'Africa/Lagos',
    cat: 'Africa/Harare',
    eat: 'Africa/Nairobi',
    aest: 'Australia/Sydney',
    aedt: 'Australia/Sydney',
    acst: 'Australia/Adelaide',
    acdt: 'Australia/Adelaide',
    awst: 'Australia/Perth',
    nzst: 'Pacific/Auckland',
    nzdt: 'Pacific/Auckland',
};

const TIMEZONE_PHRASES = [
    { pattern: /\barizona(?:\s+time)?\b/ig, timezone: 'America/Phoenix' },
    { pattern: /\bphoenix(?:\s+time)?\b/ig, timezone: 'America/Phoenix' },
    { pattern: /\bindia(?:n)?\s+(?:standard\s+)?time\b/ig, timezone: 'Asia/Kolkata' },
    { pattern: /\blondon(?:\s+time)?\b/ig, timezone: 'Europe/London' },
    { pattern: /\bcentral\s+(?:standard\s+|daylight\s+)?time\b/ig, timezone: 'America/Chicago' },
    { pattern: /\beastern\s+(?:standard\s+|daylight\s+)?time\b/ig, timezone: 'America/New_York' },
    { pattern: /\bpacific\s+(?:standard\s+|daylight\s+)?time\b/ig, timezone: 'America/Los_Angeles' },
    { pattern: /\bmountain\s+(?:standard\s+|daylight\s+)?time\b/ig, timezone: 'America/Denver' },
    { pattern: /\bnew\s+york(?:\s+time)?\b/ig, timezone: 'America/New_York' },
    { pattern: /\bcalifornia(?:\s+time)?\b/ig, timezone: 'America/Los_Angeles' },
    { pattern: /\bsingapore(?:\s+time)?\b/ig, timezone: 'Asia/Singapore' },
    { pattern: /\btokyo(?:\s+time)?\b/ig, timezone: 'Asia/Tokyo' },
    { pattern: /\bdubai(?:\s+time)?\b/ig, timezone: 'Asia/Dubai' },
    { pattern: /\bsydney(?:\s+time)?\b/ig, timezone: 'Australia/Sydney' },
];

function isValidTimeZone(timezone) {
    if (!timezone) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
        return true;
    } catch (error) {
        return false;
    }
}

function normalizeTimezone(timezone, fallback) {
    if (!timezone) return fallback;
    const value = String(timezone).trim();
    const alias = TIMEZONE_ALIASES[value.toLowerCase()];
    if (alias) return alias;
    return isValidTimeZone(value) ? value : fallback;
}

function extractTimezone(text, fallback) {
    if (!text) return fallback;
    for (const phrase of TIMEZONE_PHRASES) {
        phrase.pattern.lastIndex = 0;
        if (phrase.pattern.test(String(text))) return phrase.timezone;
    }

    const matches = String(text).match(/\b(UTC|GMT|[ECMP][DS]?T|IST|BST|WET|WEST|EET|EEST|MSK|GST|AST|SGT|HKT|JST|KST|PKT|NPT|BDT|ICT|WIB|WITA|WIT|SAST|WAT|CAT|EAT|AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT)\b/i);
    return normalizeTimezone(matches?.[1], fallback);
}

function stripTimezoneTokens(text) {
    let value = String(text);
    for (const phrase of TIMEZONE_PHRASES) {
        value = value.replace(phrase.pattern, '');
    }

    return value
        .replace(/\b(UTC|GMT|[ECMP][DS]?T|IST|BST|WET|WEST|EET|EEST|MSK|GST|AST|SGT|HKT|JST|KST|PKT|NPT|BDT|ICT|WIB|WITA|WIT|SAST|WAT|CAT|EAT|AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT)\b/ig, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function offsetMsForZone(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(date).reduce((values, part) => {
        if (part.type !== 'literal') values[part.type] = Number(part.value);
        return values;
    }, {});

    const wallClockUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour === 24 ? 0 : parts.hour,
        parts.minute,
        parts.second,
    );

    return wallClockUtc - date.getTime();
}

function sameWallClockInZone(date, timezone) {
    let utc = Date.UTC(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getMilliseconds(),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
        utc = Date.UTC(
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            date.getHours(),
            date.getMinutes(),
            date.getSeconds(),
            date.getMilliseconds(),
        ) - offsetMsForZone(new Date(utc), timezone);
    }

    return new Date(utc);
}

function hasExplicitOffset(text) {
    return /(?:z|[+-]\d{2}:?\d{2})$/i.test(String(text).trim());
}

function hasDateSignal(text) {
    return /\b(today|tomorrow|yesterday|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i.test(text)
        || /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text)
        || /\b\d{4}-\d{2}-\d{2}\b/.test(text);
}

function parseDate(value, referenceDate = new Date(), timezoneHint = null) {
    if (!value) return null;

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    const text = String(value);
    const timezone = normalizeTimezone(timezoneHint, extractTimezone(text, null));

    if (hasExplicitOffset(text)) {
        const direct = new Date(text);
        return Number.isNaN(direct.getTime()) ? null : direct;
    }

    const parseText = timezone ? stripTimezoneTokens(text) : text;
    const parsed = chrono.parseDate(parseText, referenceDate, { forwardDate: true });
    if (parsed && !Number.isNaN(parsed.getTime())) {
        if (!timezone) return parsed;

        const zoned = sameWallClockInZone(parsed, timezone);
        if (zoned <= referenceDate && !hasDateSignal(parseText)) {
            return sameWallClockInZone(new Date(parsed.getTime() + 24 * 60 * 60 * 1000), timezone);
        }

        return zoned;
    }

    const direct = new Date(text);
    return Number.isNaN(direct.getTime()) ? null : direct;
}

function formatForChat(date, timezone) {
    return new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
        timeZoneName: 'short',
    }).format(date);
}

module.exports = {
    extractTimezone,
    formatForChat,
    normalizeTimezone,
    parseDate,
};
