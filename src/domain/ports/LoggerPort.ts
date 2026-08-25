/** Where progress and problems are reported. */
export interface LoggerPort {
	info(message: string): void;
	error(message: string): void;
}
