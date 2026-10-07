/** @type {import('jest').Config} */
module.exports = {
  // ESM rather than the default CommonJS transform, matching the source this
  // package ships. Requires NODE_OPTIONS=--experimental-vm-modules, set in the
  // `test` script.
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true }],
  },
  /*
    Resolve the `.js` in a relative import back to the `.ts` that will become
    it.

    The source now writes `from "./errors.js"`, which is what Node's ESM loader
    and a `moduleResolution: NodeNext` CONSUMER both require — this package
    ships TypeScript source, so a consumer compiles it under their settings,
    not ours. Our own `moduleResolution: "bundler"` tolerated the extensionless
    form, which is why it went unnoticed until optima-cloud-saas tried to
    consume it and every relative import in the barrel failed to compile.

    Jest is the one place that needs the mapping undone, because it is loading
    the `.ts` directly rather than a built `.js`. Every consumer in this fleet
    carries the identical mapper for the identical reason.
  */
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
  // The integration tier has its own config (jest.integration.config.cjs) and
  // its own script, so a unit run never opens a socket.
  testPathIgnorePatterns: ["/node_modules/", "/__tests__/integration/"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/__tests__/**", "!src/index.ts", "!src/expo.ts"],
  // A package on the sign-in path of every mobile app that adopts it. The
  // floor is high because an uncovered branch here is usually a rejection path.
  coverageThreshold: {
    global: { statements: 90, branches: 85, functions: 90, lines: 90 },
  },
};
