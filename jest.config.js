module.exports = {
  testMatch: ['**/test/**/*.test.js'],
  testEnvironment: 'node',
  clearMocks: true,
  collectCoverageFrom: [
    'lib/**/*.js',
    'metrics-server.js'
  ],
  coverageDirectory: 'coverage'
};
