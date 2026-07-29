module.exports = {
  apps: [{
    name: 'claude-stats-stage',
    script: 'npm',
    args: 'run dev',
    cwd: '/usr/local/src/claude-stats',
    watch: false,
    env: {
      NODE_ENV: 'development',
      PORT: 3600,
    },
  }],
};
