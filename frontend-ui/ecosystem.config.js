module.exports = {
  apps: [
    {
      name: "frontend-ui",
      script: "serve",
      args: "-s dist -l 3000",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
