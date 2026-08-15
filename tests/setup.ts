/**
 * Jest runs suites in parallel workers; every suite constructs real Loggers
 * whose file sink would race on the same temp-dir file. Disable the sink
 * globally — logger.test.ts opts back in explicitly per test.
 */
process.env.GIT_GRAPH_FILE_LOG = '0';
