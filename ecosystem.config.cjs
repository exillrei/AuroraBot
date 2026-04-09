module.exports = {
  apps: [
    {
      name: "AuroraBot",
      script: "./system/main.js",
      watch: false,
      out_file: null,
      error_file: null,
      log_file: null,
      autorestart: true,
      max_restarts: 999999,
      restart_delay: 1000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
