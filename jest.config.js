/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testMatch: [
    "**/__tests__/**/*.ts",
    "**/?(*.)+(spec|test).ts"
  ],
  transform: {
    '^.+\.ts?$': 'ts-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!next-auth)',
  ],
};
