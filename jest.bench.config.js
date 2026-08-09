/* eslint-env node */
/* global module */

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  verbose: false,
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  testTimeout: 120000,
  roots: [
    '<rootDir>/benchmarks'
  ],
  testMatch: [
    '<rootDir>/benchmarks/**/*.benchmark.test.ts',
    '<rootDir>/benchmarks/**/*benchmark*.test.ts'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/build/',
    '/tests/'
  ],
  collectCoverage: false,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
        diagnostics: {
          ignoreCodes: [5103]
        }
      }
    ]
  },
  moduleNameMapper: {
    '^effectable$': '<rootDir>/src/index.ts',
    '^effectable/(.*)$': '<rootDir>/src/$1',
    '^Effectable$': '<rootDir>/src/index.ts',
    '^Effectable/(.*)$': '<rootDir>/src/$1'
  },
  maxWorkers: 1,
  detectLeaks: false,
  cache: false
};
