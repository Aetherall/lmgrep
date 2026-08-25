/**
 * The lifecycle of an open database connection.
 *
 * Closing matters: a LanceDB connection holds a native runtime and its decode
 * buffers, so a CLI process that forgets to close one keeps that memory until
 * it exits.
 */
export interface DatabaseSessionPort {
	close(): void;
}
