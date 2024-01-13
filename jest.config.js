export default {
  roots: [
    "src/tests"
  ],
  testMatch: [
    "**/__tests__/**/*.+(ts|tsx|js)",
    "**/?(*.)+(spec|test).+(ts|tsx|js)"
  ],
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest"
  },
	moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
}