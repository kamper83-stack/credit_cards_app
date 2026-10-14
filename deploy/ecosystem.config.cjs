module.exports = {
  apps: [
    {
      name: 'rewards-server',
      cwd: __dirname + '/../server',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOST: '127.0.0.1',
        // nginx runs on the same host and connects via loopback; trust only it.
        TRUST_PROXY: 'loopback',
      },
    },
  ],
};
