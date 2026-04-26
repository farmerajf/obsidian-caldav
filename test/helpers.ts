import pino from "pino";

/** Silent logger so test output stays clean. */
export const silentLogger = pino({ level: "silent" });
