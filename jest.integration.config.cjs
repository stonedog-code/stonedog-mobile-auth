/** @type {import('jest').Config} */
// The integration tier: the connect client against a real in-process HTTP
// server, over real sockets. Same transform as the unit tier; only the set of
// files differs.
const unit = require("./jest.config.cjs");

module.exports = {
  ...unit,
  testMatch: ["<rootDir>/src/__tests__/integration/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/"],
  collectCoverageFrom: undefined,
  coverageThreshold: undefined,
};
