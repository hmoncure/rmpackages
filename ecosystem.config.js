module.exports = {
  apps: [{
    name: 'office-packages',
    script: 'server.js',
    cwd: '/home/ubuntu/office-packages',
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: '150M',
    env: { NODE_ENV: 'production' },
  }],
};
