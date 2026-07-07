module.exports = {
    apps: [
        {
            name: 'charon',
            script: 'index.js',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '750M',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
