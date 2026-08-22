// Loaded before the test files. lib/db builds its client at import time and
// warns when DATABASE_URL is unset; the tests never use that client, but the
// warning fires on every run and reads like a failure.
process.env.DATABASE_URL ??= 'postgresql://tests:tests@127.0.0.1:1/tests'
