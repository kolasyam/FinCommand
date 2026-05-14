/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  globalSetup:    './tests/globalSetup.js',
  globalTeardown: './tests/globalTeardown.js',
  setupFilesAfterFramework: ['./tests/setup.js'],
  testTimeout: 30000,
  verbose: true,
  forceExit: true,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'services/**/*.js',
    'routes/**/*.js',
    'middleware/**/*.js',
    '!**/node_modules/**',
  ],
  coverageThresholds: {
    global: { branches: 60, functions: 65, lines: 65, statements: 65 },
  },
};
