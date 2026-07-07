function write(level, message, extra) {
    const payload = [`[${new Date().toISOString()}]`, level.toUpperCase(), message];
    if (extra) payload.push(extra instanceof Error ? extra.stack || extra.message : JSON.stringify(extra));
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](payload.join(' '));
}

const logger = {
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
};

module.exports = { logger };
