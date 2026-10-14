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
        // Plain-HTTP deployment (e.g. Tailscale IP without TLS): browsers drop Secure cookies received
        // over http, so the default (true in production) would break login. Set to 'true' ONLY when
        // the site is served over HTTPS (and nginx sends X-Forwarded-Proto).
        COOKIE_SECURE: 'false',
      },
    },
  ],
};
