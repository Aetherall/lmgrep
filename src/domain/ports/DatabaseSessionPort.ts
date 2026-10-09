/**
 * The lifecycle of an open database connection.
 *
 * Closing matters: a LanceDB connection holds a native runtime and its decode
 * buffers, so a CLI process that forgets to close one keeps that memory until
 * it exits.
 */
export interface DatabaseSessionPort {
	close(): void;
	/**
	 * Move every open table to its latest committed version. Reads otherwise
	 * lag other processes' writes by up to the read consistency interval,
	 * which a writer cannot afford: under the write lock it must see every
	 * row already stored, or it stores them again.
	 */
	checkoutLatest(): Promise<void>;
}
