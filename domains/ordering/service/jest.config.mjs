import { join } from 'node:path';

// Loads the environment variables for the tests. `.causa/emulators.env` is written at the root of the Causa workspace
// by `cs emulators start`, and holds the configuration returned by the emulators (hosts, ports, the local GCP project,
// Pub/Sub topics, ...). `.env` is loaded first because already-set variables are never overwritten, letting this
// service override emulator values. Variables set in the shell take precedence over both.
process.loadEnvFile(join(import.meta.dirname, '.env'));
process.loadEnvFile(join(import.meta.dirname, '../../../.causa/emulators.env'));

/** @type {import('jest').Config} */
const config = {
  clearMocks: true,
  coverageDirectory: '../coverage',
  collectCoverageFrom: [
    '**/*.{js,ts}',
    '!**/index.ts',
    '!**/*.spec.ts',
    '!**/*.test.{ts,js}',
    '!model/generated.ts',
  ],
  rootDir: 'src',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['jest-extended/all'],
  testMatch: ['**/*.spec.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['js', 'ts'],
  transform: { '^.+\\.(t|j)s?$': ['@swc/jest', { sourceMaps: 'inline' }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};

export default config;
