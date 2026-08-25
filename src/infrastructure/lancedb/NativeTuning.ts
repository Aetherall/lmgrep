// Set before any native module (LanceDB, libuv) initializes its thread pool.
// This module is imported first by entry points to ensure the env is in
// place before downstream imports load native bindings.
process.env.TOKIO_WORKER_THREADS ??= "4";
process.env.UV_THREADPOOL_SIZE ??= "4";
process.env.RAYON_NUM_THREADS ??= "4";
process.env.MATMUL_NUM_THREADS ??= "4";
