'use strict';
// Runs before each test file — sets test environment
process.env.NODE_ENV             = 'test';
process.env.DB_NAME              = process.env.TEST_DB_NAME || 'fincommand_test';
process.env.JWT_SECRET           = 'test_jwt_secret_32_chars_minimum_ok';
process.env.JWT_REFRESH_SECRET   = 'test_refresh_secret_32_chars_min_ok';
process.env.JWT_EXPIRES_IN       = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.BCRYPT_ROUNDS        = '4';
process.env.UPLOAD_DIR           = '/tmp/fc_test_uploads';
process.env.LOG_LEVEL            = 'silent';
process.env.RATE_LIMIT_MAX       = '9999';  // disable rate limiting in tests

// Silence console.log in tests unless DEBUG=1
if (!process.env.DEBUG) {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
}
